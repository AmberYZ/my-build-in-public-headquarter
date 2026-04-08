# Context depth vs RAG

## What you have today

Standup generation already pulls **rich context** from Notion:

- **Project rows:** properties plus **full page body** (blocks under each project).
- **Build logs & ideas:** properties plus **page body** where you added notes.
- **Sent posts DB:** text for voice matching.

That is usually enough for **one consolidated prompt** per run.

## When a classic RAG stack helps

Consider **retrieval** (chunking + embeddings + vector search) if:

- You maintain **many long docs** (Notion pages with nested links, PDFs, Google Docs) that are **not** fully fetched into the prompt.
- You need answers that **cite** arbitrary past notes across months.
- The same integration must answer **ad-hoc questions**, not only daily standup.

## Middle ground (without full RAG)

- Keep **high-signal** summaries on **project** and **idea** parent pages (goals, scope, links as bullet lists)—the fetch already reads that page body.
- For **linked** Notion pages, you can duplicate key lines into the parent page so they ride along in one fetch.

## Bottom line

You do **not** need RAG to fix standup quality if the **important** narrative lives on the project/idea pages you already sync. Add RAG when **volume and linkage** exceed what a single Notion pull can reasonably include.
