/**
 * config-store.js
 * Persistent JSON config for the build-in-public skill.
 * Lives at ~/.openclaw/workspace/skills/build-in-public/config.json
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG_PATH = path.join(__dirname, 'config.json');

const DEFAULT_CONFIG = {
  standup: {
    cron: '0 8 * * *',
    enabled: true,
    /** Poll Notion standup pages for checked to-dos and append Build Log rows (cron expression; empty = disabled). */
    syncCheckedTodosCron: '*/15 * * * *',
    ideaTypes: ['New Feature', 'Feature Improvement', 'Content Idea', 'Marketing'],
    /** Free text: current friction (e.g. unclear next step, distribution, storytelling). Injected as {BIGGEST_BLOCKER}. */
    biggestBlocker: '',
    prompt: `You are a startup founder's AI productivity assistant. You receive structured data from the user's Notion databases (build logs, idea logs, projects, and optionally posts they actually published) plus their idea-type preferences and their stated biggest blocker or friction.

## How to think (do this before writing)
1. **North star** — They are building in public: **ship a product** and **build a personal brand** together. Prefer suggestions that advance both; when they conflict, say so briefly.

2. **Analyze intention** — From build logs, ideas, projects, idea-type preferences, sent-post samples (if any), and the blocker line, infer what they are optimizing for this week.

3. **Connect the databases** — Find inherent links: ideas that belong with or extend a project; builds that become content; gaps between projects and ideas. Prefer **actionable** moves over generic brainstorms. Assume each todo can be **finished or materially advanced in one focused workday** (no vague "someday" items).

4. **Social drafts** — When "POSTS THEY ACTUALLY SENT" is non-empty, **study that section first**: match vocabulary, pacing, humor, directness, and emotional color so drafts sound like **this person**, not a generic founder. If that section is empty, still be specific and human—never corporate brochure tone.

Then output the standup with these sections:

## 🧭 Intention snapshot
2-4 sentences: what you infer they want this week (shipping + brand), tying to preferences, blocker, and sent-post voice when relevant.

## 📋 Today's TODO List
4-6 actionable todos for **today**. "Todo" is **not** only writing code. Include a healthy mix when it fits the data:
- **Ship / build** — implement, fix, ship a slice, measure
- **Clarify the idea** — write a one-pager, talk to users, sharpen the problem
- **Research** — learn a tool, market, or competitor enough to decide
- **Trim or refocus** — cut scope, merge ideas, park a thread
- **Decide to pause or drop** — valid outcome if an idea no longer fits; say it clearly
- **Brand & distribution** — build in public, draft posts, community, positioning

Format each task as a markdown task line: "- [ ] Task description" (one line per task). Use **unchecked** "- [ ]" only so Notion renders real checkboxes; the user checks them in Notion when done.

## 💡 Ideas to Explore
Suggest 2-3 ideas that **connect** to the data above. For each, briefly state how it links (e.g. extends Project X, turns Idea Y into something shippable, unblocks the stated friction). Categorize each as:
- 🛠️ Technical (features, tools, architecture)
- 📣 Business (revenue, users, partnerships)
- 📝 Content (posts, blogs, videos)

## 📚 Things to Learn
Suggest 1-2 relevant resources (articles, videos, tools) grounded in current projects and the blocker.

## 📝 Social Media Drafts
1 Twitter/X post (under 280 chars) + 1 LinkedIn post (2-3 paragraphs). Ground in **specific** details from build logs, ideas, projects, and blocker.

**Voice:** Mirror the tone and spirit of **POSTS THEY ACTUALLY SENT** below when present—same energy, phrasing habits, and personality. Do not sound like a different person.

---
📦 RECENT BUILD LOGS:
{BUILD_LOGS}

💡 RECENT IDEAS:
{IDEA_LOGS}

📁 PROJECTS (from Notion):
{PROJECTS}

🎯 IDEA TYPES TO PRIORITIZE:
{IDEA_TYPES}

🚧 BIGGEST BLOCKER OR FRICTION LATELY:
{BIGGEST_BLOCKER}

📣 POSTS THEY ACTUALLY SENT (voice & style — learn from these):
{SOCIAL_SENT_POSTS}`
  },
  github: {
    syncEnabled: true,
    webhookSecret: 'secret_change_me_123',
    repos: []
    // repos are auto-populated from Github Setups DB on each scan
  },
  notion: {
    // These are auto-filled during setup/backfill from DB IDs
    projectsDb: '33b56b0e-dde0-8033-98c4-d5a5098e50e1',
    buildLogsDb: '33b56b0e-dde0-80ee-aaf4-e07594673071',
    ideaLogsDb: '33b56b0e-dde0-8047-bd1f-e33ed88e5a1f',
    githubSetupsDb: '33b56b0e-dde0-8092-ac21-fab610ab52ba',
    /** Notion database ID — each standup is a new row (title = Daily Stand-up - YYYY-MM-DD). */
    standupDb: null,
    /** Optional: database of posts the user actually published (for voice/style in standup). See social-media-db-setup.md */
    socialMediaDb: null
  },
  server: {
    port: 3001,
    host: 'localhost'
  },
  _runtime: {
    ai: {
      provider: 'openai',
      model: 'gpt-4o-mini',
      baseUrl: '',
      apiKey: '',
      temperature: 0.7,
      maxTokens: 1500
    },
    minimaxApiKey: ''
  },
  activityLog: []
};

function load() {
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      // Deep merge with defaults so new fields are always present
      const merged = deepMerge(DEFAULT_CONFIG, raw);
      if (merged.notion && Object.prototype.hasOwnProperty.call(merged.notion, 'standupParentPage')) {
        delete merged.notion.standupParentPage;
      }
      return merged;
    } catch (e) {
      console.error('[Config] Failed to parse config.json, using defaults');
    }
  }
  return { ...DEFAULT_CONFIG };
}

function save(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

function deepMerge(base, override) {
  const result = { ...base };
  for (const key of Object.keys(override || {})) {
    if (
      override[key] !== null &&
      typeof override[key] === 'object' &&
      !Array.isArray(override[key]) &&
      typeof base[key] === 'object' &&
      !Array.isArray(base[key])
    ) {
      result[key] = deepMerge(base[key], override[key]);
    } else {
      result[key] = override[key];
    }
  }
  return result;
}

/**
 * Append to activity log. Always loads the latest config from disk first so we never
 * overwrite newer saves with a stale in-memory object (e.g. server.js top-level cfg).
 */
function logActivity(action, detail) {
  const cfg = load();
  cfg.activityLog = cfg.activityLog || [];
  cfg.activityLog.unshift({
    timestamp: new Date().toISOString(),
    action,
    detail
  });
  if (cfg.activityLog.length > 100) {
    cfg.activityLog = cfg.activityLog.slice(0, 100);
  }
  save(cfg);
}

module.exports = { load, save, logActivity, DEFAULT_CONFIG };
