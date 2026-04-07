/**
 * When a to-do block is checked on a standup Notion page, create a Build Log row (Manual).
 * Runs on a cron; dedupes by Notion block id so each checkbox only logs once.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('@notionhq/client');
const { collectPaginatedAPI } = require('@notionhq/client');
const { load } = require('./config-store');

const notion = new Client({ auth: process.env.NOTION_API_KEY });
const STATE_PATH = path.join(__dirname, 'standup-synced-todo-blocks.json');

function loadSyncedBlockIds() {
  try {
    if (fs.existsSync(STATE_PATH)) {
      var j = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
      return new Set(Array.isArray(j.blockIds) ? j.blockIds : []);
    }
  } catch (e) {
    console.error('[StandupTodoSync] State read error:', e.message);
  }
  return new Set();
}

function saveSyncedBlockIds(set) {
  var arr = Array.from(set);
  if (arr.length > 8000) {
    arr = arr.slice(-8000);
  }
  fs.writeFileSync(STATE_PATH, JSON.stringify({ blockIds: arr }, null, 2));
}

function richTextToPlain(richText) {
  if (!richText || !richText.length) return '';
  return richText.map(function(r) {
    return r.plain_text || '';
  }).join('');
}

function notionPageUrl(pageId) {
  return 'https://www.notion.so/' + String(pageId).replace(/-/g, '');
}

async function walkBlockTree(blockId, visit) {
  var blocks = await collectPaginatedAPI(notion.blocks.children.list, { block_id: blockId });
  for (var i = 0; i < blocks.length; i++) {
    var b = blocks[i];
    await visit(b);
    if (b.has_children) {
      await walkBlockTree(b.id, visit);
    }
  }
}

function truncateTitle(s, maxLen) {
  maxLen = maxLen || 1900;
  s = String(s || '').trim();
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 1) + '…';
}

async function createBuildLogFromTodo(cfg, taskText, standupPageId, blockId) {
  var pageUrl = notionPageUrl(standupPageId);
  var detail =
    'Completed from standup page:\n' +
    pageUrl +
    '\n\nTo-do block id: ' +
    blockId +
    '\n\n' +
    taskText;

  var props = {
    Name: { title: [{ text: { content: truncateTitle('Done: ' + taskText) } }] },
    'Source (Github/Manual)': { select: { name: 'Manual' } },
    Detail: { rich_text: [{ text: { content: detail } }] },
    'Build Date': { date: { start: new Date().toISOString().split('T')[0] } }
  };

  return notion.pages.create({
    parent: { database_id: cfg.notion.buildLogsDb },
    properties: props
  });
}

/**
 * Scan recent standup pages for checked to_do blocks; create Build Log entries once per block id.
 */
async function syncStandupCheckedTodosToBuildLogs(cfg) {
  cfg = cfg || load();
  if (!cfg.notion || !cfg.notion.buildLogsDb || !cfg.notion.standupDb) {
    return { success: false, reason: 'missing_config', created: 0 };
  }

  var synced = loadSyncedBlockIds();
  var created = 0;
  var errors = [];

  var resp;
  try {
    resp = await notion.databases.query({
      database_id: cfg.notion.standupDb,
      sorts: [{ timestamp: 'created_time', direction: 'descending' }],
      page_size: 100
    });
  } catch (err) {
    console.error('[StandupTodoSync] Query standup DB:', err.message);
    return { success: false, reason: 'query_failed', error: err.message, created: 0 };
  }

  var pages = resp.results || [];
  for (var p = 0; p < pages.length; p++) {
    var page = pages[p];
    var pageId = page.id;

    try {
      await walkBlockTree(pageId, async function(block) {
        if (block.type !== 'to_do' || !block.to_do || !block.to_do.checked) return;
        if (synced.has(block.id)) return;

        var text = richTextToPlain(block.to_do.rich_text).trim();
        if (!text) {
          synced.add(block.id);
          return;
        }

        try {
          await createBuildLogFromTodo(cfg, text, pageId, block.id);
          synced.add(block.id);
          created++;
          console.log('[StandupTodoSync] Build Log from checked todo: ' + text.slice(0, 80));
        } catch (err) {
          errors.push({ blockId: block.id, message: err.message });
          console.error('[StandupTodoSync] Build Log create failed:', err.message);
        }
      });
    } catch (err) {
      console.error('[StandupTodoSync] Walk page ' + pageId + ':', err.message);
    }
  }

  saveSyncedBlockIds(synced);

  return {
    success: errors.length === 0,
    created: created,
    errors: errors.length ? errors : undefined
  };
}

module.exports = { syncStandupCheckedTodosToBuildLogs };
