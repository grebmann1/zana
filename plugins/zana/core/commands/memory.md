---
name: zana:memory
description: Search Zana's vector memory for prior patterns, decisions, and run notes. Returns top-K matches as a compact table. Search-only.
argument-hint: <query>
allowed-tools: mcp__zana__zana_memory_search
---

# /zana:memory

Vector-search Zana's memory store for prior patterns, decisions, and run notes that match the query.

`$ARGUMENTS` is the free-text query.

## Workflow

1. **Trim** `$ARGUMENTS`. If empty, ask "What should I search memory for?" and stop. Do not call the tool with an empty query.
2. **Search** — call `mcp__zana__zana_memory_search` with `{ "query": "<trimmed $ARGUMENTS>" }`. The MCP wrapper passes a default `limit` of 5 to the underlying vector store (the store would otherwise default to 10). The response is a bare array, sorted server-side by `score` descending.
3. **Render** a compact table — one row per hit, in the order the tool returned them (do not re-sort). Each hit is `{ id, content, metadata, score, tier }`:
   - `rank` (1, 2, 3, ...)
   - `score` (4 decimal places)
   - `tier` (one of `working` / `episodic` / `semantic`)
   - `id` (short, first 8 chars — primary handle if the user wants to look the entry up later)
   - `tags` — comma-joined `metadata.tags` if present, else `—`
   - `snippet` — the `content` string, truncated to ~120 chars (single line; collapse internal whitespace)
4. If the result set is empty, say so plainly and suggest broader query terms.
5. End with a one-line note: `Use mcp__zana__zana_memory_store after a successful run to capture what worked.`

## Rules

- Search-only. Do NOT call `zana_memory_store` or any other tool from this command.
- Pass the user's query through verbatim — do not rewrite or "expand" it.
- The vector store has no `namespace` / `key` concept — every entry is keyed by an opaque `id` with optional `metadata.tags`. Do not invent namespace/key columns.
- Truncate `content` to a snippet; never dump full payloads inline.
