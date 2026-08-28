# PerguntAI

Talk to your organization's data. An agentic data-analytics assistant built on **SvelteKit + Svelte 5 + Vercel AI SDK v7**, with **Claude** served through **Microsoft Azure AI Foundry**, querying **StarRocks** under each user's own grants. Ships with an admin console for knowledge, access policies, usage statistics and auditing, an OpenAI-compatible API, and an optional sandboxed code-execution capability.

## What it does

- **Chat over the warehouse**: the agent writes and runs SQL against StarRocks as the logged-in user and returns markdown tables, Chart.js charts, Mermaid diagrams, and downloadable Excel or text reports.
- **Documents**: attach files to a conversation, or curate shared organization and department document libraries (text, PDF, spreadsheets) the assistant searches and analyzes.
- **Knowledge and memory**: admin-curated organization and department knowledge injected into every relevant user's assistant, plus opt-in per-user memory the assistant maintains about you.
- **Learned skills**: after succeeding at a non-trivial task, the assistant captures the procedure as a reusable playbook (tables, filters, pitfalls, verification) and follows it next time. Skills are per-user; the assistant can propose one for department or organization use, activating only after an admin approves it in the console.
- **Code execution (beta)**: sandboxed Python (pandas, numpy, statsmodels, scikit-learn) plus the `basalt` CLI, each run inside a disposable hardware-isolated microVM. Enabled per deployment in the admin console.
- **Connectors**: users plug their own MCP servers (URL plus token) into the assistant; every call runs with the user's own credentials.
- **Programmatic access**: an OpenAI-compatible `/v1` endpoint and personal API keys with scopes, so any client that speaks the OpenAI protocol (openai SDKs, LangChain, Open WebUI, LiteLLM) can use the full agent.
- **Embedded chat**: an anonymous, read-only `/embed` page for intranet portals — visitors talk to the warehouse through a dedicated StarRocks service account scoped to curated views, with a message cap per conversation, a daily budget, and a restricted model tier. No accounts, no history, no advanced tools. Admins mint per-portal embed keys (`/embed?key=emb_…`), each carrying its own service account (encrypted server-side, never exposed), limits, framing origins, and usage attribution — individually revocable.
- **Scheduled runs (Programado)**: standing instructions the assistant executes automatically on a cadence (daily/weekly/monthly) with nobody logged in — headless runs on the user's stored warehouse credential, charged to their daily token budget, with run history in the sidebar and optional e-mail delivery. Created from a conversation ("agende isso toda segunda às 8h") or in the UI.
- **Governance**: claim-based access policies, per-user exceptions, per-department usage attribution, and an audit log of sign-ins, requests, key and connector changes, and admin actions.

## Architecture

```
Browser (Svelte 5)                SvelteKit server (adapter-node)             External
+------------------+  Bearer JWE  +--------------------------------+
| / (chat)         | -----------> | /api/auth/login (LDAPS)        | --> AD / OIDC provider
| /organization    |              | /auth/callback (OIDC + PKCE)   |
|  admin console   | <- UI stream | /api/chat . ToolLoopAgent      | --> Claude (Azure AI Foundry)
| @ai-sdk/svelte   |              |   queryDatabase                | --> StarRocks (as the user)
+------------------+              |   runPython (capability, beta) | --> microsandbox microVMs (KVM)
                                  |   <user MCP servers>           | --> any MCP endpoint
External clients                  | /v1/chat/completions (OpenAI-  |
(openai SDK, LangChain, ...) ---> |   compatible, pai_ API keys)   |
                                  +--------------------------------+
                                    state: DATA_DIR (JSON files)      telemetry: Sentry (prod)
```

- **Agent loop**: `ToolLoopAgent` (`src/lib/server/agent.ts`) runs multi-step tool calling server-side (up to 24 steps, or until the user's daily token budget is spent), with Claude adaptive thinking.
- **Prompt caching**: the tool schemas and system block sit behind a 1-hour cache breakpoint; tools are sorted deterministically so the prefix is byte-stable across turns. Token accounting is cost-weighted (cache reads 0.1x, writes 1.25x).

## Identity and access control

- **Two sign-in doors, either or both**: OIDC (authorization code + PKCE, `OIDC_ISSUER`) and username/password over LDAPS (`LDAP_URL`). Both produce the same session and the same profile claims (groups, department, title, cost center); the canonical username is the lowercased `preferred_username`.
- **Token**: the server issues an encrypted JWT (JWE, A256GCM) carrying the user's credentials for per-user tool auth and their directory profile. Nothing in it is readable client-side.
- **Per-user warehouse**: `queryDatabase` opens StarRocks connections as the logged-in user, so StarRocks enforces each user's own grants. Read-only by default; admins can grant `sqlWrite` (DROP/TRUNCATE/ALTER always blocked by the SQL guard).
- **Access policies**: rules over sign-in claims (AD groups, cost center, any attribute) that grant role, extra models, SQL write and daily token limits. Evaluated per request from the token, so moving someone between AD groups changes their access on the next request; there is no user-profile store. Grants compose most-permissively; a per-user record is the exception mechanism (an explicit block or personal limit always wins).
- **Roles**: `user`, `builder`, `admin`, resolved live on every request from `DATA_DIR/access.json`. `ADMIN_USERS` names bootstrap platform admins (the SERVIDOR badge) who can never be blocked or demoted. Open mode (anyone with valid credentials may sign in) lasts only while no user records and no policies exist.

## Admin console (`/organization`)

The whole admin surface lives on one page, admin-only, with immediate-apply sections:

- **Conhecimento**: organization and department knowledge blocks, standing instructions (`MAX_ORG_PROMPT` chars, default 8000), and shared document libraries, edited per scope in a master-detail layout.
- **Modelos PDF**: Typst report templates with a live compiled preview — the template carries page setup and branding (`#include "content.typ"` marks the body slot), the assistant writes only the content.
- **Habilidades**: review queue for skills proposed for shared use (approve, suspend, remove), plus the active shared-skill list per scope.
- **Usuarios**: access policies (claim-rule editor with a "matches you" preview), plus one table of everyone the platform has seen: explicit records with full controls, policy-admitted users read-only with a "create exception" action.
- **Estatisticas**: token usage tiles (today, month, active users, cache rate, via-API split), a 30-day daily chart, per-department share (donut) and per-policy usage. Usage is tagged at request time with the departments and policies that matched, so attribution stays correct over time.
- **Auditoria**: every user's API keys (with admin revocation), the MCP connector fleet, and a filterable activity log (sign-ins, chat and API requests with the credential used, admin changes, key lifecycle, connector changes). Append-only JSONL under `DATA_DIR/audit/`, 6-month retention.
- **Capacidades**: deployment-wide feature switches. Currently: code execution (beta) with a sandbox test button, embedded chat (beta) with embed keys, report e-mails (beta) with SMTP status, and scheduled runs (beta).

## Models

The catalog is deployment-defined in `src/lib/server/models.ts`, served via `GET /api/models`. Two execution paths:

- **`anthropic`** (Azure AI Foundry or direct API): the built-in Claude entries (`claude-sonnet-5` default, Opus 4.8, Fable 5, Opus 5). This path keeps the Claude-only optimizations: prompt-cache breakpoints, adaptive thinking, and Anthropic server tools (`web_search`) where the Foundry workspace provisions them.
- **`openai-compatible`** (`MODELS_EXTRA` env, JSON): any `/v1` chat-completions endpoint (Ollama, OpenAI, Groq, vLLM, OpenRouter). Each entry declares `id`, `label`, `baseUrl`, and optionally `provider` (picker logo), `apiKey`/`apiKeyEnv`, `model`, and `reasoningTag` for models that emit `<think>` blocks.

Each user's allowed models come from their record plus matching policies (admins get all). The model is picked per conversation and kept stable for the pane so the model-scoped cache survives.

## Tools

Warehouse: `queryDatabase`, `listTables` (catalog served from the synced schema, kept out of the prompt for caching), `getTableSchema`. Output: `renderChart` (Chart.js), `renderDiagram` (Mermaid), `generateExcel` (result sets written server-side), `generateDocument`, `generatePdf` (model-authored Typst compiled in-process; data injected via `dataQuery` as `sys.inputs`, compile diagnostics fed back for self-correction), `emailReport` (capability, beta: branded HTML e-mail through one tested template — the model fills subject/greeting/markdown body and attaches a generated export; recipients domain-allow-listed, sends audited). Documents: `searchDocuments`, `previewTable`. UX: `askUser` (client-resolved option buttons, chat only). Memory (opt-in): `saveMemory`, `forgetMemory`. Code execution (capability, beta): in chat, workspace tools (`sandboxLoadData`, `sandboxWriteFile`, `sandboxReadFile`, `sandboxEditFile`, `sandboxExec`, `sandboxPresentFile`); on the stateless `/v1` API, the self-contained `runPython`. Plus whatever tools the user's own MCP servers expose, prefixed by server name.

## API access

- **`POST /v1/chat/completions`** and **`GET /v1/models`**: OpenAI-compatible, streaming and non-streaming, with `response_format` support (`json_object` and `json_schema`) for structured output. Point any OpenAI-protocol client at the app's base URL with a `pai_` key and it gets the full agent (warehouse, documents, code execution) under the caller's own permissions, limits and audit trail. Stateless: callers keep their own history.
- **Warehouse access for keys**: an API-key request carries no interactive credential, so the server keeps one per user — OIDC deployments mint a StarRocks id_token from the stored refresh token; password (LDAP) deployments store the directory credential encrypted at rest (AES-256-GCM under `JWT_SECRET`) on each sign-in. Signing out deletes it, which revokes API-key warehouse access until the next sign-in.
- **API keys** (Settings, Chaves de API): shown once, SHA-256 stored, optional expiry (90-day default), a non-secret hint (`pai_ab...1234`) for matching keys to scripts, and a scope: `chat` (data plane only, the default) or `full` (acts fully as the owner). A key is its owner: blocking the user disables their keys on the next request.

## Code execution (beta)

Runs inside [microsandbox](https://github.com/microsandbox/microsandbox) microVMs: hardware isolation (libkrun/KVM). Each chat conversation gets a persistent workspace VM whose files survive across turns (idle VMs are stopped after 20 minutes and resume in ~300ms; the workspace is removed with its conversation). The assistant loads warehouse data with `sandboxLoadData` (read-only SQL as the requesting user, up to 20k rows written server-side into a workspace file, so datasets never pass through the model), then writes, delta-edits, and executes scripts with the file tools. Stateless `/v1` calls use `runPython` in a disposable VM instead. The sandbox image (`deploy/sandbox/Dockerfile`) preinstalls the Python analysis stack and the [basalt](https://github.com/leonardomb1/basalt) binary for columnar SQL over files.

Requirements: the admin toggle in Capacidades, and `/dev/kvm` access for the app container (see `docker-compose.yml`), or the microsandbox cloud backend via `MSB_API_KEY`. The image is pulled and one VM is boot-tested in the background on server start and on toggle-on, so user runs get warm boots (about 300ms) instead of the one-time image pull. Configure with `MSB_IMAGE`, `MSB_MEMORY_MIB`, `MSB_CPUS`, `MSB_TIMEOUT_MS`.

## Observability

- **Audit log**: first-party, in the console (Auditoria); see above.
- **Sentry** (`@sentry/sveltekit` with the Vercel AI SDK integration): per-agent traces, errors, MCP monitoring. DSN-gated and disabled in dev unless `SENTRY_DEV=1`. PII capture is off; prompts carry warehouse rows and personal context that must not leave.

## State layout (`DATA_DIR`, default `./data`)

`conversations/<user>/`, `settings/<user>.json` (MCP tokens AES-encrypted at rest), `rag/<user>.json` plus `rag/_shared/{org,dept-*}.json`, `memory/<user>.json`, `usage/<user>.json`, `apikeys/<user>.json` (hashes only), `audit/<month>.jsonl`, `access.json` (users, policies, capabilities, knowledge), `exports/` (7-day, behind authenticated `/api/exports`), and `schema.json` (synced warehouse catalog).

## Setup

1. **Env**: copy `.env.example` to `.env` and fill in the Foundry (or Anthropic) key, `JWT_SECRET`, StarRocks, and at least one sign-in door (`OIDC_*` or `LDAP_*`). Set `ADMIN_USERS` to your bootstrap admin(s).
2. **Users**: none to create. Anyone who authenticates can sign in while in open mode; add policies or user records to gate access. StarRocks grants govern what each user can read.
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

- **Docker**: `adapter-node`; `docker-compose.yml` uses `env_file: .env`, listens on `0.0.0.0:3000`, and keeps state in the `perguntai-data` named volume. CI builds `ghcr.io/<owner>/perguntai` on app-code pushes to main (`.github/workflows/docker.yml`); on the server `docker compose pull && docker compose up -d`.
- **Sandbox image**: `.github/workflows/sandbox-image.yml` builds `ghcr.io/<owner>/perguntai-sandbox` when `deploy/sandbox/` changes, or on demand with a version tag. Pin that tag in `MSB_IMAGE`; make the package public so the microsandbox SDK pulls it without credentials. The compose file carries the `/dev/kvm` device and the `msbcache` volume the feature needs.
- **Schema sync in production**: an external cron POSTs `/api/admin/sync-schema` with `Authorization: Bearer $SCHEMA_SYNC_TOKEN`, or run `docker compose exec perguntai node scripts/sync-schema.js`.
- **Kubernetes (target)**: a starter Helm chart lives in `deploy/helm/perguntai/`; it assumes migration off the local-filesystem store. See the chart's `NOTES.txt`.

## Commands

| Command | |
| --- | --- |
| `npm run dev` | dev server |
| `npm run build` / `npm run preview` | production build / preview |
| `npm run check` | svelte-check + TypeScript |
| `npm run sync-schema` | regenerate `schema.json` from StarRocks |
| `npm run lint` / `npm run format` | prettier |
