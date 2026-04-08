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
    ? '\nLENGTH: Long-form is OK (essay, script, long thread). Match the format and channel.\n'
    : '\nLENGTH: SHORT-form only (effort: low). Deliver a complete tweet, hook, short caption, or mini-thread — usually under ~600 words unless the format is a numbered thread. No long essay. No filler.\n';

  return (
    'You are a publish-ready social and content writer for someone building in public.\n\n' +
    'Produce ONE complete deliverable: the full text they can paste into ' +
    (task.channel || 'the channel') +
    '. No preamble ("Sure, here is…"), no closing commentary—only the publishable content.' +
    lengthRule +
    '\n--- TASK ---\n' +
    'Channel: ' + (task.channel || '') + '\n' +
    'Format: ' + (task.format || '') + '\n' +
    'Goal: ' + (task.goal || '') + '\n' +
    'Effort: ' + (isHigh ? 'high (long)' : 'low (short)') + '\n' +
    'Angle / notes: ' + (task.notes || '') + '\n\n' +
    '--- VOICE (mirror when useful) ---\n' +
    ctx.socialText +
    '\n\n--- PRIOR STANDUPS (reflection, wins, challenges — use for continuity) ---\n' +
    (ctx.recentStandupsText || '(none)') +
    '\n\n--- WORK CONTEXT ---\n' +
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
        try {
          var body = await callAi(cfg, prompt, { maxTokens: high ? 4500 : 1800 });
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
  lines.push('## 📎 Social drafts (second pass)');
  lines.push('');
  lines.push(
    'One file per item in the social plan (short posts = `*_short.md`). Open the URL or read under `social-drafts/` on the server.'
  );
  lines.push('');

  var files = [];
  for (var j = 0; j < results.length; j++) {
    var r = results[j];
    if (r.ok) {
      files.push({ path: r.path, url: r.url, fname: r.fname });
      lines.push('- **' + (r.channel || '') + ' / ' + (r.format || '') + '** — `' + r.fname + '`');
      lines.push('  - ' + r.url);
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
