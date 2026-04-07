/**
 * Fetches Notion page body (child blocks) as plain text for standup context.
 * Database properties are separate; this reads the page content users add below.
 */
const { collectPaginatedAPI } = require('@notionhq/client');

function richTextToPlain(richText) {
  if (!richText || !richText.length) return '';
  return richText.map(function(r) {
    return r.plain_text || '';
  }).join('');
}

function repeatIndent(depth) {
  return depth > 0 ? new Array(depth + 1).join('  ') : '';
}

function blockLines(block) {
  var t = block.type;
  var obj = block[t];
  if (!obj) return [];

  if (t === 'divider') return ['---'];
  if (t === 'child_database' || t === 'child_page') {
    return ['[' + t + ']'];
  }
  if (t === 'table_of_contents' || t === 'breadcrumb' || t === 'column_list' || t === 'column') {
    return [];
  }

  if (t === 'table_row' && obj.cells) {
    var row = obj.cells.map(function(cell) {
      return richTextToPlain(cell);
    }).join(' | ');
    return row.trim() ? [row] : [];
  }

  if (t === 'code' && obj.rich_text) {
    return ['```' + (obj.language || '') + '\n' + richTextToPlain(obj.rich_text) + '\n```'];
  }

  if (obj.rich_text) {
    var text = richTextToPlain(obj.rich_text);
    if ((t === 'paragraph' || t === 'bulleted_list_item') && !text.trim()) return [];
    var prefix = '';
    if (t === 'heading_1') prefix = '# ';
    else if (t === 'heading_2') prefix = '## ';
    else if (t === 'heading_3') prefix = '### ';
    else if (t === 'bulleted_list_item') prefix = '- ';
    else if (t === 'numbered_list_item') prefix = '1. ';
    else if (t === 'to_do') prefix = (obj.checked ? '[x] ' : '[ ] ');
    else if (t === 'quote') prefix = '> ';
    else if (t === 'callout') prefix = '💬 ';
    else if (t === 'toggle') prefix = '▸ ';
    return [prefix + text];
  }

  return [];
}

/**
 * @param {import('@notionhq/client').Client} notion
 * @param {string} pageOrBlockId - Page id or block id (pages are blocks)
 * @param {object} [options]
 * @param {number} [options.maxDepth=8]
 * @param {number} [options.maxBlocks=250] - cap API reads across the tree
 * @param {number} [options.maxChars=6000] - truncate final string
 */
async function fetchPageBodyPlainText(notion, pageOrBlockId, options) {
  options = options || {};
  var maxDepth = options.maxDepth != null ? options.maxDepth : 8;
  var maxBlocks = options.maxBlocks != null ? options.maxBlocks : 250;
  var maxChars = options.maxChars != null ? options.maxChars : 6000;

  var state = { blocksRead: 0, lines: [] };

  async function walk(blockId, depth) {
    if (depth > maxDepth || state.blocksRead >= maxBlocks) return;
    var blocks;
    try {
      blocks = await collectPaginatedAPI(notion.blocks.children.list, { block_id: blockId });
    } catch (err) {
      state.lines.push('[Could not read blocks: ' + (err.message || String(err)) + ']');
      return;
    }
    for (var i = 0; i < blocks.length; i++) {
      if (state.blocksRead >= maxBlocks) break;
      state.blocksRead++;
      var b = blocks[i];
      var lines = blockLines(b);
      var ind = repeatIndent(depth);
      for (var j = 0; j < lines.length; j++) {
        state.lines.push(ind + lines[j]);
      }
      if (b.has_children && depth < maxDepth) {
        await walk(b.id, depth + 1);
      }
    }
  }

  try {
    await walk(pageOrBlockId, 0);
  } catch (err) {
    return '';
  }

  var out = state.lines.join('\n').trim();
  if (out.length > maxChars) {
    out = out.slice(0, maxChars) + '\n… [truncated]';
  }
  return out;
}

module.exports = { fetchPageBodyPlainText, richTextToPlain };
