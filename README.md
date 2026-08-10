# PerguntAI

Talk to your organization's data. An agentic data-analytics assistant + automation builder, built on **SvelteKit + Svelte 5 + Vercel AI SDK v7**, with **Claude** (Sonnet 5 / Opus 4.8 / Fable 5) served through **Microsoft Azure AI Foundry**, querying **StarRocks** under each user's own grants and running scripts/flows on self-hosted **Windmill**.

## What it does

- **Chat over the warehouse** — the agent writes and runs SQL against StarRocks (as the logged-in user), does statistics/forecasting in ephemeral Python, and returns markdown tables, Chart.js charts, Mermaid diagrams, and downloadable Excel/text reports.
- **Documents** — attach files to a conversation, *or* curate shared **org / department document libraries** (text, PDF, spreadsheets) the assistant can search and analyze.
- **Knowledge & memory** — admin-curated **organization / department knowledge** injected into every relevant user's assistant, plus opt-in per-user **memory** the assistant maintains about you.
- **Automations (flows)** — describe an automation in a dedicated builder chat; the assistant composes a validated flow (schedule → SQL check → agent → notify), you review it as a Mermaid diagram and activate it to run on Windmill.
- **Governance** — roles (user / builder / admin), a runtime admin panel, and **department-scoping** (from AD groups / cost centers) that gates knowledge, documents, and flows.

## Architecture

```
Browser (Svelte 5)                 SvelteKit server (adapter-node)                External
┌───────────────────┐  Bearer JWE  ┌──────────────────────────────┐
│ / (chat)          │ ───────────▶ │ /api/auth/login  ────────────┼─▶ Windmill /api/r/k-auth ─▶ AD (LDAPS)
│ /flows (builder)  │              │ /api/chat  · ToolLoopAgent    ┼─▶ Claude (Azure AI Foundry)
│ /organization     │ ◀ UI stream ─│   queryDatabase / runPython   ┼─▶ StarRocks (as the logged-in user)
│  @ai-sdk/svelte   │              │   windmill_* (MCP facade)     ┼─▶ Windmill (per-user token)
└───────────────────┘              │ /api/flows/* · Windmill deploy┼─▶ Windmill (flows, cron, callbacks)
                                   └──────────────────────────────┘
                                     state → DATA_DIR (JSON files)   ·   telemetry → Sentry
```

- **Agent loop** — `ToolLoopAgent` (`src/lib/server/agent.ts`) runs multi-step tool calling server-side (≤10 steps, or until the user's daily token budget is spent), with Claude adaptive thinking.
- **Prompt caching** — the tool schemas + system block sit behind a 1-hour cache breakpoint; tools are sorted deterministically (`sortTools`) so the prefix is byte-stable and cache-hits across a conversation. Token accounting is cost-weighted (cache reads 0.1×, writes 1.25×).

## Identity & access control

- **Login → AD via Windmill.** `POST /api/auth/login` calls the Windmill route `POST $WINDMILL_BASE_URL/api/r/k-auth` (wraps `f/auth/auth_ldap`, an LDAPS bind), authenticated by the server-level `WINDMILL_AUTH_TOKEN` — the one exception to per-user auth, since users have no token before logging in. On success the AD entry (sAMAccountName, displayName, mail, `memberOf`, title, cost center) is captured; the canonical username is the lowercased `sAMAccountName`.
- **Token.** The server issues an **encrypted JWT (JWE, A256GCM)** carrying the user's credentials (for per-user tool auth) and their AD `profile`. Nothing in it is readable client-side.
- **Per-user warehouse.** `queryDatabase` opens StarRocks connections with the logged-in user's credentials (mysql2, `enableCleartextPlugin` for `mysql_clear_password` — use TLS/trusted network), so StarRocks enforces each user's own grants. Read-only by default; admins can grant `sqlWrite` (DROP/TRUNCATE/ALTER always blocked).
- **Roles & the admin panel.** Runtime access lives in `DATA_DIR/access.json` — per-user role (`user` / `builder` / `admin`), blocked flag, daily token limit, allowed models, `sqlWrite` / `windmillWrite`, plus the org knowledge base. Edited in **Settings → Administração**. `ADMIN_USERS` names bootstrap "platform" admins (the **SERVIDOR** badge) who can never be blocked or demoted. An empty user list = open mode (anyone with valid AD credentials). Access is **re-checked on every request**, so blocking/demoting takes effect immediately — no session store. The settings response exposes `isAdmin` / `isPlatformAdmin` (resolved live).
- **Departments.** Defined in the org console with a match rule against the user's AD groups / cost center; membership is computed per-request from the token — there is **no user store**. Departments scope knowledge, documents, and flow visibility.

## Models

The catalog is **deployment-defined**, built server-side in `src/lib/server/models.ts` and served to the client via `GET /api/models`. Two execution paths cover every provider:

- **`anthropic`** (native, direct API or Azure Foundry) — the built-in Claude entries (**`claude-sonnet-5` default**, Opus 4.8, Fable 5, Opus 5), present whenever Anthropic credentials are configured. This path keeps the Claude-only optimizations: prompt-cache breakpoints, adaptive thinking, and Anthropic **server tools** (`web_search`) — provisioned per-model on the Foundry workspace (**Opus/Fable yes, Sonnet no**), so web search is gated on both the user's opt-in and the chosen model.
- **`openai-compatible`** (`MODELS_EXTRA` env, JSON) — any `/v1` chat-completions endpoint: Ollama, OpenAI, Groq, vLLM, OpenRouter, Gemini's compat endpoint… Each entry declares `id`, `label`, `baseUrl`, and optionally `provider` (picker logo), `apiKey`/`apiKeyEnv`, `model` (upstream name), and `reasoningTag` (e.g. `"think"` — extracts `<think>…</think>` from reasoning models like Qwen/DeepSeek so the UI renders it as thinking). See `.env.example` for a local-Ollama example. `DEFAULT_MODEL_ID` picks the deployment default.

Each user's `allowedModels` widens their choice beyond the default (admins get all); the model is picked per-conversation in the composer and kept stable for the pane (so the model-scoped cache survives).

## Tools

Warehouse: `queryDatabase`, `listTables` (catalog served from the synced schema, kept out of the prompt for caching), `getTableSchema`, `runPython` (ephemeral Windmill workers; `dataQuery` pipes ≤20k rows server-side into pandas — never through the model). Output: `renderChart` (Chart.js, CVD-safe palette), `renderDiagram` (Mermaid), `generateExcel` (≤100k rows written server-side), `generateDocument`. Documents: `searchDocuments`, `previewTable`. UX: `askUser` (client-resolved option buttons). Memory (opt-in): `saveMemory` / `forgetMemory`. Windmill: a curated `windmill_*` facade (see below). Flow authoring lives on the Flows page, not the main chat.

## Knowledge, memory & documents

Three tiers, all resolved per-request from the token; shared tiers are admin-curated in **`/organization`**:

- **Organization / department knowledge** — titled, toggleable text blocks (definitions, conventions). Company blocks apply to everyone; department blocks only to matching users. Injected into the system prompt in a cache-stable order.
- **Organization / department document libraries** — files (`.txt .md .json .sql .log`, **PDF** via `unpdf`, **spreadsheets** via SheetJS) reused across conversations. A small **manifest** (name + summary) is injected so the assistant proactively reaches for the right doc; the content itself is retrieved (BM25), never injected. Spreadsheets are analyzable with `previewTable` / `runPython`.
- **User memory** — opt-in per user (Settings → Memória). Topic-based (title / summary / markdown details), agent-written via `saveMemory`, fully user-visible and deletable (LGPD). Injected only when enabled.

Per-conversation **uploads** (composer paperclip) still work and are searched alongside the shared libraries. The workbook parser (`src/lib/server/workbook.ts`) detects the header row, names unnamed columns, drops blank rows, and infers column types.

## Flows (automation)

Builder chat on **`/flows`**: the assistant composes a flow as a small tree — one trigger (5-field cron in America/Sao_Paulo, or manual) → optional SQL-check gates → agent steps → notify steps (allowlisted Windmill scripts). A server-side validator returns path-addressed errors so the model self-repairs. The flow renders as an auto-generated **Mermaid** diagram; activating a version compiles it to Windmill OpenFlow and deploys it (schedule + agent-step callbacks) under the owner's Windmill deploy token. Flows are **department-scoped**: admins see all, builders see their departments' + their own; activation is owner-only (it seals the activator's live credentials as run-as); legacy flows show up as *orphaned* for admin triage.

## Windmill MCP

`src/lib/server/mcp.ts` connects per-request to the Windmill MCP server with the calling user's own token. Windmill serves ~83 tools; PerguntAI keeps only a **curated facade** — the find-and-run generic API (list/get/run scripts & flows, jobs, variables, schedules, docs), plus any script using the `perguntai_token` convention (a short-lived JWE injected at call time so the script acts as the user). The ~46 per-user per-script tools are dropped from the prompt but stay reachable via `windmill_runScriptByPath`. Workspace mutations are gated behind the admin-granted `windmillWrite`.

## Observability

`@sentry/sveltekit` (`src/hooks.server.ts`) with the Vercel AI SDK integration — per-agent traces (model, tokens, latency, tool calls), errors, and MCP monitoring. **DSN-gated**: unset `SENTRY_DSN` = fully inert. PII off (`dataCollection.genAI.inputs/outputs: false` and the AI SDK omits I/O from spans) — prompts carry warehouse rows and personal context that must not leave.

## State layout (`DATA_DIR`, default `./data`)

`conversations/<user>/`, `settings/<user>.json` (Windmill token AES-encrypted at rest), `rag/<user>.json` + `rag/_shared/{org,dept-*}.json`, `memory/<user>.json`, `flows/<user>/` + `flows/_index.json`, `usage/<user>.json`, `access.json`, `exports/` (7-day, behind authenticated `/api/exports`). Plus `schema.json` (synced warehouse catalog).

## Setup

1. **Env** — copy `.env.example` to `.env` and fill in the Foundry (or Anthropic) key, `JWT_SECRET`, `WINDMILL_AUTH_TOKEN`, the Windmill instance, and StarRocks. Set `ADMIN_USERS` to your bootstrap admin(s). Optional: `SENTRY_DSN`.
2. **Users** — none to create. Anyone who authenticates against AD (via the Windmill k-auth route) can sign in; their StarRocks grants govern what they can read. Roles/limits are managed in the admin panel.
3. **Sync the schema** (gives the agent instant warehouse knowledge):
   ```bash
   STARROCKS_SYNC_USER=<user> STARROCKS_SYNC_PASSWORD=<pass> npm run sync-schema
   ```
   Re-run whenever the schema changes; the app picks it up without a restart.
4. **Run**:
   ```bash
   npm install
   npm run dev
   ```

## Deployment

- **Docker** — `adapter-node` + Docker; `docker-compose.yml` uses `env_file: .env`, listens on `0.0.0.0:3000`, and keeps state in the `perguntai-data` named volume (bind mounts break the non-root user's writes). CI pushes `ghcr.io/your-org/perguntai` on push to main; on the server `docker compose pull && docker compose up -d`. Schema sync in Docker: one-off `docker compose exec perguntai node scripts/sync-schema.js`, or the daily `schema-sync` sidecar via `docker compose --profile sync up -d`.
  - Windmill workers must reach the app for flow agent-step callbacks — set `PERGUNTAI_BASE_URL` (falls back to `ORIGIN`). Raise `BODY_SIZE_LIMIT` (e.g. `15M`) for PDF uploads.
- **Kubernetes (target)** — a starter Helm chart lives in `deploy/helm/perguntai/` (stateless Deployment + HPA + Ingress, optional in-cluster PgBouncer, Postgres/Blob as externals). It assumes the app has been migrated off the local-filesystem store to managed Postgres + Blob — see the chart's `NOTES.txt`.

## Commands

| Command | |
| --- | --- |
| `npm run dev` | dev server |
| `npm run build` / `npm run preview` | production build / preview |
| `npm run check` | svelte-check + TypeScript |
| `npm run sync-schema` | regenerate `schema.json` from StarRocks |
| `npm run lint` / `npm run format` | prettier |
