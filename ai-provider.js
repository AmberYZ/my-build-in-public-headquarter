const axios = require('axios');
const { socksAxiosOptions: netOpts } = require('./outbound-http');

const DEFAULT_MODEL_BY_PROVIDER = {
  minimax: 'MiniMax-Text-01',
  openai: 'gpt-4o-mini',
  openai_compatible: 'gpt-4o-mini',
  gemini: 'gemini-1.5-flash',
  anthropic: 'claude-3-5-sonnet-latest'
};

/**
 * If the saved model id belongs to another stack (e.g. MiniMax model with OpenAI provider),
 * fall back to the default for that provider so standup generation does not fail silently.
 */
function sanitizeModelForProvider(provider, model) {
  const def = DEFAULT_MODEL_BY_PROVIDER[provider] || 'gpt-4o-mini';
  const m = (model || '').trim();
  if (!m) return def;

  const lower = m.toLowerCase();

  if (provider === 'openai') {
    if (
      lower.includes('minimax') ||
      lower.includes('abab') ||
      lower.startsWith('claude') ||
      (lower.startsWith('gemini') && !/^gpt/i.test(m))
    ) {
      return def;
    }
  }
  if (provider === 'anthropic') {
    if (lower.startsWith('gpt-') || lower.includes('minimax') || lower.startsWith('gemini')) {
      return def;
    }
  }
  if (provider === 'gemini') {
    if (lower.startsWith('gpt-') || lower.includes('minimax') || lower.startsWith('claude')) {
      return def;
    }
  }

  return m;
}

function extractAxiosErrorMessage(err) {
  if (!err) return 'Unknown error';
  const d = err.response && err.response.data;
  if (d) {
    if (typeof d === 'string') return d;
    if (d.error && typeof d.error === 'object' && d.error.message) return d.error.message;
    if (typeof d.error === 'string') return d.error;
    if (d.message) return d.message;
  }
  return err.message || 'Request failed';
}

function normalizeAiConfig(cfg) {
  const runtime = cfg._runtime || {};
  const ai = runtime.ai || {};

  const provider = ai.provider || 'openai';
  const rawModel = ai.model || DEFAULT_MODEL_BY_PROVIDER[provider] || '';
  const model = sanitizeModelForProvider(provider, rawModel);

  let baseUrl = (ai.baseUrl || '').trim();
  if (provider === 'openai') {
    baseUrl = baseUrl || 'https://api.openai.com/v1';
  } else if (provider === 'minimax') {
    baseUrl = baseUrl || 'https://api.minimaxi.chat/v1';
  }

  let apiKey = process.env.AI_API_KEY || ai.apiKey || '';

  // Backward compatibility with legacy fields.
  const legacyMinimaxKey = process.env.MINIMAX_API_KEY || runtime.minimaxApiKey || '';
  if (!apiKey && provider === 'minimax') apiKey = legacyMinimaxKey;
  if (!apiKey && provider === 'openai') apiKey = process.env.OPENAI_API_KEY || '';
  if (!apiKey && provider === 'anthropic') apiKey = process.env.ANTHROPIC_API_KEY || '';
  if (!apiKey && provider === 'gemini') apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || '';

  return {
    provider,
    model,
    baseUrl,
    apiKey,
    temperature: typeof ai.temperature === 'number' ? ai.temperature : 0.7,
    maxTokens: typeof ai.maxTokens === 'number' ? ai.maxTokens : 1500
  };
}

async function callOpenAiCompatible(ai, prompt, maxTokensOverride) {
  if (!ai.apiKey) throw new Error('API key not configured');
  if (!ai.baseUrl) throw new Error('Base URL not configured for OpenAI-compatible provider');
  if (!ai.model) throw new Error('Model not configured');

  const base = ai.baseUrl.replace(/\/$/, '');
  const resp = await axios.post(
    base + '/chat/completions',
    {
      model: ai.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: ai.temperature,
      max_tokens: maxTokensOverride || ai.maxTokens
    },
    netOpts({
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + ai.apiKey
      },
      timeout: 45000
    })
  );

  return resp.data?.choices?.[0]?.message?.content || '';
}

async function callMiniMax(ai, prompt, maxTokensOverride) {
  // MiniMax can be used through OpenAI-compatible APIs.
  return callOpenAiCompatible(
    {
      ...ai,
      baseUrl: ai.baseUrl || 'https://api.minimaxi.chat/v1'
    },
    prompt,
    maxTokensOverride
  );
}

async function callAnthropic(ai, prompt, maxTokensOverride) {
  if (!ai.apiKey) throw new Error('Anthropic API key not configured');
  if (!ai.model) throw new Error('Anthropic model not configured');

  const resp = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: ai.model,
      max_tokens: maxTokensOverride || ai.maxTokens,
      temperature: typeof ai.temperature === 'number' ? ai.temperature : 0.7,
      messages: [{ role: 'user', content: prompt }]
    },
    netOpts({
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ai.apiKey,
        'anthropic-version': '2023-06-01'
      },
      timeout: 45000
    })
  );

  return resp.data?.content?.[0]?.text || '';
}

async function callGemini(ai, prompt, maxTokensOverride) {
  if (!ai.apiKey) throw new Error('Gemini API key not configured');
  if (!ai.model) throw new Error('Gemini model not configured');

  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
    encodeURIComponent(ai.model) +
    ':generateContent?key=' + encodeURIComponent(ai.apiKey);

  const resp = await axios.post(
    url,
    {
      contents: [
        {
          role: 'user',
          parts: [{ text: prompt }]
        }
      ],
      generationConfig: {
        temperature: ai.temperature,
        maxOutputTokens: maxTokensOverride || ai.maxTokens
      }
    },
    netOpts({
      headers: { 'Content-Type': 'application/json' },
      timeout: 45000
    })
  );

  return resp.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

async function callAi(cfg, prompt, opts) {
  opts = opts || {};
  const aiBase = normalizeAiConfig(cfg);
  const maxTokens = opts.maxTokens ? opts.maxTokens : undefined;
  const temp =
    typeof opts.temperature === 'number' && !isNaN(opts.temperature) ? opts.temperature : null;
  const ai = temp != null ? Object.assign({}, aiBase, { temperature: temp }) : aiBase;
  const provider = ai.provider;

  if (provider === 'minimax') return callMiniMax(ai, prompt, maxTokens);
  if (provider === 'openai') return callOpenAiCompatible(ai, prompt, maxTokens);
  if (provider === 'openai_compatible') return callOpenAiCompatible(ai, prompt, maxTokens);
  if (provider === 'anthropic') return callAnthropic(ai, prompt, maxTokens);
  if (provider === 'gemini') return callGemini(ai, prompt, maxTokens);

  throw new Error('Unsupported AI provider: ' + provider);
}

async function listModels(cfgOrAi) {
  const ai = cfgOrAi.provider ? cfgOrAi : normalizeAiConfig(cfgOrAi);

  if (ai.provider === 'openai') {
    if (!ai.apiKey) throw new Error('API key not configured');
    const base = 'https://api.openai.com/v1';
    const resp = await axios.get(base + '/models', netOpts({
      headers: { Authorization: 'Bearer ' + ai.apiKey },
      timeout: 20000
    }));
    const items = Array.isArray(resp.data?.data) ? resp.data.data : [];
    const ids = items.map(m => m.id).filter(Boolean);
    if (ids.length === 0) throw new Error('OpenAI returned no models (check API key).');
    return ids;
  }

  if (ai.provider === 'openai_compatible' || ai.provider === 'minimax') {
    if (!ai.apiKey) throw new Error('API key not configured');
    if (!ai.baseUrl) throw new Error('Base URL not configured');
    const base = ai.baseUrl.replace(/\/$/, '');
    const resp = await axios.get(base + '/models', netOpts({
      headers: { Authorization: 'Bearer ' + ai.apiKey },
      timeout: 20000
    }));
    const items = Array.isArray(resp.data?.data) ? resp.data.data : [];
    const ids = items.map(m => m.id).filter(Boolean);
    if (ids.length === 0) throw new Error('No models at this base URL (check URL ends with /v1 and your key).');
    return ids;
  }

  if (ai.provider === 'gemini') {
    if (!ai.apiKey) throw new Error('Gemini API key not configured');
    const url = 'https://generativelanguage.googleapis.com/v1beta/models?key=' + encodeURIComponent(ai.apiKey);
    const resp = await axios.get(url, netOpts({ timeout: 20000 }));
    const items = Array.isArray(resp.data?.models) ? resp.data.models : [];
    const ids = items
      .filter(function (m) {
        const methods = m.supportedGenerationMethods || [];
        return methods.length === 0 || methods.indexOf('generateContent') !== -1;
      })
      .map(function (m) {
        return (m.name || '').replace(/^models\//, '');
      })
      .filter(Boolean);
    if (ids.length === 0) throw new Error('Gemini returned no text models (check API key).');
    return ids;
  }

  if (ai.provider === 'anthropic') {
    if (!ai.apiKey) throw new Error('Anthropic API key not configured');
    try {
      const resp = await axios.get('https://api.anthropic.com/v1/models', netOpts({
        headers: {
          'x-api-key': ai.apiKey,
          'anthropic-version': '2023-06-01'
        },
        timeout: 20000
      }));
      const raw = resp.data?.data || resp.data?.models || [];
      const items = Array.isArray(raw) ? raw : [];
      const ids = items.map(function (m) { return m.id || m.name; }).filter(Boolean);
      if (ids.length > 0) return ids;
    } catch (e) {
      throw new Error(e.response?.data?.error?.message || e.message || 'Anthropic models list failed');
    }
    throw new Error('Anthropic returned no models');
  }

  return [];
}

const BUILD_LOG_TITLE_MAX = 80;

/**
 * Short plain-text title for a Build Log row (Notion Name). Uses the configured AI;
 * falls back to the first line of the commit message if no API key or the call fails.
 */
async function summarizeCommitForBuildLogName(cfg, fullCommitMessage, filesChangedText) {
  const msg = (fullCommitMessage || '').trim();
  if (!msg) return 'Git commit';

  const ai = normalizeAiConfig(cfg);
  if (!ai.apiKey) {
    return msg.split('\n')[0].slice(0, BUILD_LOG_TITLE_MAX);
  }

  const filesBlock =
    filesChangedText && filesChangedText.trim()
      ? '\n\nFiles touched:\n' + filesChangedText.trim().slice(0, 1200)
      : '';

  const prompt =
    'Write ONE short title (max 60 characters) for a "build log" row summarizing what this commit accomplished. ' +
    'Plain text only: no quotes, no markdown, no bullet prefix. Be specific about what changed (avoid generic phrases like "Update code" or "Fix bug").\n\n' +
    'Commit message:\n' +
    msg +
    filesBlock;

  try {
    let out = await callAi(cfg, prompt, { maxTokens: 120 });
    out = (out || '').trim().replace(/^["']|["']$/g, '').replace(/\s+/g, ' ');
    if (!out) throw new Error('empty');
    return out.slice(0, BUILD_LOG_TITLE_MAX);
  } catch (e) {
    return msg.split('\n')[0].slice(0, BUILD_LOG_TITLE_MAX);
  }
}

module.exports = {
  normalizeAiConfig,
  callAi,
  listModels,
  extractAxiosErrorMessage,
  sanitizeModelForProvider,
  summarizeCommitForBuildLogName
};
