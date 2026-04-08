/**
 * backfill.js
 * Scans GitHub repos listed on each Projects DB row (Github URL), fetches recent
 * build-in-public activity, and creates Build Log entries for anything not logged yet.
 *
 * Activity sources:
 * - commits
 * - pull requests (created/updated/merged in window)
 * - issues (created/updated/closed in window)
 * - releases (published in window)
 */
require('dotenv').config();
const { Client } = require('@notionhq/client');
const axios = require('axios');
const { load, logActivity } = require('./config-store');
const { socksAxiosOptions } = require('./outbound-http');
const {
  fetchProjectsWithGithubUrl,
  appendBuildLogToProject,
  formatGithubCommitDetailForNotion,
  getBuildLogCategoryFieldMeta,
  applyBuildLogCategoryProperty
} = require('./notion-project-github');
const { summarizeCommitForBuildLogName, classifyBuildLogCategory } = require('./ai-provider');

const notion = new Client({ auth: process.env.NOTION_API_KEY });

const GITHUB_API = 'https://api.github.com';
const DEFAULT_LOOKBACK_DAYS = 7;
const GITHUB_PER_PAGE = 100;
const GITHUB_MAX_PAGES = 30;
const NOTION_PAGE_SIZE = 100;

function githubHeaders() {
  const h = { Accept: 'application/vnd.github.v3+json' };
  const t = process.env.GITHUB_TOKEN;
  if (t) h.Authorization = `Bearer ${t}`;
  return h;
}

function extractRepoAccessError(err) {
  const status = err && err.response && err.response.status;
  if (status === 404 || status === 403) {
    if (process.env.GITHUB_TOKEN) {
      return `GitHub API ${status} for repo (token present but repo may be inaccessible or missing repo read scope)`;
    }
    return `GitHub API ${status} for repo (private repo likely requires GITHUB_TOKEN)`;
  }
  return null;
}

function toIsoDaysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function parseLinkHeader(linkHeader) {
  const out = {};
  if (!linkHeader) return out;
  const parts = String(linkHeader).split(',');
  for (const p of parts) {
    const m = p.trim().match(/^<([^>]+)>;\s*rel="([^"]+)"$/);
    if (m) out[m[2]] = m[1];
  }
  return out;
}

async function githubGetPaged(endpoint, baseParams, options) {
  const opts = options || {};
  const maxPages = opts.maxPages || GITHUB_MAX_PAGES;
  const stopWhen = typeof opts.stopWhen === 'function' ? opts.stopWhen : null;
  const rows = [];
  let page = 1;
  let hasNext = true;

  while (hasNext && page <= maxPages) {
    const resp = await axios.get(
      `${GITHUB_API}${endpoint}`,
      socksAxiosOptions({
        params: {
          ...baseParams,
          per_page: GITHUB_PER_PAGE,
          page
        },
        headers: githubHeaders(),
        timeout: 15000
      })
    );
    const batch = Array.isArray(resp.data) ? resp.data : [];
    rows.push(...batch);
    if (stopWhen && stopWhen(batch) === true) break;
    if (batch.length < GITHUB_PER_PAGE) break;
    const links = parseLinkHeader(resp.headers && resp.headers.link);
    hasNext = !!links.next;
    page++;
  }
  return rows;
}

// Extract owner/repo from a GitHub URL
function parseRepoUrl(url) {
  const match = url && url.match(/github\.com\/([^\/]+)\/([^\/\?#]+)/);
  if (match) return { owner: match[1], repo: match[2] };
  return null;
}

// Fetch commits from GitHub for a repo in the last N days
async function fetchRecentCommits(owner, repo, days) {
  const since = toIsoDaysAgo(days);
  try {
    const rows = await githubGetPaged(
      `/repos/${owner}/${repo}/commits`,
      { since },
      { maxPages: GITHUB_MAX_PAGES }
    );
    return {
      rows: rows.map(c => ({
        sha: c.sha,
        fullMessage: c.commit.message,
        date: c.commit.author.date,
        url: c.html_url,
        author: c.commit.author && c.commit.author.name ? c.commit.author.name : ''
      })),
      error: null
    };
  } catch (err) {
    console.error(`[Backfill] Commits API error for ${owner}/${repo}:`, err.response?.status, err.message);
    return { rows: [], error: extractRepoAccessError(err) || err.message };
  }
}

// Fetch detailed commit info (files changed) for a commit
async function fetchCommitDetails(owner, repo, sha) {
  try {
    const resp = await axios.get(
      `${GITHUB_API}/repos/${owner}/${repo}/commits/${sha}`,
      socksAxiosOptions({
        headers: githubHeaders(),
        timeout: 10000
      })
    );
    const files = resp.data.files || [];
    return {
      files_added: files.filter(f => f.status === 'added').map(f => f.filename),
      files_modified: files.filter(f => f.status === 'modified').map(f => f.filename),
      files_removed: files.filter(f => f.status === 'removed').map(f => f.filename)
    };
  } catch {
    return { files_added: [], files_modified: [], files_removed: [] };
  }
}

async function fetchRecentPullRequests(owner, repo, days) {
  const since = toIsoDaysAgo(days);
  try {
    const rows = await githubGetPaged(
      `/repos/${owner}/${repo}/pulls`,
      { state: 'all', sort: 'updated', direction: 'desc' },
      {
        maxPages: GITHUB_MAX_PAGES,
        stopWhen: function(batch) {
          if (!batch || batch.length === 0) return true;
          const last = batch[batch.length - 1];
          const t = last && last.updated_at ? new Date(last.updated_at) : null;
          return !!(t && t < new Date(since));
        }
      }
    );
    return {
      rows: rows
        .filter(function(pr) {
          if (!pr) return false;
          const times = [pr.created_at, pr.updated_at, pr.merged_at, pr.closed_at].filter(Boolean);
          return times.some(function(ts) { return new Date(ts) >= new Date(since); });
        })
        .map(function(pr) {
          return {
            id: pr.id,
            number: pr.number,
            title: pr.title || '',
            body: pr.body || '',
            state: pr.state || '',
            merged: !!pr.merged_at,
            author: pr.user && pr.user.login ? pr.user.login : '',
            url: pr.html_url,
            date: pr.merged_at || pr.updated_at || pr.created_at
          };
        }),
      error: null
    };
  } catch (err) {
    console.error(`[Backfill] PR API error for ${owner}/${repo}:`, err.response?.status, err.message);
    return { rows: [], error: extractRepoAccessError(err) || err.message };
  }
}

async function fetchRecentIssues(owner, repo, days) {
  const since = toIsoDaysAgo(days);
  try {
    const rows = await githubGetPaged(
      `/repos/${owner}/${repo}/issues`,
      { state: 'all', sort: 'updated', direction: 'desc', since },
      { maxPages: GITHUB_MAX_PAGES }
    );
    return {
      rows: rows
        .filter(function(issue) {
          if (!issue || issue.pull_request) return false;
          const times = [issue.created_at, issue.updated_at, issue.closed_at].filter(Boolean);
          return times.some(function(ts) { return new Date(ts) >= new Date(since); });
        })
        .map(function(issue) {
          return {
            id: issue.id,
            number: issue.number,
            title: issue.title || '',
            body: issue.body || '',
            state: issue.state || '',
            author: issue.user && issue.user.login ? issue.user.login : '',
            url: issue.html_url,
            date: issue.closed_at || issue.updated_at || issue.created_at
          };
        }),
      error: null
    };
  } catch (err) {
    console.error(`[Backfill] Issues API error for ${owner}/${repo}:`, err.response?.status, err.message);
    return { rows: [], error: extractRepoAccessError(err) || err.message };
  }
}

async function fetchRecentReleases(owner, repo, days) {
  const since = toIsoDaysAgo(days);
  try {
    const rows = await githubGetPaged(
      `/repos/${owner}/${repo}/releases`,
      {},
      {
        maxPages: GITHUB_MAX_PAGES,
        stopWhen: function(batch) {
          if (!batch || batch.length === 0) return true;
          const last = batch[batch.length - 1];
          const t = last && (last.published_at || last.created_at) ? new Date(last.published_at || last.created_at) : null;
          return !!(t && t < new Date(since));
        }
      }
    );
    return {
      rows: rows
        .filter(function(release) {
          const ts = release && (release.published_at || release.created_at);
          return !!(ts && new Date(ts) >= new Date(since));
        })
        .map(function(release) {
          return {
            id: release.id,
            tagName: release.tag_name || '',
            name: release.name || '',
            body: release.body || '',
            draft: !!release.draft,
            prerelease: !!release.prerelease,
            url: release.html_url,
            date: release.published_at || release.created_at
          };
        }),
      error: null
    };
  } catch (err) {
    console.error(`[Backfill] Releases API error for ${owner}/${repo}:`, err.response?.status, err.message);
    return { rows: [], error: extractRepoAccessError(err) || err.message };
  }
}

// Get existing GitHub activity URLs from Build Logs to avoid duplicates.
async function getExistingBuildLogUrls(buildLogsDbId) {
  try {
    const urls = new Set();
    let cursor = undefined;
    do {
      const resp = await notion.databases.query({
        database_id: buildLogsDbId,
        page_size: NOTION_PAGE_SIZE,
        start_cursor: cursor
      });
      for (const page of resp.results) {
        const url = page.properties?.['Github Push (if any)']?.url;
        if (url) urls.add(url);
      }
      cursor = resp.has_more ? resp.next_cursor : undefined;
    } while (cursor);
    return urls;
  } catch (err) {
    console.error('[Backfill] Error fetching existing build logs:', err.message);
    return new Set();
  }
}

// Create a Build Log entry in Notion
async function createBuildLog(buildLogsDbId, data) {
  const detailText = formatGithubCommitDetailForNotion(data.fullMessage, data.filesChanged || '');
  const properties = {
    Name: { title: [{ text: { content: data.name } }] },
    'Source (Github/Manual)': { select: { name: 'Github' } },
    'Github Push (if any)': { url: data.activityUrl },
    'Build Date': { date: { start: data.date } }
  };

  if (detailText) {
    properties.Detail = { rich_text: [{ text: { content: detailText } }] };
  }

  if (data.categoryFieldMeta && data.categoryName) {
    applyBuildLogCategoryProperty(properties, data.categoryFieldMeta, data.categoryName);
  }

  // Note: Projects is a dual_property - set it from the parent side only
  // (Notion manages the reverse relation automatically)

  return notion.pages.create({
    parent: { database_id: buildLogsDbId },
    properties
  });
}

// Main backfill function
async function runBackfill() {
  const cfg = load();
  const { notion: notionCfg } = cfg;
  const projectsDb = notionCfg.projectsDb;
  const buildLogsDb = notionCfg.buildLogsDb;
  const lookbackDays = DEFAULT_LOOKBACK_DAYS;

  console.log('[Backfill] Starting GitHub → Notion backfill...');

  let projects = [];
  try {
    projects = await fetchProjectsWithGithubUrl(notion, projectsDb);
  } catch (err) {
    console.error('[Backfill] Failed to query Projects DB:', err.message);
    return { success: false, error: err.message };
  }

  if (projects.length === 0) {
    console.log('[Backfill] No projects with a Github URL — add repo links to the **Github** field in your Projects database.');
    return { success: true, repos: 0, created: 0 };
  }

  // Step 2: Get existing GitHub activity URLs to avoid duplicates
  const existingUrls = await getExistingBuildLogUrls(buildLogsDb);
  console.log(`[Backfill] ${existingUrls.size} existing build log entries`);

  const categoryMeta = await getBuildLogCategoryFieldMeta(notion, buildLogsDb);
  if (categoryMeta) {
    console.log(`[Backfill] Category field: ${categoryMeta.type} (${categoryMeta.options.length} options)`);
  }

  // Step 3: For each repo, fetch activity and create missing entries
  let totalCreated = 0;
  const repoResults = [];

  for (const { id: projectId, name: projectName, repoUrl } of projects) {
    const parsed = parseRepoUrl(repoUrl);
    if (!parsed) {
      console.warn(`[Backfill] Invalid repo URL on project "${projectName}": ${repoUrl}`);
      continue;
    }

    console.log(`\n[Backfill] Processing ${parsed.owner}/${parsed.repo} (${projectName})...`);
    const commitsRes = await fetchRecentCommits(parsed.owner, parsed.repo, lookbackDays);
    const prsRes = await fetchRecentPullRequests(parsed.owner, parsed.repo, lookbackDays);
    const issuesRes = await fetchRecentIssues(parsed.owner, parsed.repo, lookbackDays);
    const releasesRes = await fetchRecentReleases(parsed.owner, parsed.repo, lookbackDays);

    const commits = commitsRes.rows || [];
    const prs = prsRes.rows || [];
    const issues = issuesRes.rows || [];
    const releases = releasesRes.rows || [];
    const apiErrors = [
      commitsRes.error,
      prsRes.error,
      issuesRes.error,
      releasesRes.error
    ].filter(Boolean);

    console.log(
      `[Backfill] Found ${commits.length} commits, ${prs.length} PRs, ${issues.length} issues, ${releases.length} releases in last ${lookbackDays} days`
    );

    const activityRows = [];
    for (const c of commits) {
      activityRows.push({
        type: 'commit',
        key: c.sha,
        activityUrl: c.url,
        date: c.date,
        fullMessage: c.fullMessage,
        meta: c
      });
    }
    for (const pr of prs) {
      const state = pr.merged ? 'merged' : pr.state;
      activityRows.push({
        type: 'pull_request',
        key: String(pr.number),
        activityUrl: pr.url,
        date: pr.date,
        fullMessage: `PR #${pr.number} (${state}) by ${pr.author}\n\n${pr.title}\n\n${pr.body || ''}`.trim(),
        meta: pr
      });
    }
    for (const issue of issues) {
      activityRows.push({
        type: 'issue',
        key: String(issue.number),
        activityUrl: issue.url,
        date: issue.date,
        fullMessage: `Issue #${issue.number} (${issue.state}) by ${issue.author}\n\n${issue.title}\n\n${issue.body || ''}`.trim(),
        meta: issue
      });
    }
    for (const release of releases) {
      const releaseState = release.prerelease ? 'prerelease' : 'release';
      activityRows.push({
        type: 'release',
        key: String(release.id),
        activityUrl: release.url,
        date: release.date,
        fullMessage: `${releaseState}: ${release.name || release.tagName}\nTag: ${release.tagName}\n\n${release.body || ''}`.trim(),
        meta: release
      });
    }
    activityRows.sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0));

    if (activityRows.length === 0) {
      repoResults.push({
        repo: `${parsed.owner}/${parsed.repo}`,
        commits: 0,
        pullRequests: 0,
        issues: 0,
        releases: 0,
        created: 0,
        warnings: apiErrors
      });
      continue;
    }

    let repoCreated = 0;
    for (const item of activityRows) {
      if (!item.activityUrl) continue;
      if (existingUrls.has(item.activityUrl)) {
        console.log(`[Backfill]   Skipping ${item.type}:${item.key} — already exists`);
        continue;
      }

      let filesChanged = '';
      if (item.type === 'commit') {
        const details = await fetchCommitDetails(parsed.owner, parsed.repo, item.meta.sha);
        filesChanged = [
          ...details.files_added.map(f => `+ ${f}`),
          ...details.files_modified.map(f => `~ ${f}`),
          ...details.files_removed.map(f => `- ${f}`)
        ].join('\n');
      }

      try {
        const [name, categoryName] = await Promise.all([
          summarizeCommitForBuildLogName(cfg, item.fullMessage, filesChanged),
          categoryMeta
            ? classifyBuildLogCategory(cfg, item.fullMessage, filesChanged, categoryMeta)
            : Promise.resolve(null)
        ]);
        const newPage = await createBuildLog(buildLogsDb, {
          name,
          fullMessage: item.fullMessage,
          activityUrl: item.activityUrl,
          date: item.date,
          filesChanged,
          categoryFieldMeta: categoryMeta,
          categoryName
        });
        await appendBuildLogToProject(notion, projectId, newPage.id);
        existingUrls.add(item.activityUrl);
        repoCreated++;
        totalCreated++;
        console.log(`[Backfill]   ✅ Created ${item.type}: ${name}`);
      } catch (err) {
        console.error(`[Backfill]   ❌ Failed: ${err.message}`);
      }

      await new Promise(r => setTimeout(r, 100));
    }

    repoResults.push({
      repo: `${parsed.owner}/${parsed.repo}`,
      commits: commits.length,
      pullRequests: prs.length,
      issues: issues.length,
      releases: releases.length,
      warnings: apiErrors,
      created: repoCreated
    });
  }

  const summary = { success: true, repos: repoResults, totalCreated };
  logActivity(
    'backfill',
    `${totalCreated} build log entries created across ${repoResults.filter(r => r.created > 0).length} repos`
  );

  console.log('\n[Backfill] ✅ Done!');
  console.log(`   Repos processed: ${repoResults.length}`);
  console.log(`   Entries created: ${totalCreated}`);

  return summary;
}

// Run directly if called from CLI
if (require.main === module) {
  runBackfill()
    .then(r => { console.log(r); process.exit(0); })
    .catch(e => { console.error(e); process.exit(1); });
}

module.exports = { runBackfill };
