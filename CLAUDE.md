# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

This is a minimal POC of a **resumable durable AI chat** built on **Vercel AI SDK v6** + **Vercel Workflow DevKit (WDK)**. It is intentionally tiny — every file has a job, no extra layers. Treat the README and the doc URLs below as the source of truth; do not invent patterns.

## Commands

```bash
# infra
bun run db:up         # start local Postgres 16 on :5440 (Docker compose)
bun run db:down

# one-time setup (after db:up, after editing .env)
bun run wdk:setup     # creates workflow.* schema in pg-world
                      # NOTE: this is `bash -c 'set -a; source .env; set +a; …'`
                      # because the WDK CLI's dotenv only loads .env, and bun
                      # does NOT propagate .env into spawned node bins.
bun run db:init       # creates app tables (notes)

# dev
bun run dev           # next dev on http://localhost:3010
bun run build
bun run start
```

There is **no test suite**. Verification is interactive:

1. Send a message → assistant streams, tool parts render, `reasoning` parts render, status returns to `idle`.
2. Send a long message → refresh mid-stream → tokens continue arriving.
3. Send a long message → `Ctrl-C` dev → restart → refresh → worker picks the run back up from the Postgres journal.

## Architecture (the whole picture, in one read)

```
Browser                            Next.js server                       Postgres (workflow world + journal)
─────────                          ──────────────                       ─────────────────────────────────
useChat({ resume })   ──POST──►   /api/chat                ──start()──►  workflow_runs row
WorkflowChatTransport              start(chatWorkflow, [{messages}])     workflow_steps cache (per "use step")
  • saves runId in     ◄──SSE──   createUIMessageStreamResponse({       workflow_run_events (the resumable
    localStorage                    stream: run.readable,                 stream chunks — this is what
  • on refresh                      headers: {'x-workflow-run-id': id}    survives the server restart)
    GET /api/chat/    ──reconnect──►/api/chat/[id]/stream
    [id]/stream                    getRun(id).getReadable({startIndex})
                                   createUIMessageStreamResponse({…})
```

**One workflow run = one chat turn.** The workflow body is `"use workflow"`. It receives the full `UIMessage[]`, converts to `ModelMessage[]`, instantiates `DurableAgent`, and calls `agent.stream({ messages, writable: getWritable<UIMessageChunk>() })`. Tools' `execute` functions call `"use step"` helpers (`getWeatherStep`, `getTimeStep`) so they are journaled and idempotent on replay.

**Resume mechanism.** `WorkflowChatTransport` (from `@workflow/ai`) saves the workflow run id in `localStorage`. On page refresh, `useChat({ resume: true })` calls `prepareReconnectToStreamRequest` which returns `/api/chat/{runId}/stream`. The GET handler does `getRun(runId).getReadable({ startIndex })` — WDK replays journaled chunks from Postgres while live chunks continue. Survives server restart because `instrumentation.ts` reboots the world on next start and the in-flight workflow picks up at the last completed step.

## Rules — do not break these

These cost real time to debug. Every one of them comes from a failure mode hit during initial bring-up.

1. **`DurableAgent({ model: "provider/model-id" })` — pass a STRING, not `gateway(...)`.**
   Eager `gateway()` returns a `LanguageModelV3` whose `supportedUrls` contains RegExps. The workflow tries to journal it and fails with `SerializationError: problematicValue {"modelId":...,"supportedUrls":{"*/*":[{}]}}`. The string form lets the agent build the client inside a step.
   → `workflows/chat.ts`

2. **`@workflow/world-vercel` must be pinned to `5.0.0-beta.21` or newer.**
   `@workflow/core/runtime/world.js` does `import { createVercelWorld } from '@workflow/world-vercel'` at the TOP LEVEL. So even when `WORKFLOW_TARGET_WORLD=@workflow/world-postgres`, the world-vercel module is loaded. Versions ≤ `5.0.0-beta.18` ship a nested `zod@4.3.6` whose `union()` init throws `Cannot read properties of undefined (reading 'run')` — and the whole runtime fails to load. We pin via `overrides` + `resolutions` in `package.json`.

3. **Env file lives in `.env`, not `.env.local`.**
   The WDK CLI (`workflow-postgres-setup`) uses dotenv on `.env`. Bun's `bun run` does not propagate `.env.local` into spawned node bins. Keeping one file (`.env`) means every tool reads the same source — Next.js, Bun, dotenv, and bash. `.gitignore` covers it.

4. **`next.config.ts` is `export default withWorkflow(nextConfig);` and nothing else.**
   Adding `serverExternalPackages: ['workflow', '@workflow/core', ...]` makes Turbopack mangle dynamic external imports — the runtime fails with `Failed to load external module workflow-e7eb939c4250af55/runtime: Cannot read properties of undefined (reading 'run')`. The plugin handles externalization itself.

5. **`instrumentation.ts` uses the canonical `await import("workflow/runtime")`.**
   Do NOT switch to `createRequire(import.meta.url)` — it returns a shape that doesn't expose `getWorld` correctly. The official pattern works once rule #2 is satisfied.

6. **`tsconfig.json` plugins must include BOTH `{ "name": "next" }` and `{ "name": "workflow" }`.**
   The workflow plugin is the SWC transform that activates `"use workflow"` and `"use step"` directives.

7. **On resume, trim the in-progress assistant message before useChat mounts.**
   `app/page.tsx` does `useChatInitial = initialMessages.slice(0, -1)` when there's an active runId. The journal replays from chunk 0 and rebuilds the assistant from scratch. Without the trim → `Cannot read properties of undefined (reading 'text')` because a text-delta arrives for a part that's not freshly initialised.

8. **`initialStartIndex: 0` on `WorkflowChatTransport` (the default).**
   Negative values (`-N`) would skip the replay flicker but useChat does not currently apply orphan text-deltas to pre-existing parts on a fresh page mount, so we accept the redraw. This is the only documented limitation of the POC.

9. **POST `/api/chat`: `createUIMessageStreamResponse({ stream: run.readable, headers: { 'x-workflow-run-id': run.runId } })`.**
   - `run.readable` is a **property**, not `run.getReadable()` (which is a method used by the GET handler).
   - `createUIMessageStreamResponse` is what encodes UIMessageChunk objects to SSE bytes — returning `run.readable` directly to `new Response()` errors with `ERR_INVALID_ARG_TYPE: chunk must be string|Buffer|Uint8Array`.

10. **GET `/api/chat/[id]/stream`: send `x-workflow-stream-tail-index` header.**
    `WorkflowChatTransport` uses this to compute absolute positions for in-flight retries inside one reconnection. Missing the header degrades retries to full replay and logs a warning.

11. **No `--no-verify`, no `git add -A`, no force-push.** Stage by name. POC, but standard hygiene.

## Tools

Eight are wired up in [workflows/chat.ts](workflows/chat.ts). Each tool's `execute` calls a `"use step"` async function so its result is journaled per call and cached on replay.

| Tool | Step does | Backed by |
|---|---|---|
| `get_weather(city)` | Open-Meteo geocoding → forecast | https://open-meteo.com (free, no key) |
| `get_time(timezone)` | `Intl.DateTimeFormat` on an IANA tz | stdlib |
| `calculate(expression)` | `mathjs.evaluate` | `mathjs` |
| `fetch_url(url)` | `fetch()` with 8KB cap + UA header | any http(s) |
| `search_wikipedia(query)` | `opensearch` → `page/summary` | en.wikipedia.org |
| `save_note(title, body)` | INSERT into `notes` | local Postgres |
| `list_notes()` | SELECT last 50 | local Postgres |
| `read_note(id)` | SELECT by id | local Postgres |

**Adding a tool:**
1. Write the step: `async function fooStep(...) { "use step"; /* IO */ return {...}; }`. The `"use step"` directive MUST be the first statement of the function body, before any await/import.
2. Wrap with `tool({ description, inputSchema: z.object({...}), execute })` and register under `tools: {...}` in `chatWorkflow`.
3. Add a one-line entry to the `instructions` block of `DurableAgent` so the model knows it exists.
4. For DB-backed steps, put the pg query in [lib/db.ts](lib/db.ts) and `await import("@/lib/db")` from inside the step.

**Why steps for tools?** The agent's stream replay needs deterministic IO. Without `"use step"`, a tool's `fetch()` would re-run on every replay (re-billing, re-mutating). With it, the result is stored in `workflow_steps` and returned from cache.

## Sources of truth (consult before guessing)

- **Workflow DevKit docs index**: https://workflow-sdk.dev/docs
  - Next.js setup: https://workflow-sdk.dev/docs/getting-started/next
  - Postgres world: https://workflow-sdk.dev/worlds/postgres
  - Resumable streams: https://workflow-sdk.dev/docs/ai/resumable-streams
  - DurableAgent API: https://workflow-sdk.dev/docs/api-reference/workflow-ai/durable-agent
  - WorkflowChatTransport API: https://workflow-sdk.dev/docs/api-reference/workflow-ai/workflow-chat-transport
  - Defining tools: https://workflow-sdk.dev/docs/ai/defining-tools
  - Streaming foundations: https://workflow-sdk.dev/docs/foundations/streaming
  - Sitemap: https://workflow-sdk.dev/sitemap.md
- **AI SDK v6 docs**: https://ai-sdk.dev/docs
  - useChat resume pattern: https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-resume-streams
  - Message persistence: https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-message-persistence

When debugging, prefer reading the installed package source over training-data recall:

```bash
# Verify exported symbols (these surprised us during this build)
grep -rE 'export.*\{.*getWorld' node_modules/@workflow/core/dist/runtime.js
cat node_modules/@workflow/ai/dist/workflow-chat-transport.d.ts
```

## Versions known to work

```
ai@6.0.213
@ai-sdk/react@2.0.208
@workflow/ai@5.0.0-beta.11
@workflow/world-postgres@5.0.0-beta.17
@workflow/world-vercel@5.0.0-beta.21   ← pinned override; do not downgrade
workflow@5.0.0-beta.19
next@16.2.9
mathjs@14.9.1
pg@8.x
node 22.x
```

If you bump WDK packages, re-verify rules #1, #2, #5, #7 — the failure modes were package-version-specific.
