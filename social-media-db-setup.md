# Sent posts (voice) database — Notion

Create a **full-page database** in Notion to store posts you **actually published**. The standup generator reads this so social drafts can match your **tone and style** over time.

## 1. Create the database

1. In Notion, create a new **full-page database** (or add a database to a page you own).
2. Name it something like **Sent posts** or **Published — Voice**.

## 2. Suggested properties

| Property name | Type | Purpose |
|---------------|------|---------|
| **Name** | Title | Short label (e.g. “LinkedIn — ship week”) |
| **Post** | Text | Full text of what you sent (required for voice) |
| **Platform** | Select | Options: `Twitter/X`, `LinkedIn`, `Threads`, `Other` |
| **Date** | Date | When you posted (optional but helpful) |

The code also recognizes **Content**, **Body**, **Text**, **Caption**, or **Draft** instead of **Post** if you prefer different names. If you have multiple rich-text fields, the longest non-empty one is used.

## 3. Connect to this skill

1. Open the database in Notion, copy the **database ID** from the URL (32-char hex after the workspace name and last `/`).
2. Paste it into the dashboard under **Sent posts / voice DB**, or set `notion.socialMediaDb` in `config.json`.

## 4. Share with your integration

Ensure your Notion integration has access to this database (same as your other build-in-public DBs).

## 5. Habit

After you post something you care about, add a row with the **Post** text. Optional: page body under the row is also read if the main property is empty.
