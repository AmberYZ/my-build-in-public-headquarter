/**
 * backfill.js
 * Scans GitHub repos from the Github Setups DB, fetches recent commits (last 7 days),
 * and creates Build Log entries for any commits not already logged.
 */
require('dotenv').config();
const { Client } = require('@notionhq/client');
const axios = require('axios');
const { load, logActivity } = require('./config-store');

const notion = new Client({ auth: process.env.NOTION_API_KEY });

const GITHUB_API = 'https://api.github.com';

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
    const resp = await axios.get(`${GITHUB_API}/repos/${owner}/${repo}/commits`, {
      params: { since, per_page: 100 },
      headers: { Accept: 'application/vnd.github.v3+json' },
      timeout: 15000
    });
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
    const resp = await axios.get(`${GITHUB_API}/repos/${owner}/${repo}/commits/${sha}`, {
      headers: { Accept: 'application/vnd.github.v3+json' },
      timeout: 10000
    });
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

// Look up a project page ID by GitHub repo URL
async function findProjectByGithub(projectsDbId, repoUrl) {
  try {
    const resp = await notion.databases.query({
      database_id: projectsDbId,
      filter: { property: 'Github', url: { equals: repoUrl } },
      page_size: 1
    });
    return resp.results.length > 0 ? resp.results[0].id : null;
  } catch {
    return null;
  }
}

// Append a Build Log page ID to the Projects DB's Build Logs relation (parent-side link)
async function linkBuildLogToProject(projectPageId, buildLogPageId) {
  if (!projectPageId || !buildLogPageId) return;
  try {
    await notion.pages.append({
      page_id: projectPageId,
      children: [] // no children needed — just append to the relation property
    });
    // Actually append to the Build Logs relation property
    await notion.pages.update({
      page_id: projectPageId,
      properties: {
        'Build Logs': {
          relation: [{ id: buildLogPageId }]
        }
      }
    });
  } catch (err) {
    console.warn('[Backfill] Could not link Build Log to project:', err.message);
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
  const githubSetupsDb = notionCfg.githubSetupsDb;

  console.log('[Backfill] Starting GitHub → Notion backfill...');

  // Step 1: Get all repos from Github Setups DB
  let setups = [];
  try {
    const resp = await notion.databases.query({
      database_id: githubSetupsDb,
      page_size: 50
    });
    setups = resp.results;
  } catch (err) {
    console.error('[Backfill] Failed to query Github Setups DB:', err.message);
    return { success: false, error: err.message };
  }

  if (setups.length === 0) {
    console.log('[Backfill] No repos found in Github Setups DB');
    return { success: true, repos: 0, created: 0 };
  }

  // Step 2: Get existing GitHub push URLs to avoid duplicates
  const existingUrls = await getExistingBuildLogUrls(buildLogsDb);
  console.log(`[Backfill] ${existingUrls.size} existing build log entries`);

  // Step 3: For each repo, fetch commits and create missing entries
  let totalCreated = 0;
  const repoResults = [];

  for (const setup of setups) {
    const repoUrl = setup.properties?.['Github Repo']?.url;
    const projectName = setup.properties?.['Project Name']?.title?.[0]?.plain_text || repoUrl;

    const parsed = parseRepoUrl(repoUrl);
    if (!parsed) {
      console.warn(`[Backfill] Invalid repo URL: ${repoUrl}`);
      continue;
    }

    console.log(`\n[Backfill] Processing ${parsed.owner}/${parsed.repo}...`);
    const commits = await fetchRecentCommits(parsed.owner, parsed.repo, 7);
    console.log(`[Backfill] Found ${commits.length} commits in last 7 days`);

    if (commits.length === 0) {
      repoResults.push({ repo: `${parsed.owner}/${parsed.repo}`, commits: 0, created: 0 });
      continue;
    }

    // Fetch project link
    const projectId = await findProjectByGithub(projectsDb, repoUrl);

    let created = 0;
    for (const commit of commits) {
      if (existingUrls.has(commit.url)) {
        console.log(`[Backfill]   Skipping ${commit.sha.slice(0,7)} — already exists`);
        continue;
      }

      const details = await fetchCommitDetails(parsed.owner, parsed.repo, commit.sha);
      const filesChanged = [
        ...details.files_added.map(f => `+ ${f}`),
        ...details.files_modified.map(f => `~ ${f}`),
        ...details.files_removed.map(f => `- ${f}`)
      ].join('\n');

      try {
        const created = await createBuildLog(buildLogsDb, {
          message: commit.message,
          url: commit.url,
          date: commit.date,
          files_changed: filesChanged,
          projectId
        });
        // Link Build Log to the Project from the parent (Projects DB) side
        await linkBuildLogToProject(projectId, created.id);
        existingUrls.add(commit.url);
        created++;
        totalCreated++;
        console.log(`[Backfill]   ✅ Created: ${commit.message.slice(0, 50)}`);
      } catch (err) {
        console.error(`[Backfill]   ❌ Failed: ${err.message}`);
      }

      await new Promise(r => setTimeout(r, 100));
    }

    repoResults.push({ repo: `${parsed.owner}/${parsed.repo}`, commits: commits.length, created });
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
