/**
 * Map GitHub repo URLs to Projects DB pages and link Build Logs (Notion).
 * Repo list for backfill comes from the Projects database **Github** URL field.
 */

const BUILD_LOGS_PROP = 'Build Logs';

/**
 * Canonical form: https://github.com/owner/repo (lowercase, no trailing slash, no .git).
 */
function normalizeGithubRepoUrl(url) {
  if (!url || typeof url !== 'string') return '';
  const raw = url.trim();
  if (!raw) return '';
  try {
    const u = new URL(raw);
    if (!/github\.com$/i.test(u.hostname)) {
      return raw.toLowerCase();
    }
    u.protocol = 'https:';
    u.hostname = 'github.com';
    u.hash = '';
    u.search = '';
    let path = u.pathname.replace(/\/+$/, '');
    if (path.endsWith('.git')) path = path.slice(0, -4);
    const parts = path.split('/').filter(Boolean);
    if (parts.length >= 2) {
      return `https://github.com/${parts[0]}/${parts[1]}`.toLowerCase();
    }
    return `https://github.com${path}`.toLowerCase();
  } catch {
    const m = raw.match(/github\.com\/([^\/]+)\/([^\/\?#]+)/i);
    if (!m) return '';
    const repo = m[2].replace(/\.git$/i, '').replace(/\/$/, '');
    return `https://github.com/${m[1]}/${repo}`.toLowerCase();
  }
}

/**
 * All project rows that have a Github repo URL (used for backfill repo list).
 */
async function fetchProjectsWithGithubUrl(notion, projectsDbId) {
  const out = [];

  async function collect(filter) {
    let cursor = undefined;
    do {
      const query = {
        database_id: projectsDbId,
        page_size: 100,
        start_cursor: cursor
      };
      if (filter) query.filter = filter;
      const resp = await notion.databases.query(query);
      for (const page of resp.results) {
        const repoUrl = page.properties?.Github?.url;
        if (!repoUrl) continue;
        const name = page.properties?.Name?.title?.[0]?.plain_text || 'Untitled';
        out.push({ id: page.id, name, repoUrl });
      }
      cursor = resp.has_more ? resp.next_cursor : undefined;
    } while (cursor);
  }

  try {
    await collect({ property: 'Github', url: { is_not_empty: true } });
  } catch (err) {
    console.warn('[NotionProjectGitHub] Filtered Projects query failed, scanning all rows:', err.message);
    out.length = 0;
    await collect(null);
  }
  return out;
}

/**
 * Find Projects DB page whose Github URL matches repoUrl (after normalization).
 * Uses a filtered query when possible; falls back to scanning all pages if the filter fails.
 */
async function findProjectPageByGithubUrl(notion, projectsDbId, repoUrl) {
  const target = normalizeGithubRepoUrl(repoUrl);
  if (!target) return null;

  async function scan(filter) {
    let cursor = undefined;
    do {
      const query = {
        database_id: projectsDbId,
        page_size: 100,
        start_cursor: cursor
      };
      if (filter) query.filter = filter;
      const resp = await notion.databases.query(query);
      for (const page of resp.results) {
        const u = page.properties?.Github?.url;
        if (u && normalizeGithubRepoUrl(u) === target) {
          return page.id;
        }
      }
      cursor = resp.has_more ? resp.next_cursor : undefined;
    } while (cursor);
    return null;
  }

  try {
    const hit = await scan({ property: 'Github', url: { is_not_empty: true } });
    if (hit) return hit;
  } catch (err) {
    console.warn('[NotionProjectGitHub] Filtered Projects query failed:', err.message);
  }
  try {
    return await scan(null);
  } catch (err) {
    console.warn('[NotionProjectGitHub] Projects scan failed:', err.message);
    return null;
  }
}

/**
 * Add buildLogPageId to project's Build Logs relation without dropping existing links.
 */
async function appendBuildLogToProject(notion, projectPageId, buildLogPageId) {
  if (!projectPageId || !buildLogPageId) return;

  let page;
  try {
    page = await notion.pages.retrieve({ page_id: projectPageId });
  } catch (err) {
    console.warn('[NotionProjectGitHub] Could not read project page:', err.message);
    return;
  }

  const relProp = page.properties?.[BUILD_LOGS_PROP];
  const existing = (relProp && relProp.type === 'relation' && relProp.relation) || [];
  const ids = new Set(existing.map(r => r.id));
  if (ids.has(buildLogPageId)) return;

  ids.add(buildLogPageId);
  const relation = Array.from(ids).map(id => ({ id }));

  try {
    await notion.pages.update({
      page_id: projectPageId,
      properties: {
        [BUILD_LOGS_PROP]: { relation }
      }
    });
  } catch (err) {
    console.warn('[NotionProjectGitHub] Could not link Build Log to project:', err.message);
  }
}

const NOTION_RICH_TEXT_MAX = 2000;

/**
 * Build Log **Detail** body: full commit message(s), optional file list (GitHub backfill / webhook).
 */
function formatGithubCommitDetailForNotion(fullMessage, filesChanged) {
  const msg = (fullMessage || '').trim();
  let body = msg;
  if (filesChanged && filesChanged.trim()) {
    body += '\n\n—\nFiles:\n' + filesChanged.trim();
  }
  if (body.length <= NOTION_RICH_TEXT_MAX) return body;
  return body.slice(0, NOTION_RICH_TEXT_MAX - 3) + '...';
}

module.exports = {
  normalizeGithubRepoUrl,
  fetchProjectsWithGithubUrl,
  findProjectPageByGithubUrl,
  appendBuildLogToProject,
  formatGithubCommitDetailForNotion
};
