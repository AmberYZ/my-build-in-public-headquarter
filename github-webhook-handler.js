const { Client } = require('@notionhq/client');
const notion = new Client({ auth: process.env.NOTION_API_KEY });
const { load } = require('./config-store');
const {
  findProjectPageByGithubUrl,
  appendBuildLogToProject,
  formatGithubCommitDetailForNotion,
  getBuildLogCategoryFieldMeta,
  applyBuildLogCategoryProperty
} = require('./notion-project-github');
const { summarizeCommitForBuildLogName, classifyBuildLogCategory } = require('./ai-provider');

async function handleGitHubWebhook(payload) {
  const cfg = load();
  const repoUrl = payload.repository?.html_url;
  const commits = payload.commits || [];
  const headCommit = payload.head_commit;

  if (!repoUrl) throw new Error('No repository URL in webhook payload');

  console.log(`[Webhook] Push to ${repoUrl} — ${commits.length} commit(s): "${headCommit?.message}"`);

  let projectId = null;
  try {
    projectId = await findProjectPageByGithubUrl(notion, cfg.notion.projectsDb, repoUrl);
    if (projectId) {
      console.log(`[Webhook] Matched project page ${projectId}`);
    } else {
      console.warn(
        `[Webhook] No Projects row for ${repoUrl} — add this repo URL to the **Github** field on a project (normalized matching).`
      );
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

  let fullCommitMessage = '';
  if (commits && commits.length > 0) {
    fullCommitMessage = commits.map(c => c.message).filter(Boolean).join('\n\n---\n\n');
  } else if (headCommit?.message) {
    fullCommitMessage = headCommit.message;
  }

  const detailText = formatGithubCommitDetailForNotion(fullCommitMessage, allChanges);
  const categoryMeta = await getBuildLogCategoryFieldMeta(notion, cfg.notion.buildLogsDb);
  const [title, categoryName] = await Promise.all([
    summarizeCommitForBuildLogName(cfg, fullCommitMessage, allChanges),
    categoryMeta
      ? classifyBuildLogCategory(cfg, fullCommitMessage, allChanges, categoryMeta)
      : Promise.resolve(null)
  ]);

  const properties = {
    Name: { title: [{ text: { content: title || `Push to ${repoUrl}` } }] },
    'Source (Github/Manual)': { select: { name: 'Github' } },
    'Github Push (if any)': { url: `${repoUrl}/commit/${payload.head_commit?.id}` },
    'Build Date': { date: { start: payload.head_commit?.timestamp || new Date().toISOString() } }
  };

  if (detailText) {
    properties.Detail = { rich_text: [{ text: { content: detailText } }] };
  }
  if (categoryMeta && categoryName) {
    applyBuildLogCategoryProperty(properties, categoryMeta, categoryName);
  }
  // Note: Projects is a dual_property - do not set from child side

  const created = await notion.pages.create({
    parent: { database_id: cfg.notion.buildLogsDb },
    properties
  });

  if (projectId) {
    await appendBuildLogToProject(notion, projectId, created.id);
  }

  console.log(`[Webhook] Build Log created: ${created.id}`);
  return created;
}

module.exports = { handleGitHubWebhook };
