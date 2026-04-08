/**
 * standup-generator.js
 * Generates a daily standup as a new row in a Notion database with AI-generated:
 * - TODO list (across all project lifecycle stages)
 * - Ideas to explore
 * - Things to learn
 * - Social media drafts
 */
require('dotenv').config();
const { Client } = require('@notionhq/client');
const { load, logActivity } = require('./config-store');
const { callAi, normalizeAiConfig, extractAxiosErrorMessage } = require('./ai-provider');
const { fetchPageBodyPlainText } = require('./notion-page-body');
const { parseSocialPlanFromResponse, runSocialDraftAgents } = require('./standup-social-drafts');

const notion = new Client({ auth: process.env.NOTION_API_KEY });

/** Append full page body (Notion blocks under the row) for each database row. */
async function enrichRowsWithPageBodies(rows, bodyOpts) {
  bodyOpts = bodyOpts || {};
  if (!rows || rows.length === 0) return [];
  console.log('[Standup] Loading page content (blocks inside each row) for ' + rows.length + ' page(s)...');
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    if (!row.id) {
      out.push(Object.assign({}, row, { pageBody: '' }));
      continue;
    }
    try {
      var pageBody = await fetchPageBodyPlainText(notion, row.id, bodyOpts);
      out.push(Object.assign({}, row, { pageBody: pageBody }));
    } catch (err) {
      console.error('[Standup] Page body for ' + row.id + ':', err.message);
      out.push(Object.assign({}, row, { pageBody: '' }));
    }
  }
  return out;
}

// Fetch recent Build Logs from Notion
async function fetchRecentBuildLogs(cfg, days) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  try {
    const resp = await notion.databases.query({
      database_id: cfg.notion.buildLogsDb,
      page_size: 100
    });
    const mapped = resp.results
      .filter(function(p) { return new Date(p.created_time) >= since; })
      .sort(function(a, b) { return new Date(b.created_time) - new Date(a.created_time); })
      .map(function(p) {
      return {
        id: p.id,
        name: (p.properties.Name && p.properties.Name.title && p.properties.Name.title[0] ? p.properties.Name.title[0].plain_text : 'Untitled'),
        source: (p.properties['Source (Github/Manual)'] && p.properties['Source (Github/Manual)'].select ? p.properties['Source (Github/Manual)'].select.name : ''),
        detail: (p.properties.Detail && p.properties.Detail.rich_text && p.properties.Detail.rich_text[0] ? p.properties.Detail.rich_text[0].plain_text : ''),
        url: (p.properties['Github Push (if any)'] && p.properties['Github Push (if any)'].url ? p.properties['Github Push (if any)'].url : ''),
        date: p.created_time
      };
    });
    return await enrichRowsWithPageBodies(mapped, { maxChars: 6000, maxBlocks: 250 });
  } catch(err) {
    console.error('[Standup] Build logs fetch error:', err.message);
    return [];
  }
}

/**
 * Idea logs within lookback window (newest first). Paginates until rows are older than `since`
 * so large backlogs (e.g. 12+ ideas) are not truncated at page_size.
 */
async function fetchRecentIdeaLogs(cfg, days) {
  if (days == null && cfg.standup && cfg.standup.ideaLogLookbackDays != null) {
    days = Number(cfg.standup.ideaLogLookbackDays);
  }
  if (days == null || isNaN(days) || days < 1) {
    days = 120;
  }
  var since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  try {
    var rawPages = [];
    var cursor = undefined;
    var stopPaging = false;
    while (!stopPaging) {
      var resp = await notion.databases.query({
        database_id: cfg.notion.ideaLogsDb,
        page_size: 100,
        start_cursor: cursor,
        sorts: [{ timestamp: 'created_time', direction: 'descending' }]
      });
      var batch = resp.results || [];
      for (var i = 0; i < batch.length; i++) {
        var p = batch[i];
        if (new Date(p.created_time) >= since) {
          rawPages.push(p);
        } else {
          stopPaging = true;
          break;
        }
      }
      if (!resp.has_more || stopPaging) {
        break;
      }
      cursor = resp.next_cursor;
    }

    var mapped = rawPages.map(function(p) {
      return {
        id: p.id,
        name: (p.properties.Name && p.properties.Name.title && p.properties.Name.title[0] ? p.properties.Name.title[0].plain_text : 'Untitled'),
        category: (p.properties.Category && p.properties.Category.select ? p.properties.Category.select.name : ''),
        details: (p.properties.Details && p.properties.Details.rich_text && p.properties.Details.rich_text[0] ? p.properties.Details.rich_text[0].plain_text : ''),
        url: (p.properties.URL && p.properties.URL.url ? p.properties.URL.url : ''),
        status: (p.properties.Status && p.properties.Status.select ? p.properties.Status.select.name : ''),
        date: p.created_time
      };
    });
    return await enrichRowsWithPageBodies(mapped, { maxChars: 6000, maxBlocks: 250 });
  } catch(err) {
    console.error('[Standup] Idea logs fetch error:', err.message);
    return [];
  }
}

// Fetch all projects
async function fetchProjects(cfg) {
  try {
    const resp = await notion.databases.query({
      database_id: cfg.notion.projectsDb,
      page_size: 20
    });
    const mapped = resp.results.map(function(p) {
      var cycles = [];
      if (p.properties.Cycles && p.properties.Cycles.multi_select) {
        cycles = p.properties.Cycles.multi_select.map(function(s) { return s.name; });
      }
      return {
        id: p.id,
        name: (p.properties.Name && p.properties.Name.title && p.properties.Name.title[0] ? p.properties.Name.title[0].plain_text : 'Untitled'),
        status: (p.properties.Status && p.properties.Status.select ? p.properties.Status.select.name : ''),
        cycles: cycles,
        github: (p.properties.Github && p.properties.Github.url ? p.properties.Github.url : '')
      };
    });
    return await enrichRowsWithPageBodies(mapped, { maxChars: 8000, maxBlocks: 300 });
  } catch(err) {
    console.error('[Standup] Projects fetch error:', err.message);
    return [];
  }
}

function richTextFromProp(prop) {
  if (!prop || prop.type !== 'rich_text' || !prop.rich_text) return '';
  return prop.rich_text.map(function(r) {
    return r.plain_text || '';
  }).join('');
}

function pageTitleFromProperties(page) {
  var props = page.properties || {};
  for (var k in props) {
    if (props[k].type === 'title' && props[k].title && props[k].title.length) {
      return props[k].title.map(function(t) {
        return t.plain_text || '';
      }).join('');
    }
  }
  return 'Untitled';
}

function pickSocialPlatform(props) {
  var names = ['Platform', 'Channel'];
  for (var i = 0; i < names.length; i++) {
    var p = props[names[i]];
    if (p && p.type === 'select' && p.select && p.select.name) return p.select.name;
  }
  for (var k in props) {
    if (props[k].type === 'select' && props[k].select && props[k].select.name) return props[k].select.name;
  }
  return '';
}

function pickSocialDate(props) {
  var names = ['Date', 'Sent', 'Posted', 'Posted on'];
  for (var i = 0; i < names.length; i++) {
    var p = props[names[i]];
    if (p && p.type === 'date' && p.date && p.date.start) return p.date.start;
  }
  for (var k in props) {
    if (props[k].type === 'date' && props[k].date && props[k].date.start) return props[k].date.start;
  }
  return '';
}

function extractSocialPostBody(props) {
  var preferred = ['Post', 'Content', 'Body', 'Text', 'Caption', 'Draft'];
  for (var i = 0; i < preferred.length; i++) {
    var key = preferred[i];
    if (props[key]) {
      var t = richTextFromProp(props[key]);
      if (t.trim()) return t;
    }
  }
  var longest = '';
  for (var k in props) {
    if (props[k].type === 'rich_text') {
      var t = richTextFromProp(props[k]);
      if (t.length > longest.length) longest = t;
    }
  }
  return longest;
}

// Published posts (optional DB) — used to learn voice for social drafts
async function fetchSentSocialPosts(cfg) {
  var dbId = cfg.notion && cfg.notion.socialMediaDb ? String(cfg.notion.socialMediaDb).trim() : '';
  if (!dbId) return [];

  try {
    var resp = await notion.databases.query({
      database_id: dbId,
      sorts: [{ timestamp: 'created_time', direction: 'descending' }],
      page_size: 35
    });
    var mapped = resp.results.map(function(p) {
      var props = p.properties || {};
      return {
        id: p.id,
        name: pageTitleFromProperties(p),
        platform: pickSocialPlatform(props),
        sentDate: pickSocialDate(props),
        body: extractSocialPostBody(props)
      };
    });
    return await enrichRowsWithPageBodies(mapped, { maxChars: 2500, maxBlocks: 120 });
  } catch (err) {
    console.error('[Standup] Sent social posts fetch error:', err.message);
    return [];
  }
}

/** Prior standup pages (same DB) — full page text for reflection continuity & social angles. */
async function fetchRecentStandupContexts(cfg, excludeDateStr) {
  var dbId = getStandupDbId(cfg);
  if (!dbId) {
    return 'Standup database not configured.';
  }
  try {
    var resp = await notion.databases.query({
      database_id: dbId,
      sorts: [{ timestamp: 'created_time', direction: 'descending' }],
      page_size: 12
    });
    var results = resp.results || [];
    var chunks = [];
    for (var i = 0; i < results.length; i++) {
      var p = results[i];
      var title = pageTitleFromProperties(p);
      if (excludeDateStr && title.indexOf(excludeDateStr) !== -1) {
        continue;
      }
      var body = await fetchPageBodyPlainText(notion, p.id, { maxChars: 4000, maxBlocks: 150 });
      chunks.push('### ' + title + '\n' + body);
      if (chunks.length >= 4) {
        break;
      }
    }
    if (chunks.length === 0) {
      return 'No prior standup pages yet (first run) or only today\'s page exists.';
    }
    return chunks.join('\n\n---\n\n');
  } catch (err) {
    console.error('[Standup] Recent standups context error:', err.message);
    return '';
  }
}

function formatSocialSentForPrompt(rows) {
  if (!rows || rows.length === 0) {
    return 'No entries yet (add a Sent posts database ID in config, or add rows). When the user logs posts they actually published, drafts should still sound human and specific—not generic.';
  }
  return rows.map(function(r) {
    var meta = [];
    if (r.platform) meta.push(r.platform);
    if (r.sentDate) meta.push(r.sentDate);
    var header = meta.length ? ' (' + meta.join(' · ') + ')' : '';
    var text = (r.body && r.body.trim()) ? r.body : '';
    if (!text && r.pageBody && r.pageBody.trim()) text = r.pageBody.trim();
    if (!text) {
      return '- ' + r.name + header + '\n  (add Post/Content text or page body)';
    }
    var oneLine = text.replace(/\s+/g, ' ').trim();
    if (oneLine.length > 900) oneLine = oneLine.slice(0, 897) + '…';
    return '- ' + r.name + header + '\n  "' + oneLine + '"';
  }).join('\n\n');
}

function indentPrefixed(text, prefix) {
  return text.split('\n').map(function(line) {
    return prefix + line;
  }).join('\n');
}

function formatProjectsForPrompt(projects) {
  if (!projects || projects.length === 0) {
    return 'No projects in the database.';
  }
  return projects.map(function(p) {
    var cycles = p.cycles && p.cycles.length ? ' | Cycles: ' + p.cycles.join(', ') : '';
    var gh = p.github ? '\n  GitHub: ' + p.github : '';
    var body = p.pageBody && p.pageBody.trim()
      ? '\n  Page content:\n' + indentPrefixed(p.pageBody, '    ')
      : '';
    return '- ' + p.name + ' — Status: ' + (p.status || '—') + cycles + gh + body;
  }).join('\n\n');
}

/** Shared context strings for main standup prompt and social draft agents. */
function buildStandupContextBundle(cfg, buildLogs, ideaLogs, projects, socialSent, recentStandupsText) {
  var buildLogsText = buildLogs.length === 0
    ? 'No builds logged recently.'
    : buildLogs.map(function(b) {
        var date = b.date ? b.date.split('T')[0] : '';
        var detail = b.detail ? '\n  Properties (Detail): ' + b.detail.split('\n').slice(0, 8).join(', ') : '';
        var body = b.pageBody && b.pageBody.trim()
          ? '\n  Page content:\n' + indentPrefixed(b.pageBody, '    ')
          : '';
        return '[' + date + '] ' + b.name + (b.source ? ' (' + b.source + ')' : '') + detail + body;
      }).join('\n\n');

  var lookbackDays =
    cfg.standup && cfg.standup.ideaLogLookbackDays != null
      ? Number(cfg.standup.ideaLogLookbackDays)
      : 120;
  if (isNaN(lookbackDays) || lookbackDays < 1) lookbackDays = 120;

  var ideaLogsText = ideaLogs.length === 0
    ? 'IDEA_COUNT: 0 — No idea rows in this lookback window. LOOKBACK_DAYS: ' +
      lookbackDays +
      '. If the user has more ideas in Notion that are older than this window, mention that limitation in transparency (they can raise ideaLogLookbackDays in config). Omit "## 📋 Idea backlog review" or keep one line explaining zero rows.'
    : 'IDEA_COUNT: ' +
      ideaLogs.length +
      ' — You must include every one in "## 📋 Idea backlog review (full pass)" with a status line.\n' +
      'LOOKBACK_DAYS: ' +
      lookbackDays +
      ' (idea rows created within this window).\n\n' +
      ideaLogs
        .map(function(i, idx) {
          var cat = i.category || 'General';
          var det = i.details ? '\n  Properties (Details): ' + i.details : '';
          var stat = i.status ? ' (' + i.status + ')' : '';
          var body = i.pageBody && i.pageBody.trim()
            ? '\n  Page content:\n' + indentPrefixed(i.pageBody, '    ')
            : '';
          return '(' + (idx + 1) + '/' + ideaLogs.length + ') [' + cat + '] ' + i.name + det + stat + body;
        })
        .join('\n\n');

  var ideaTypesStr = (cfg.standup.ideaTypes || []).length
    ? (cfg.standup.ideaTypes || []).join(', ')
    : '(none selected — balance across technical, business, and content)';

  var blockerRaw = (cfg.standup && cfg.standup.biggestBlocker) ? String(cfg.standup.biggestBlocker).trim() : '';
  var blockerText = blockerRaw || 'None specified — infer likely friction only from build logs, ideas, and projects; do not invent a fake blocker.';

  var projectsText = formatProjectsForPrompt(projects);

  var socialText = formatSocialSentForPrompt(socialSent || []);

  var recent = recentStandupsText && String(recentStandupsText).trim()
    ? String(recentStandupsText).trim()
    : 'No prior standup pages loaded.';

  return {
    buildLogsText: buildLogsText,
    ideaLogsText: ideaLogsText,
    ideaCount: ideaLogs.length,
    ideaLookbackDays: lookbackDays,
    ideaTypesStr: ideaTypesStr,
    blockerText: blockerText,
    projectsText: projectsText,
    socialText: socialText,
    recentStandupsText: recent
  };
}

// Build the prompt by substituting data into the template
function buildPrompt(cfg, buildLogs, ideaLogs, projects, socialSent, recentStandupsText) {
  var ctx = buildStandupContextBundle(cfg, buildLogs, ideaLogs, projects, socialSent, recentStandupsText);
  var prompt = cfg.standup.prompt
    .replace('{BUILD_LOGS}', ctx.buildLogsText)
    .replace('{IDEA_LOGS}', ctx.ideaLogsText)
    .replace('{IDEA_COUNT}', String(ctx.ideaCount != null ? ctx.ideaCount : 0))
    .replace('{IDEA_LOOKBACK_DAYS}', String(ctx.ideaLookbackDays != null ? ctx.ideaLookbackDays : 120))
    .replace('{IDEA_TYPES}', ctx.ideaTypesStr)
    .replace('{PROJECTS}', ctx.projectsText)
    .replace('{BIGGEST_BLOCKER}', ctx.blockerText)
    .replace('{SOCIAL_SENT_POSTS}', ctx.socialText);

  if (prompt.indexOf('{RECENT_STANDUPS_CONTEXT}') !== -1) {
    prompt = prompt.replace('{RECENT_STANDUPS_CONTEXT}', ctx.recentStandupsText);
  } else {
    prompt +=
      '\n\n📓 PRIOR STANDUPS (full page text — includes past Daily reflection):\n' +
      ctx.recentStandupsText;
  }

  return prompt;
}

var NOTION_BLOCK_BATCH = 100;

function lineToTodoBlock(line) {
  var trimmed = String(line || '').replace(/^\s+/, '');
  var mdTodo = trimmed.match(/^[-*]\s+\[([ xX])\]\s+(.+)$/);
  if (mdTodo) {
    var checkedMd = mdTodo[1].trim().toLowerCase() === 'x';
    return {
      object: 'block',
      type: 'to_do',
      to_do: {
        rich_text: [{ type: 'text', text: { content: mdTodo[2].trim() } }],
        checked: checkedMd
      }
    };
  }
  var plainTodo = trimmed.match(/^\[([ xX])\]\s+(.+)$/);
  if (plainTodo) {
    var checkedPl = plainTodo[1].trim().toLowerCase() === 'x';
    return {
      object: 'block',
      type: 'to_do',
      to_do: {
        rich_text: [{ type: 'text', text: { content: plainTodo[2].trim() } }],
        checked: checkedPl
      }
    };
  }
  return null;
}

var NOTION_RICH_TEXT_MAX = 2000;

/** Split plain text into Notion-safe segments (max 2000 chars each). */
function splitRichTextChunks(s) {
  s = String(s || '');
  var out = [];
  var i = 0;
  while (i < s.length) {
    out.push(s.slice(i, i + NOTION_RICH_TEXT_MAX));
    i += NOTION_RICH_TEXT_MAX;
  }
  return out.length ? out : [''];
}

/**
 * Colored callouts: blue = AI reasoning, yellow = user input / reflection.
 * Long bodies split into sibling callouts (same color) to stay within Notion rich_text limits.
 */
function calloutBlocksFromBody(kind, bodyText) {
  var text = String(bodyText || '').trim();
  if (!text) return [];
  var isYou = kind === 'you';
  var chunks = splitRichTextChunks(text);
  return chunks.map(function(chunk) {
    return {
      object: 'block',
      type: 'callout',
      callout: {
        rich_text: [{ type: 'text', text: { content: chunk } }],
        icon: { emoji: isYou ? '✍️' : '🤖' },
        color: isYou ? 'yellow_background' : 'blue_background'
      }
    };
  });
}

// Parse AI markdown content into Notion blocks (including real to_do checkboxes)
function parseContentToBlocks(content) {
  var lines = content.split('\n');
  var blocks = [];
  var currentParagraph = [];
  var calloutMode = null;
  var calloutBuf = [];

  function flushParagraph() {
    if (currentParagraph.length > 0) {
      blocks.push({ object: 'block', type: 'paragraph', paragraph: { rich_text: currentParagraph } });
      currentParagraph = [];
    }
  }

  function flushCallout() {
    if (!calloutMode) return;
    var body = calloutBuf.join('\n');
    calloutBuf = [];
    var mode = calloutMode;
    calloutMode = null;
    var parts = calloutBlocksFromBody(mode, body);
    for (var pi = 0; pi < parts.length; pi++) {
      blocks.push(parts[pi]);
    }
  }

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];

    if (/^:::ai\s*$/.test(line)) {
      flushParagraph();
      flushCallout();
      calloutMode = 'ai';
      continue;
    }
    if (/^:::you\s*$/.test(line)) {
      flushParagraph();
      flushCallout();
      calloutMode = 'you';
      continue;
    }
    if (/^:::\s*$/.test(line)) {
      flushParagraph();
      flushCallout();
      continue;
    }
    if (calloutMode) {
      calloutBuf.push(line);
      continue;
    }

    // Heading 1
    if (line.charAt(0) === '#' && line.charAt(1) === ' ' && line.charAt(2) !== '#') {
      flushParagraph();
      blocks.push({
        object: 'block',
        type: 'heading_1',
        heading_1: { rich_text: [{ type: 'text', text: { content: line.replace(/^# /, '') } }] }
      });
      continue;
    }

    // Heading 2
    if (line.charAt(0) === '#' && line.charAt(1) === '#' && line.charAt(2) === ' ' && line.charAt(3) !== '#') {
      flushParagraph();
      blocks.push({
        object: 'block',
        type: 'heading_2',
        heading_2: { rich_text: [{ type: 'text', text: { content: line.replace(/^## /, '') } }] }
      });
      continue;
    }

    // Heading 3
    if (line.indexOf('### ') === 0) {
      flushParagraph();
      blocks.push({
        object: 'block',
        type: 'heading_3',
        heading_3: { rich_text: [{ type: 'text', text: { content: line.replace(/^### /, '') } }] }
      });
      continue;
    }

    // Horizontal rule
    if (/^---+\s*$/.test(line.trim())) {
      flushParagraph();
      blocks.push({ object: 'block', type: 'divider', divider: {} });
      continue;
    }

    // Task list → Notion to_do (before generic bullets)
    var todoBlock = lineToTodoBlock(line);
    if (todoBlock) {
      flushParagraph();
      blocks.push(todoBlock);
      continue;
    }

    // Indented sub-bullets (visual hierarchy) — not checkboxes (those handled as todos above)
    var subBullet = line.match(/^(\s{2,})[-*]\s+(.+)$/);
    if (subBullet && !/^\[[ xX]\]/.test(subBullet[2].trim())) {
      flushParagraph();
      blocks.push({
        object: 'block',
        type: 'paragraph',
        paragraph: {
          rich_text: [{ type: 'text', text: { content: '        • ' + subBullet[2].trim() } }]
        }
      });
      continue;
    }

    // Numbered list
    var numItem = line.match(/^(\d+)\.\s+(.+)$/);
    if (numItem) {
      flushParagraph();
      blocks.push({
        object: 'block',
        type: 'numbered_list_item',
        numbered_list_item: { rich_text: [{ type: 'text', text: { content: numItem[2].trim() } }] }
      });
      continue;
    }

    // Bulleted list (not task)
    if (line.match(/^[-*] /)) {
      flushParagraph();
      blocks.push({
        object: 'block',
        type: 'bulleted_list_item',
        bulleted_list_item: { rich_text: [{ type: 'text', text: { content: line.replace(/^[-*] /, '') } }] }
      });
      continue;
    }

    // Empty line
    if (line.trim() === '') {
      flushParagraph();
      continue;
    }

    // Regular text
    currentParagraph.push({ type: 'text', text: { content: line } });
  }

  flushParagraph();
  flushCallout();
  return blocks;
}

/** Notion allows at most 100 blocks per create/append request. */
async function appendBlocksInBatches(notion, pageId, blockList) {
  for (var i = 0; i < blockList.length; i += NOTION_BLOCK_BATCH) {
    var chunk = blockList.slice(i, i + NOTION_BLOCK_BATCH);
    await notion.blocks.children.append({ block_id: pageId, children: chunk });
  }
}

async function createStandupPageWithBlocks(notion, databaseId, properties, childrenBlockList) {
  if (childrenBlockList.length <= NOTION_BLOCK_BATCH) {
    return notion.pages.create({
      parent: { database_id: databaseId },
      properties: properties,
      children: childrenBlockList
    });
  }
  var firstChunk = childrenBlockList.slice(0, NOTION_BLOCK_BATCH);
  var rest = childrenBlockList.slice(NOTION_BLOCK_BATCH);
  var page = await notion.pages.create({
    parent: { database_id: databaseId },
    properties: properties,
    children: firstChunk
  });
  if (rest.length > 0) {
    await appendBlocksInBatches(notion, page.id, rest);
  }
  return page;
}

var TITLE_CACHE = {};
var STANDUP_DATE_PROP_CACHE = {};

function getStandupDbId(cfg) {
  var db = cfg.notion && cfg.notion.standupDb;
  return db && String(db).trim().length > 0 ? String(db).trim() : null;
}

/** Resolve the Notion title property key for a database (e.g. "Name" vs "Title"). */
async function getStandupTitlePropertyKey(databaseId) {
  if (TITLE_CACHE[databaseId]) return TITLE_CACHE[databaseId];
  var db = await notion.databases.retrieve({ database_id: databaseId });
  var props = db.properties || {};
  for (var key in props) {
    if (props[key] && props[key].type === 'title') {
      TITLE_CACHE[databaseId] = key;
      return key;
    }
  }
  throw new Error('Standup database has no title column — add a title property in Notion.');
}

/** First matching date property on the standup DB (prefers "Date"). Returns null if none. */
async function getStandupDatePropertyKey(databaseId) {
  if (Object.prototype.hasOwnProperty.call(STANDUP_DATE_PROP_CACHE, databaseId)) {
    return STANDUP_DATE_PROP_CACHE[databaseId];
  }
  var db = await notion.databases.retrieve({ database_id: databaseId });
  var props = db.properties || {};
  var preferred = ['Date', 'Standup date', 'Day'];
  for (var i = 0; i < preferred.length; i++) {
    var pk = preferred[i];
    if (props[pk] && props[pk].type === 'date') {
      STANDUP_DATE_PROP_CACHE[databaseId] = pk;
      return pk;
    }
  }
  for (var key in props) {
    if (props[key] && props[key].type === 'date') {
      STANDUP_DATE_PROP_CACHE[databaseId] = key;
      return key;
    }
  }
  STANDUP_DATE_PROP_CACHE[databaseId] = null;
  return null;
}

var STANDUP_TITLE_PREFIX = 'Daily Stand-up - ';

// Check if a standup for this date already exists (query by title in the standup database)
async function todaysStandupExists(cfg, dateStr) {
  dateStr = dateStr || new Date().toISOString().split('T')[0];
  var fullTitle = STANDUP_TITLE_PREFIX + dateStr;
  var dbId = getStandupDbId(cfg);
  if (!dbId) return null;
  try {
    var titleKey = await getStandupTitlePropertyKey(dbId);
    var resp = await notion.databases.query({
      database_id: dbId,
      filter: {
        property: titleKey,
        title: { equals: fullTitle }
      },
      page_size: 5
    });
    if (resp.results && resp.results.length > 0) return resp.results[0].id;
    return null;
  } catch (err) {
    console.error('[Standup] Duplicate check failed:', err.message);
    return null;
  }
}

function buildStandupChildren(content) {
  var parsedBlocks = parseContentToBlocks(content);
  return [
    {
      object: 'block',
      type: 'callout',
      callout: {
        rich_text: [
          {
            type: 'text',
            text: {
              content:
                'Blue callouts = AI reasoning & drafts. Yellow = your reflection (answer there). Headings and bullets follow below.'
            }
          }
        ],
        icon: { emoji: '📋' },
        color: 'gray_background'
      }
    },
    {
      object: 'block',
      type: 'divider',
      divider: {}
    }
  ].concat(parsedBlocks);
}

// Create a daily standup as a new row in the standup database
async function createDailyStandupPage(cfg, dateStr, content) {
  var children = buildStandupChildren(content);
  var fullTitle = STANDUP_TITLE_PREFIX + dateStr;
  var dbId = getStandupDbId(cfg);
  if (!dbId) {
    throw new Error('Set notion.standupDb (Notion standup database ID) in config or the dashboard.');
  }
  var titleKey = await getStandupTitlePropertyKey(dbId);
  var props = {};
  props[titleKey] = {
    title: [{ text: { content: fullTitle } }]
  };
  var dateKey = await getStandupDatePropertyKey(dbId);
  if (dateKey) {
    props[dateKey] = { date: { start: dateStr } };
  } else {
    console.log('[Standup] No Date property found on standup database — add a "Date" column in Notion to set it automatically.');
  }
  return createStandupPageWithBlocks(notion, dbId, props, children);
}

// Main: generate a standup
async function generateStandup(opts) {
  opts = opts || {};
  var cfg = load();
  var dateStr = opts.date || new Date().toISOString().split('T')[0];

  console.log('[Standup] Generating for ' + dateStr + '...');

  if (!getStandupDbId(cfg)) {
    return {
      success: false,
      reason: 'config_error',
      error: 'Set notion.standupDb (Notion standup database ID) in config or the dashboard.'
    };
  }

  // Check if already exists
  if (!opts.force) {
    var existing = await todaysStandupExists(cfg, dateStr);
    if (existing) {
      console.log('[Standup] Standup for ' + dateStr + ' already exists: ' + existing);
      return { success: false, reason: 'already_exists', pageId: existing };
    }
  }

  // Fetch context
  console.log('[Standup] Fetching Build Logs...');
  var buildLogs = await fetchRecentBuildLogs(cfg, 7);
  console.log('[Standup] Found ' + buildLogs.length + ' build logs');

  console.log('[Standup] Fetching Idea Logs...');
  var ideaLogs = await fetchRecentIdeaLogs(cfg, null);
  console.log('[Standup] Found ' + ideaLogs.length + ' idea logs (lookback days: ' + (cfg.standup && cfg.standup.ideaLogLookbackDays != null ? cfg.standup.ideaLogLookbackDays : 120) + ')');

  console.log('[Standup] Fetching Projects...');
  var projects = await fetchProjects(cfg);
  console.log('[Standup] Found ' + projects.length + ' projects');

  console.log('[Standup] Fetching sent social posts (voice DB)...');
  var socialSent = await fetchSentSocialPosts(cfg);
  console.log('[Standup] Found ' + socialSent.length + ' sent social posts');

  console.log('[Standup] Fetching recent standups (reflection & continuity)...');
  var recentStandupsText = await fetchRecentStandupContexts(cfg, dateStr);
  console.log('[Standup] Recent standups context length: ' + (recentStandupsText && recentStandupsText.length));

  // Build prompt
  var prompt = buildPrompt(cfg, buildLogs, ideaLogs, projects, socialSent, recentStandupsText);
  var ctxBundle = buildStandupContextBundle(cfg, buildLogs, ideaLogs, projects, socialSent, recentStandupsText);
  var aiCfg = normalizeAiConfig(cfg);
  console.log('[Standup] Calling AI provider: ' + aiCfg.provider + '...');

  // Call AI (standup + social plan JSON)
  var aiContent;
  try {
    aiContent = await callAi(cfg, prompt, { maxTokens: 4500 });
    console.log('[Standup] AI response: ' + aiContent.length + ' chars');
  } catch(err) {
    var errMsg = extractAxiosErrorMessage(err);
    console.error('[Standup] AI call failed:', errMsg);
    logActivity('standup_failed', errMsg);
    return { success: false, reason: 'ai_error', error: errMsg };
  }

  if (!aiContent || aiContent.trim().length < 20) {
    return { success: false, reason: 'empty_response' };
  }

  var parsed = parseSocialPlanFromResponse(aiContent);
  var standupMarkdown = parsed.markdown;
  var draftAppend = '';
  var draftFiles = [];
  if (parsed.tasks && parsed.tasks.length) {
    try {
      var draftRes = await runSocialDraftAgents(cfg, dateStr, parsed.tasks, ctxBundle);
      draftAppend = draftRes.appendixMarkdown || '';
      draftFiles = draftRes.files || [];
    } catch (draftErr) {
      console.error('[Standup] Social draft agents:', draftErr.message);
    }
  }
  var finalContent = standupMarkdown + (draftAppend ? '\n\n' + draftAppend : '');

  // Create page
  console.log('[Standup] Creating Notion page...');
  try {
    var page = await createDailyStandupPage(cfg, dateStr, finalContent);
    var pageUrl = 'https://notion.so/' + page.id.replace(/-/g, '');
    console.log('[Standup] Page created: ' + pageUrl);

    logActivity(
      'standup',
      'Generated for ' +
        dateStr +
        ' - ' +
        buildLogs.length +
        ' builds, ' +
        ideaLogs.length +
        ' ideas, ' +
        projects.length +
        ' projects, ' +
        socialSent.length +
        ' voice samples, ' +
        draftFiles.length +
        ' social draft file(s)'
    );

    return {
      success: true,
      pageId: page.id,
      url: pageUrl,
      date: dateStr,
      buildLogsCount: buildLogs.length,
      ideaLogsCount: ideaLogs.length,
      socialDraftFiles: draftFiles
    };
  } catch(err) {
    console.error('[Standup] Failed to create Notion page:', err.message);
    return { success: false, reason: 'notion_error', error: err.message };
  }
}

// Run directly
if (require.main === module) {
  var opts = {};
  var args = process.argv.slice(2);
  if (args.indexOf('--force') !== -1) opts.force = true;
  for (var i = 0; i < args.length; i++) {
    if (args[i].indexOf('--date=') === 0) {
      opts.date = args[i].replace('--date=', '');
    }
  }

  generateStandup(opts)
    .then(function(r) { console.log(JSON.stringify(r, null, 2)); process.exit(0); })
    .catch(function(e) { console.error(e); process.exit(1); });
}

module.exports = { generateStandup, parseContentToBlocks, buildStandupContextBundle };
