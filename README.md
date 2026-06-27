# workflow-agent-example

A tiny Next.js POC that mirrors the auto-engineer (blink.new) chat architecture but stripped to its core: **Vercel AI SDK `useChat`** on the frontend, **Workflow DevKit (WDK) `DurableAgent`** on the backend, multi-step tool use, and **resumable streams** that survive page refreshes, new browser tabs, and server restarts.

No auth, no Firebase, no Electric, no Redis. Just Postgres (one container) + Next.js.

---

## Architecture

```
┌──────────────────────────┐                ┌────────────────────────────┐
│  React (app/page.tsx)    │                │  Next.js app/api/chat      │
│  useChat({ id, resume })  │ ── POST ───►   │  starts a fresh workflow    │
│  DefaultChatTransport    │                │  run per turn, returns      │
│   ▲                      │ ◄── stream ──  │  run.getReadable() + x-run-id│
│   │ on mount + on refresh│                └────────────┬───────────────┘
│   │                      │                             │
│   │  GET /:chatId/stream │                             ▼
│   │ ─────────────────────┼───────────────► getRun(runId).getReadable()
└──────────────────────────┘                             │
                                                         ▼
                                             ┌───────────────────────────┐
                                             │ workflows/chat.ts          │
                                             │  "use workflow"            │
                                             │  DurableAgent.stream({     │
                                             │    model, tools, writable })│
                                             └────────────┬──────────────┘
                                                          │
                                                          ▼
                                            Postgres (single container):
                                              • WDK World journal
                                                (workflow.workflow_runs,
                                                 workflow.workflow_steps,
                                                 workflow.workflow_run_events)
                                              • chats + messages tables
                                                (chatId ↔ active_run_id)
```

**One workflow run per turn**, not a long-lived multi-turn workflow. Each user message starts a fresh run; on completion, the workflow clears `active_run_id`.

### How resume works

- **Client.** `useChat({ id: chatId, resume: true })` issues `GET /api/chat/:chatId/stream` on mount.
- **Server.** That GET looks up `chats.active_run_id` for the chat. If null → 204 (just render history). If set → `getRun(runId).getReadable({ startIndex })` — WDK replays journaled stream chunks + continues live.
- **Survives server restart.** The workflow body and step results are persisted in the Postgres World by WDK after each `"use step"`. `instrumentation.ts` boots the world on Next start; the worker picks the in-flight run back up from the journal. The client's GET reattaches as normal.

### Two tools, both durable steps

`get_weather` and `get_time` are `"use step"` async functions. Their results are journaled, so on workflow replay (after a crash) they are returned from cache — no double-call to the external world.

---

## Run it

### 1. Install deps

```bash
cd ~/Downloads/workflow-agent-example
bun install
```

(If `bun install` fails on the WDK packages, try `pnpm install` — WDK uses SWC plugin discovery that's most reliable on pnpm.)

### 2. Start Postgres

```bash
bun run db:up
```

This brings up Postgres 16 on `localhost:5440` (container name `workflow-agent-pg`).

### 3. Configure env

```bash
cp .env.example .env.local
# edit .env.local and set OPENAI_API_KEY
```

`WORKFLOW_TARGET_WORLD` and `WORKFLOW_POSTGRES_URL` are already pointed at the local Docker Postgres.

### 4. Initialize WDK world + chat tables

```bash
# create WDK schema (workflow_runs, workflow_steps, workflow_run_events, …)
bun run wdk:setup

# create our app's chats + messages tables
bun run db:init
```

### 5. Run dev

```bash
bun run dev
# open http://localhost:3010
```

---

## Try the resume contract

### A. Page refresh mid-stream

1. Send a slow-ish message: `"explain quantum entanglement in 5 paragraphs"`.
2. While the assistant is still streaming, hit Cmd-R.
3. The page reloads, `useChat` mounts with `resume: true`, fires `GET /api/chat/:chatId/stream`, the journaled prefix is replayed, and live tokens keep arriving.

### B. New tab in parallel

1. Send a slow message in tab A.
2. Open `http://localhost:3010` in tab B (same `chatId` lives in `localStorage`).
3. Tab B's `useChat` reconnects to the SAME in-flight workflow and watches it stream too.

### C. Server restart mid-stream

1. Send a slow message.
2. In another terminal, `Ctrl-C` the dev server, then `bun run dev` again.
3. Refresh the page. WDK's worker picks the workflow back up from the Postgres journal at the last completed step, and the stream resumes.

> Caveat: this only resumes properly *between* `"use step"` boundaries — if the crash interrupts a single LLM call mid-stream, that LLM call retries from the top of that step. Multi-step turns survive the crash without losing prior tool calls.

---

## File map

| Path | What it is |
|---|---|
| `app/page.tsx` | `useChat` UI with `resume: true`, tool-part rendering, `localStorage` chatId |
| `app/api/chat/route.ts` | POST: persist user msg, start fresh workflow run, return SSE + `x-run-id` |
| `app/api/chat/[id]/stream/route.ts` | GET: resolve chatId → active_run_id → `getRun().getReadable({ startIndex })` |
| `workflows/chat.ts` | `"use workflow"` body: load history (step), DurableAgent.stream w/ 2 tool steps, persist (step) |
| `lib/db.ts` | tiny pg accessor: chats, messages, active_run_id |
| `instrumentation.ts` | boots the WDK world on Next server start |
| `next.config.ts` | `withWorkflow(nextConfig)` — wires up SWC plugin + `.well-known/workflow/v1/` routes |
| `tsconfig.json` | has `{ "name": "workflow" }` plugin entry |
| `docker-compose.yml` | local Postgres 16 |
| `scripts/init-db.ts` | creates `chats` + `messages` tables |

---

## Mapping back to auto-engineer

| auto-engineer concept | POC equivalent |
|---|---|
| `WorkflowChatTransport` (custom) | `DefaultChatTransport` with `prepareSendMessagesRequest` + `prepareReconnectToStreamRequest` |
| `/api/chat-durable` POST with drain lock + queue | `/api/chat` POST with `active_run_id` CAS-style check (`getActiveRun` then `setActiveRun`) |
| `/api/chat-durable/[id]/stream` GET | `/api/chat/[id]/stream` GET — identical shape |
| `runToolStep` single dispatcher | tools call `getWeatherStep` / `getTimeStep` directly (each is its own `"use step"`) |
| BP1–BP3 tiered cache-control system prompt | plain system string (POC) |
| Credit deduction post-stream `"use step"` | omitted (POC) |
| HITL `ask_question` via `createHook` | omitted (POC) |
| pg-world Railway DB | local Docker Postgres |

The shape is intentionally identical so you can lift any layer back into auto-engineer once verified.
