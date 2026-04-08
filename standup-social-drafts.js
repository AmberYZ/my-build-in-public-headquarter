/**
 * Second-pass "agents": full drafts for high-effort social tasks, saved under social-drafts/.
 */
const fs = require('fs');
const path = require('path');
const { callAi, extractAxiosErrorMessage } = require('./ai-provider');

var SOCIAL_JSON_MARKER = '---SOCIAL_PLAN_JSON---';
var DRAFTS_DIR = path.join(__dirname, 'social-drafts');

function ensureDraftsDir() {
  try {
    fs.mkdirSync(DRAFTS_DIR, { recursive: true });
  } catch (e) {}
}

function slugPart(s) {
  var out = String(s || 'draft')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
  return out || 'draft';
}

function publicBaseUrl(cfg) {
  if (process.env.PUBLIC_BASE_URL && String(process.env.PUBLIC_BASE_URL).trim()) {
    return String(process.env.PUBLIC_BASE_URL).trim().replace(/\/$/, '');
  }
  var fromCfg = cfg.server && cfg.server.publicBaseUrl ? String(cfg.server.publicBaseUrl).trim() : '';
  if (fromCfg) return fromCfg.replace(/\/$/, '');
  var port = cfg.server && cfg.server.port ? cfg.server.port : 3001;
  return 'http://localhost:' + port;
}

/**
 * Split main standup markdown from trailing ---SOCIAL_PLAN_JSON--- [...] array.
 */
function parseSocialPlanFromResponse(fullText) {
  var text = fullText || '';
  var idx = text.indexOf(SOCIAL_JSON_MARKER);
  if (idx === -1) {
    return { markdown: text.trim(), tasks: [] };
  }
  var markdown = text.slice(0, idx).trim();
  var jsonPart = text.slice(idx + SOCIAL_JSON_MARKER.length).trim();
  jsonPart = jsonPart.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```\s*$/i, '');
  var tasks = [];
  try {
    var parsed = JSON.parse(jsonPart);
    if (Array.isArray(parsed)) tasks = parsed;
  } catch (e) {
    console.error('[Standup] SOCIAL_PLAN_JSON parse failed:', e.message);
  }
  return { markdown: markdown, tasks: tasks };
}

function buildWriterPrompt(ctx, task, isHigh) {
  var lengthRule = isHigh
    ? '\nLENGTH: Long-form OK (essay, script, thread). Match the channel format.\n'
    : '\nLENGTH: Short-form only — complete tweet, hook, caption, or mini-thread; avoid filler.\n';

  return (
    'You are ghostwriting for ONE specific person. Your only job is to sound exactly like them — not like an AI, not like a LinkedIn creator, not like anyone else.\n\n' +
    'STEP 1 — Read "YOUR PUBLISHED CONTENT" completely before writing anything. These are real posts they actually sent. ' +
    'Extract and imitate: sentence length, how casual or formal they are, whether they use fragments, how they open (do they hook aggressively or just start talking?), ' +
    'emoji frequency and placement, line break rhythm, how much they explain vs assume, whether they hedge or state directly, ' +
    'their humor style, how personal they get. If their posts are short and punchy, yours must be too. If they ramble a bit, yours can too.\n\n' +
    'STEP 2 — Banned patterns (these make it sound AI-written, avoid them completely):\n' +
    '- Section headers or subheadings inside the post\n' +
    '- Bullet point lists (unless their real posts use them frequently)\n' +
    '- Phrases like "game-changer", "dive deep", "unlock", "leverage", "it\'s not just about X, it\'s about Y", "in today\'s world"\n' +
    '- Motivational sign-offs like "go build something" or "what are you waiting for"\n' +
    '- Overly structured "hook → story → CTA" format unless their actual posts use it\n' +
    '- Starting with a rhetorical question unless they do that themselves\n\n' +
    'STEP 3 — Write ONE paste-ready piece for ' +
    (task.channel || 'the channel') +
    '. No preamble, no meta-commentary, no "here\'s your draft" — just the post itself.' +
    lengthRule +
    '\n--- YOUR PUBLISHED CONTENT (the only voice that matters) ---\n' +
    ctx.socialText +
    '\n\n--- TASK ---\n' +
    'Channel: ' +
    (task.channel || '') +
    '\n' +
    'Format: ' +
    (task.format || '') +
    '\n' +
    'Goal: ' +
    (task.goal || '') +
    '\n' +
    'Effort: ' +
    (isHigh ? 'high (long)' : 'low (short)') +
    '\n' +
    'Angle / notes: ' +
    (task.notes || '') +
    '\n\n' +
    '--- PRIOR STANDUPS (context only — do not let this override voice) ---\n' +
    (ctx.recentStandupsText || '(none)') +
    '\n\n--- WORK CONTEXT (facts to draw from) ---\n' +
    'Build logs:\n' +
    ctx.buildLogsText +
    '\n\nIdeas (IDEA_COUNT=' +
    (ctx.ideaCount != null ? ctx.ideaCount : '?') +
    '):\n' +
    ctx.ideaLogsText +
    '\n\nProjects:\n' +
    ctx.projectsText +
    '\n\nIdea type preferences: ' +
    ctx.ideaTypesStr +
    '\nBlocker: ' +
    ctx.blockerText +
    '\n'
  );
}

function isHighEffort(task) {
  if (!task) return false;
  return String(task.effort || '').toLowerCase() === 'high';
}

/**
 * Run one AI call per social plan item (parallel): long drafts for high effort, short for low.
 * Writes markdown files under social-drafts/ and returns appendix + file list.
 */
async function runSocialDraftAgents(cfg, dateStr, tasks, ctxBundle) {
  ensureDraftsDir();
  var base = publicBaseUrl(cfg);
  var draftList = [];
  for (var i = 0; i < (tasks || []).length; i++) {
    draftList.push({ task: tasks[i], order: i + 1 });
  }

  if (draftList.length === 0) {
    return { appendixMarkdown: '', files: [] };
  }

  var highCount = draftList.filter(function(e) {
    return isHighEffort(e.task);
  }).length;
  console.log(
    '[Standup] Social draft agents: ' +
      draftList.length +
      ' item(s) (' +
      highCount +
      ' high-effort, ' +
      (draftList.length - highCount) +
      ' short)…'
  );

  var results = await Promise.all(
    draftList.map(function(entry) {
      return (async function() {
        var t = entry.task;
        var n = entry.order;
        var high = isHighEffort(t);
        var fname =
          dateStr +
          '_' +
          String(n).padStart(2, '0') +
          '_' +
          slugPart(t.channel) +
          '_' +
          slugPart(t.format) +
          (high ? '' : '_short') +
          '.md';
        var fpath = path.join(DRAFTS_DIR, fname);
        var prompt = buildWriterPrompt(ctxBundle, t, high);
        var draftTemp =
          cfg.standup && typeof cfg.standup.socialDraftTemperature === 'number'
            ? cfg.standup.socialDraftTemperature
            : 0.55;
        try {
          var body = await callAi(cfg, prompt, {
            maxTokens: high ? 4500 : 1800,
            temperature: draftTemp
          });
          body = (body || '').trim();
          fs.writeFileSync(fpath, body, 'utf8');
          var url = base + '/social-drafts/' + encodeURIComponent(fname);
          return {
            ok: true,
            fname: fname,
            path: fpath,
            url: url,
            channel: t.channel,
            format: t.format
          };
        } catch (err) {
          var msg = extractAxiosErrorMessage(err);
          console.error('[Standup] Draft agent failed (' + fname + '):', msg);
          return { ok: false, error: msg, channel: t.channel, format: t.format };
        }
      })();
    })
  );

  var lines = [];
  lines.push('');
  lines.push('## Social drafts');
  lines.push('');
  lines.push('One link per planned post (short-form files end with _short). Click the URL to open.');
  lines.push('');

  var files = [];
  for (var j = 0; j < results.length; j++) {
    var r = results[j];
    if (r.ok) {
      files.push({ path: r.path, url: r.url, fname: r.fname });
      lines.push(
        '- **' +
          (r.channel || '') +
          ' / ' +
          (r.format || '') +
          '** — ' +
          r.url +
          ' (' +
          r.fname +
          ')'
      );
      lines.push('');
    } else {
      lines.push('- **' + (r.channel || '') + '** — generation failed: ' + r.error);
      lines.push('');
    }
  }

  return { appendixMarkdown: lines.join('\n'), files: files };
}

module.exports = {
  parseSocialPlanFromResponse: parseSocialPlanFromResponse,
  runSocialDraftAgents: runSocialDraftAgents,
  SOCIAL_JSON_MARKER: SOCIAL_JSON_MARKER
};
