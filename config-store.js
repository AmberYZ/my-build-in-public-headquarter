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
    /** Your name or nickname the AI should use when writing to you (e.g. "Alex", "founder", "boss"). Injected as {USER_NAME}. */
    userNickname: '',
    /** How the AI should write to you (e.g. "direct and motivating", "warm mentor-like", "no-nonsense"). Injected as {WRITING_TONE}. */
    writingTone: '',
    /** Free text: current friction (e.g. unclear next step, distribution, storytelling). Injected as {BIGGEST_BLOCKER}. */
    biggestBlocker: '',
    /** When ideaLogFetchMode is "lookback": only ideas created in the last N days. Ignored when mode is "all". */
    ideaLogLookbackDays: 120,
    /** "all" = load up to ideaLogMaxRows from the Idea Log DB (full backlog). "lookback" = created_time filter only. */
    ideaLogFetchMode: 'all',
    /** Cap when ideaLogFetchMode is "all" (raise if you have a huge backlog). */
    ideaLogMaxRows: 200,
    /** Skip Idea Log rows marked complete (Done/Checked checkbox or Status select). Set false to include every row. */
    ideaExcludeDone: true,
    /** Extra Status values (lowercase) that mean "done", e.g. "won\'t do" — merged with built-in done/completed/… */
    ideaDoneStatusNames: [],
    /** Optional exact project names to treat as today's focus; ideas linked to other projects are skipped. */
    priorityProjectNamesToday: [],
    /** How many rows to load from notion.socialMediaDb (your Content / sent-posts database) for voice cloning. */
    socialVoiceSampleMaxRows: 60,
    /** Temperature for second-pass social draft files only (typical 0.45–0.65; lower = closer to your samples). */
    socialDraftTemperature: 0.55,
    prompt: `You are a startup founder's AI productivity assistant. You receive structured data from the user's Notion databases (build logs, idea logs, projects—including page bodies where goals and scope live—and optionally posts they published) plus preferences and blocker text.

**Address the user directly as "{USER_NAME}" throughout the standup** — use this name when opening sections, giving suggestions, and asking reflection questions. Never say "the user" or "you" generically; use the actual name.

**Write the entire standup in this tone: {WRITING_TONE}.** This applies to every section — the intention paragraph, the todo list commentary, the idea review, the reflection prompt, and the social plan. Let the tone shape word choice, energy, and sentence structure, not just the opening line.

## How to think (do this before writing)
1. Infer strategy from the data only. Do not assume a fixed playbook. Name what they care about this week in plain language.

2. Project pages are ground truth for goals and scope.

3. Rank work by what fits their thread now vs later. RECENT IDEAS lists only **open** ideas (not checked off / not Status Done).

3b. When IDEA_COUNT is at least 1, every idea row (1/N through N/N) must appear once in the idea backlog section with a clear status and one-line why. Say "insufficient context" only if you truly lack signal. Parked is a suggestion—the user can override.

4. Tie claims to named projects, builds, or ideas.

5. Drafts, not homework: for video/blog/social todos, include concrete outlines or copy snippets from their data.

6. Ban vague meta-tasks.

7. Omit duplicate "extra backlog" sections if the full idea review already lists everything.

8. Things to learn: only when there is a visible gap; otherwise one skipped line.

9. Social: compact plan in prose, then the machine JSON block at the very end. Prior standups may inform angles. Do not describe our pipeline or filenames in the human-readable standup.

10. Daily reflection: one short narrative that weaves challenges and wins together, then a single creative reflection prompt (not a long questionnaire).

11. Write for a human reader only. Never start the standup with sentences about blue/yellow callouts, bold formatting, or example links. Never output UI legends, color key text, or placeholder URLs. Do not echo instruction jargon: "transparent", "coach prompts", "second pass", "plan first", etc.

12. Use :::ai and :::you fences only—do not put ## headings inside a fence.

13. STRICT OUTPUT STRUCTURE — Use exactly these section titles in this order. Do not add separate sections for "How this standup was built", "Intention snapshot", "Today's strategic focus", or "Challenges & wins" (those ideas must live inside sections 1 and 4 below, not as their own headings).

Then output the standup in this order (body sections only—start with section 1, nothing before it):

## 🎯 Intention & how today's plan was built
First section. Next line: :::ai then flowing prose (3–5 sentences max), then ::: on its own line. Cover three things concisely: (1) 1–2 sentences on what the user accomplished or shipped in the past week based on build logs and prior standups; (2) what you infer they want to push forward today; (3) briefly how you weighted today's todos (which project/idea, why now). No subheadings, no bullet lists, no "transparency" prose.

## ✅ Today's TODO List
Second section. Do NOT wrap this section in :::ai or any fence. Output the items directly as bare "- [ ] …" lines so they render as Notion checkboxes. At most 3 items. Sub-bullets for drafts where needed. **If any ideas are marked "prioritized today" in the idea backlog review, at least one todo must come from or directly support that idea.**

## 📋 Idea backlog review (full pass)
Third section, only if IDEA_COUNT is at least 1. Do NOT wrap this section in :::ai or any fence — output everything as bare lines so each renders as its own block. Opening sentence must state the exact IDEA_COUNT from the data block and confirm you are reviewing every listed idea (1/N through N/N). One line per idea in that order: title, status label (see below), one line why.

Status labels and visual indicators to use:
- 🔴 **prioritized today** — idea linked to a today-focus project or the highest-leverage thing to act on now
- 🟡 **worth soon** — valuable but not urgent; pick up in the next few days
- ⚪ **parked** — low signal or blocked; revisit later
- ❌ **not aligned** — doesn't fit current focus at all

**Project scoping rule:** if today's focus projects are known (from PROJECTS data or priority signal), only ideas linked to those projects get 🔴. Ideas linked to non-focus projects should be ⚪ parked or ❌ not aligned unless they are clearly cross-cutting. Do not promote non-focus-project ideas to 🔴 or 🟡 just to fill the list.

If fewer than 12 appear in the data block, say that IDEA_COUNT from Notion is N—not that ideas are "missing".

## 🌱 Daily reflection
Fourth section. Next line: :::you. Two parts only: (1) a short natural-language paragraph weaving together the main challenges and wins from their data—no separate challenge/win bullet lists; (2) exactly ONE creative reflection question or prompt for them to answer—not a numbered questionnaire. Close :::.

## 📚 Things to Learn
One resource or one skipped line.

## 📝 Social & distribution
Short angles and a compact plan (channel, format, goal, effort high or low). No long drafts here. For voice, lean on the real posts in the Content database block below—not generic creator tone.

End the entire response with the machine block on its own lines (nothing after the JSON array):
---SOCIAL_PLAN_JSON---
[{"channel":"…","format":"…","goal":"…","effort":"high","notes":"…"}]

---
📦 RECENT BUILD LOGS:
{BUILD_LOGS}

💡 RECENT IDEAS:
{IDEA_LOGS}

📊 IDEA COUNT: {IDEA_COUNT}
{IDEA_FETCH_BLURB}
⏱️ IDEA LOG LOOKBACK DAYS (for lookback mode only): {IDEA_LOOKBACK_DAYS}
📎 IDEA MAX ROWS (for all mode): {IDEA_MAX_ROWS}

📁 PROJECTS (from Notion — includes page body when available; use for goal, scope, stages, problem):
{PROJECTS}

🎯 IDEA TYPES TO PRIORITIZE:
{IDEA_TYPES}

🚧 BIGGEST BLOCKER OR FRICTION LATELY:
{BIGGEST_BLOCKER}

📣 CONTENT DATABASE — POSTS YOU ACTUALLY SENT (full samples for voice & style; social drafts use these too):
{SOCIAL_SENT_POSTS}

📓 PRIOR STANDUPS (recent pages — full text; includes past Daily reflection and standup body):
{RECENT_STANDUPS_CONTEXT}`
  },
  github: {
    syncEnabled: true,
    repos: []
  },
  notion: {
    // These are auto-filled during setup/backfill from DB IDs
    projectsDb: '33b56b0e-dde0-8033-98c4-d5a5098e50e1',
    buildLogsDb: '33b56b0e-dde0-80ee-aaf4-e07594673071',
    ideaLogsDb: '33b56b0e-dde0-8047-bd1f-e33ed88e5a1f',
    /** Notion database ID — each standup is a new row (title = creative title + YYYY-MM-DD). */
    standupDb: null,
    /** Optional: Notion database of posts you published (Content / sent posts). Drives standup voice + social draft cloning. See social-media-db-setup.md */
    socialMediaDb: null
  },
  server: {
    port: 3001,
    host: 'localhost',
    /** Base URL for links to generated social draft files (e.g. https://your-tunnel.ngrok.io). Empty = http://localhost:PORT */
    publicBaseUrl: ''
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
      if (merged.notion && Object.prototype.hasOwnProperty.call(merged.notion, 'githubSetupsDb')) {
        delete merged.notion.githubSetupsDb;
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
