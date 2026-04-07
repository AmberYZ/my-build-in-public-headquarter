const { Client } = require('@notionhq/client');
const notion = new Client({ auth: process.env.NOTION_API_KEY });
const { load } = require('./config-store');

function parseRepoUrl(url) {
  const match = url && url.match(/github\.com\/([^\/]+)\/([^\/\?#]+)/);
  if (match) return { owner: match[1], repo: match[2] };
  return null;
}

async function handleGitHubWebhook(payload) {
  const cfg = load();
  const repoUrl = payload.repository?.html_url;
  const commits = payload.commits || [];
  const headCommit = payload.head_commit;

  if (!repoUrl) throw new Error('No repository URL in webhook payload');

  console.log(`[Webhook] Push to ${repoUrl} — ${commits.length} commit(s): "${headCommit?.message}"`);

  // Look up project by GitHub repo URL in Projects DB
  let projectId = null;
  try {
    const resp = await notion.databases.query({
      database_id: cfg.notion.projectsDb,
      filter: { property: 'Github', url: { equals: repoUrl } },
      page_size: 1
    });
    if (resp.results.length > 0) {
      projectId = resp.results[0].id;
      const name = resp.results[0].properties?.Name?.title?.[0]?.plain_text;
      console.log(`[Webhook] Linked to project: ${name || projectId}`);
    }
  } catch (err) {
    console.error('[Webhook] Project lookup error:', err.message);
  }

  // Create Build Log entry
  const allChanges = commits.flatMap(c => [
    ...(c.added || []).map(f => `+ ${f}`),
    ...(c.modified || []).map(f => `~ ${f}`),
    ...(c.removed || []).map(f => `- ${f}`)
  ]).join('\n');

  const properties = {
    Name: { title: [{ text: { content: headCommit?.message?.split('\n')[0] || `Push to ${repoUrl}` } }] },
    'Source (Github/Manual)': { select: { name: 'Github' } },
    'Github Push (if any)': { url: `${repoUrl}/commit/${payload.head_commit?.id}` },
    'Build Date': { date: { start: payload.head_commit?.timestamp || new Date().toISOString() } }
  };

  if (allChanges) {
    properties.Detail = { rich_text: [{ text: { content: allChanges } }] };
  }
  // Note: Projects is a dual_property - do not set from child side

  const created = await notion.pages.create({
    parent: { database_id: cfg.notion.buildLogsDb },
    properties
  });

  console.log(`[Webhook] Build Log created: ${created.id}`);
  return created;
}

module.exports = { handleGitHubWebhook };
