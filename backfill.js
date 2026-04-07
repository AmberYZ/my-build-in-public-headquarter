/**
 * backfill.js
 * Scans GitHub repos listed on each Projects DB row (Github URL), fetches recent commits (last 7 days),
 * and creates Build Log entries for any commits not already logged.
 */
require('dotenv').config();
const { Client } = require('@notionhq/client');
const axios = require('axios');
const { load, logActivity } = require('./config-store');
const { socksAxiosOptions } = require('./outbound-http');
const { fetchProjectsWithGithubUrl, appendBuildLogToProject } = require('./notion-project-github');

const notion = new Client({ auth: process.env.NOTION_API_KEY });

const GITHUB_API = 'https://api.github.com';

function githubHeaders() {
  const h = { Accept: 'application/vnd.github.v3+json' };
  const t = process.env.GITHUB_TOKEN;
  if (t) h.Authorization = `Bearer ${t}`;
  return h;
}

// Extract owner/repo from a GitHub URL
function parseRepoUrl(url) {
  const match = url && url.match(/github\.com\/([^\/]+)\/([^\/\?#]+)/);
  if (match) return { owner: match[1], repo: match[2] };
  return null;
}

// Fetch commits from GitHub for a repo in the last N days
async function fetchRecentCommits(owner, repo, days = 7) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  try {
    const resp = await axios.get(
      `${GITHUB_API}/repos/${owner}/${repo}/commits`,
      socksAxiosOptions({
        params: { since, per_page: 100 },
        headers: githubHeaders(),
        timeout: 15000
      })
    );
    return resp.data.map(c => ({
      sha: c.sha,
      message: c.commit.message.split('\n')[0], // first line only
      date: c.commit.author.date,
      url: c.html_url,
      author: c.commit.author.name,
      files_added: [],
      files_modified: [],
      files_removed: []
    }));
  } catch (err) {
    console.error(`[Backfill] GitHub API error for ${owner}/${repo}:`, err.response?.status, err.message);
    return [];
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

// Get existing GitHub commit URLs from Build Logs to avoid duplicates
async function getExistingBuildLogUrls(buildLogsDbId) {
  try {
    const resp = await notion.databases.query({
      database_id: buildLogsDbId,
      page_size: 100
    });
    const urls = new Set();
    for (const page of resp.results) {
      const url = page.properties?.['Github Push (if any)']?.url;
      if (url) urls.add(url);
    }
    return urls;
  } catch (err) {
    console.error('[Backfill] Error fetching existing build logs:', err.message);
    return new Set();
  }
}

// Create a Build Log entry in Notion
async function createBuildLog(buildLogsDbId, data) {
  const properties = {
    Name: { title: [{ text: { content: data.message } }] },
    'Source (Github/Manual)': { select: { name: 'Github' } },
    'Github Push (if any)': { url: data.url },
    'Build Date': { date: { start: data.date } }
  };

  if (data.files_changed) {
    properties.Detail = { rich_text: [{ text: { content: data.files_changed } }] };
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
  const { notion: notionCfg, github } = cfg;
  const projectsDb = notionCfg.projectsDb;
  const buildLogsDb = notionCfg.buildLogsDb;

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

  // Step 2: Get existing GitHub push URLs to avoid duplicates
  const existingUrls = await getExistingBuildLogUrls(buildLogsDb);
  console.log(`[Backfill] ${existingUrls.size} existing build log entries`);

  // Step 3: For each repo, fetch commits and create missing entries
  let totalCreated = 0;
  const repoResults = [];

  for (const { id: projectId, name: projectName, repoUrl } of projects) {
    const parsed = parseRepoUrl(repoUrl);
    if (!parsed) {
      console.warn(`[Backfill] Invalid repo URL on project "${projectName}": ${repoUrl}`);
      continue;
    }

    console.log(`\n[Backfill] Processing ${parsed.owner}/${parsed.repo} (${projectName})...`);
    const commits = await fetchRecentCommits(parsed.owner, parsed.repo, 7);
    console.log(`[Backfill] Found ${commits.length} commits in last 7 days`);

    if (commits.length === 0) {
      repoResults.push({ repo: `${parsed.owner}/${parsed.repo}`, commits: 0, created: 0 });
      continue;
    }

    console.log(`[Backfill] Project page: ${projectId}`);

    let repoCreated = 0;
    for (const commit of commits) {
      if (existingUrls.has(commit.url)) {
        console.log(`[Backfill]   Skipping ${commit.sha.slice(0, 7)} — already exists`);
        continue;
      }

      const details = await fetchCommitDetails(parsed.owner, parsed.repo, commit.sha);
      const filesChanged = [
        ...details.files_added.map(f => `+ ${f}`),
        ...details.files_modified.map(f => `~ ${f}`),
        ...details.files_removed.map(f => `- ${f}`)
      ].join('\n');

      try {
        const newPage = await createBuildLog(buildLogsDb, {
          message: commit.message,
          url: commit.url,
          date: commit.date,
          files_changed: filesChanged,
          projectId
        });
        await appendBuildLogToProject(notion, projectId, newPage.id);
        existingUrls.add(commit.url);
        repoCreated++;
        totalCreated++;
        console.log(`[Backfill]   ✅ Created: ${commit.message.slice(0, 50)}`);
      } catch (err) {
        console.error(`[Backfill]   ❌ Failed: ${err.message}`);
      }

      await new Promise(r => setTimeout(r, 100));
    }

    repoResults.push({
      repo: `${parsed.owner}/${parsed.repo}`,
      commits: commits.length,
      created: repoCreated
    });
  }

  const summary = { success: true, repos: repoResults, totalCreated };
  logActivity('backfill', `${totalCreated} build log entries created across ${repoResults.filter(r => r.created > 0).length} repos`);

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
