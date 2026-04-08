require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const path = require('path');
const fs = require('fs');
const { load, save, logActivity } = require('./config-store');
const { runBackfill } = require('./backfill');
const { generateStandup } = require('./standup-generator');
const { syncStandupCheckedTodosToBuildLogs } = require('./standup-todo-sync');
const { callAi, normalizeAiConfig, listModels, sanitizeModelForProvider } = require('./ai-provider');

const app = express();
const PORT = parseInt(process.env.PORT || '3001');
const cfg = load();

// Middleware
app.use(express.json());

// ─── Serve dashboard (must be before API routes) ───────────────────────────────
const dashboardPath = path.resolve(__dirname, 'dashboard', 'index.html');
app.use('/dashboard', express.static(path.join(__dirname, 'dashboard')));
app.use('/social-drafts', express.static(path.join(__dirname, 'social-drafts')));

function sendDashboard(res) {
  fs.readFile(dashboardPath, 'utf8', (err, html) => {
    if (err) {
      console.error('[Dashboard] Failed to read index.html:', dashboardPath, err.message);
      return res.status(500).send('Dashboard file is missing or unreadable.');
    }
    return res.type('html').send(html);
  });
}

app.get('/', (req, res) => sendDashboard(res));
app.get('/dashboard', (req, res) => sendDashboard(res));

// ─── API: Health ──────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  const freshCfg = load();
  const aiCfg = normalizeAiConfig(freshCfg);
  const aiReady = !!(
    aiCfg.apiKey
  );
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    github: cfg.github?.syncEnabled || false,
    ai: aiReady,
    aiProvider: aiCfg.provider,
    version: '2.0'
  });
});

// ─── API: Config ──────────────────────────────────────────────────────────────
app.get('/api/config', (req, res) => {
  const freshCfg = load();
  const aiCfg = normalizeAiConfig(freshCfg);
  const runtime = { ...(freshCfg._runtime || {}) };
  const runtimeAi = { ...(runtime.ai || {}) };
  delete runtimeAi.groupId;
  delete runtime.minimaxGroupId;
  // Return config (without sensitive keys exposed fully)
  res.json({
    ...freshCfg,
    _runtime: {
      ...runtime,
      ai: {
        ...runtimeAi,
        provider: aiCfg.provider,
        model: aiCfg.model,
        baseUrl: aiCfg.baseUrl,
        temperature: aiCfg.temperature,
        maxTokens: aiCfg.maxTokens,
        apiKey: aiCfg.apiKey ? '***' : ''
      },
      minimaxApiKey: process.env.MINIMAX_API_KEY ? '***' : (freshCfg._runtime?.minimaxApiKey || '')
    }
  });
});

app.post('/api/config', (req, res) => {
  try {
    const updates = req.body;
    const newCfg = load();

    // Deep merge
    if (updates.standup) {
      newCfg.standup = { ...newCfg.standup, ...updates.standup };
    }
    if (updates.github) {
      newCfg.github = { ...newCfg.github, ...updates.github };
    }
    if (updates.notion) {
      newCfg.notion = { ...newCfg.notion, ...updates.notion };
    }
    if (updates.server) {
      newCfg.server = { ...newCfg.server, ...updates.server };
    }
    if (Array.isArray(updates.activityLog)) {
      newCfg.activityLog = updates.activityLog;
    }

    save(newCfg);
    logActivity('config_update', `Config updated: ${Object.keys(updates).join(', ')}`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/config/ai', (req, res) => {
  try {
    const input = req.body || {};
    const newCfg = load();
    newCfg._runtime = newCfg._runtime || {};
    newCfg._runtime.ai = {
      ...(newCfg._runtime.ai || {}),
      provider: input.provider || (newCfg._runtime.ai && newCfg._runtime.ai.provider) || 'minimax',
      model: input.model || (newCfg._runtime.ai && newCfg._runtime.ai.model) || '',
      baseUrl: input.baseUrl || (newCfg._runtime.ai && newCfg._runtime.ai.baseUrl) || '',
      temperature: typeof input.temperature === 'number' ? input.temperature : (newCfg._runtime.ai && newCfg._runtime.ai.temperature) || 0.7,
      maxTokens: typeof input.maxTokens === 'number' ? input.maxTokens : (newCfg._runtime.ai && newCfg._runtime.ai.maxTokens) || 1500,
      apiKey: input.apiKey || (newCfg._runtime.ai && newCfg._runtime.ai.apiKey) || ''
    };
    delete newCfg._runtime.ai.groupId;
    delete newCfg._runtime.minimaxGroupId;

    const p = newCfg._runtime.ai.provider;
    if (p === 'openai' || p === 'anthropic' || p === 'gemini') {
      newCfg._runtime.ai.baseUrl = '';
    }

    const prov = newCfg._runtime.ai.provider;
    const rawModel = newCfg._runtime.ai.model || '';
    newCfg._runtime.ai.model = sanitizeModelForProvider(prov, rawModel);

    save(newCfg);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/ai/models', async (req, res) => {
  const freshCfg = load();
  const aiFromCfg = normalizeAiConfig(freshCfg);
  const input = req.body || {};
  const ai = {
    ...aiFromCfg,
    provider: input.provider || aiFromCfg.provider,
    baseUrl: (input.baseUrl != null ? input.baseUrl : aiFromCfg.baseUrl) || '',
    apiKey: (input.apiKey != null && String(input.apiKey).length > 0) ? input.apiKey : aiFromCfg.apiKey
  };
  try {
    const models = await listModels(ai);
    res.json({ ok: true, models: models || [], error: null });
  } catch (err) {
    const timedOut = err && (err.code === 'ECONNABORTED' || String(err.message || '').indexOf('timeout') !== -1);
    const msg =
      err.response?.data?.error?.message ||
      err.response?.data?.message ||
      (timedOut
        ? 'Request to provider timed out. Check network access to provider API or use OpenAI-compatible with your proxy base URL.'
        : err.message) ||
      'Could not list models';
    res.json({ ok: false, models: [], error: msg });
  }
});

app.get('/api/config/default-prompt', (req, res) => {
  const { DEFAULT_CONFIG } = require('./config-store');
  res.json({ prompt: DEFAULT_CONFIG.standup.prompt });
});

// ─── API: Standup ─────────────────────────────────────────────────────────────
app.post('/api/standup/generate', async (req, res) => {
  try {
    const { force } = req.body;
    const result = await generateStandup({ force: !!force });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/standup/sync-todos', async (req, res) => {
  try {
    const result = await syncStandupCheckedTodosToBuildLogs(load());
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/standup/test-ai', async (req, res) => {
  try {
    const freshCfg = load();
    const text = await callAi(
      freshCfg,
      'Say "Hello from the configured AI provider!" in one sentence.',
      { maxTokens: 100 }
    );
    const aiCfg = normalizeAiConfig(freshCfg);
    res.json({ success: true, provider: aiCfg.provider, response: text });
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.message || err.message });
  }
});

// ─── API: Dashboard Stats ─────────────────────────────────────────────────────
app.get('/api/dashboard/stats', async (req, res) => {
  const { Client } = require('@notionhq/client');
  const notion = new Client({ auth: process.env.NOTION_API_KEY });
  const freshCfg = load();
  const nCfg = freshCfg.notion || {};

  async function countDb(dbId, filter) {
    if (!dbId) return null;
    try {
      let count = 0;
      let cursor;
      do {
        const params = { database_id: dbId, page_size: 100 };
        if (filter) params.filter = filter;
        if (cursor) params.start_cursor = cursor;
        const r = await notion.databases.query(params);
        count += r.results.length;
        cursor = r.has_more ? r.next_cursor : null;
      } while (cursor);
      return count;
    } catch { return null; }
  }

  // Count projects by status
  async function countProjectsByStatus(dbId) {
    if (!dbId) return {};
    try {
      const statusCounts = {};
      let cursor;
      do {
        const params = { database_id: dbId, page_size: 100 };
        if (cursor) params.start_cursor = cursor;
        const r = await notion.databases.query(params);
        for (const page of r.results) {
          // Try common status/stage property names
          const props = page.properties || {};
          const statusProp = props['Status'] || props['Stage'] || props['status'] || props['stage'];
          let statusVal = 'Unknown';
          if (statusProp) {
            if (statusProp.type === 'select' && statusProp.select) {
              statusVal = statusProp.select.name || 'Unknown';
            } else if (statusProp.type === 'status' && statusProp.status) {
              statusVal = statusProp.status.name || 'Unknown';
            }
          }
          statusCounts[statusVal] = (statusCounts[statusVal] || 0) + 1;
        }
        cursor = r.has_more ? r.next_cursor : null;
      } while (cursor);
      return statusCounts;
    } catch { return {}; }
  }

  try {
    const [totalProjects, projectsByStatus, totalBuildLogs, totalIdeas, totalStandups] = await Promise.all([
      countDb(nCfg.projectsDb),
      countProjectsByStatus(nCfg.projectsDb),
      countDb(nCfg.buildLogsDb),
      countDb(nCfg.ideaLogsDb),
      countDb(nCfg.standupDb)
    ]);

    res.json({
      totalProjects,
      projectsByStatus,
      totalBuildLogs,
      totalIdeas,
      totalStandups
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── API: GitHub ─────────────────────────────────────────────────────────────
app.post('/api/github/backfill', async (req, res) => {
  try {
    const result = await runBackfill();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/github/repos', async (req, res) => {
  const { Client } = require('@notionhq/client');
  const { fetchProjectsWithGithubUrl } = require('./notion-project-github');
  const notion = new Client({ auth: process.env.NOTION_API_KEY });
  const fresh = load();

  try {
    const projects = await fetchProjectsWithGithubUrl(notion, fresh.notion.projectsDb);
    const repos = projects.map(p => ({ name: p.name, url: p.repoUrl }));
    res.json({ repos });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Server control ──────────────────────────────────────────────────────────
app.post('/api/server/restart', (req, res) => {
  logActivity('server', 'Server restart requested');
  res.json({ success: true, message: 'Restarting...' });
  setTimeout(() => process.exit(0), 1000);
});

// ─── Schedule daily standup cron ─────────────────────────────────────────────
const standupCron = cfg.standup?.cron || '0 8 * * *';
const standupTz = cfg.standup?.tz || 'Asia/Shanghai';

if (cfg.standup?.enabled !== false) {
  console.log(`[Cron] Standup scheduled: ${standupCron} (${standupTz})`);
  cron.schedule(standupCron, async () => {
    console.log('[Cron] Running daily standup...');
    try {
      if (cfg._runtime?.minimaxApiKey) process.env.MINIMAX_API_KEY = cfg._runtime.minimaxApiKey;
      await generateStandup({ force: false });
      console.log('[Cron] Standup complete');
    } catch (err) {
      console.error('[Cron] Standup error:', err.message);
    }
  }, {
    timezone: standupTz
  });
}

// ─── Standup checked todos → Build Logs (polling) ─────────────────────────────
const syncTodoCron = cfg.standup?.syncCheckedTodosCron;
const syncTodoTz = cfg.standup?.syncCheckedTodosTz || cfg.standup?.tz || 'Asia/Shanghai';
if (syncTodoCron && cfg.standup?.enabled !== false) {
  console.log(`[Cron] Standup todo → Build Log sync: ${syncTodoCron} (${syncTodoTz})`);
  cron.schedule(syncTodoCron, async () => {
    try {
      const r = await syncStandupCheckedTodosToBuildLogs(load());
      if (r.created > 0) {
        logActivity('standup_todo_sync', `Created ${r.created} build log(s) from checked standup todos`);
      }
    } catch (err) {
      console.error('[Cron] Standup todo sync error:', err.message);
    }
  }, {
    timezone: syncTodoTz
  });
}

// ─── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 Build-in-Public Dashboard: http://localhost:${PORT}`);
  console.log(`📊 API Health: http://localhost:${PORT}/api/health`);
  console.log(`📋 Standup: POST http://localhost:${PORT}/api/standup/generate`);
  console.log(`✅ Standup todos → Build Logs: POST http://localhost:${PORT}/api/standup/sync-todos`);
  console.log(`📄 Social draft files: http://localhost:${PORT}/social-drafts/`);
  console.log(`\nOpen http://localhost:${PORT} in your browser for the dashboard\n`);
});
