import { createUIMessageStreamResponse, type UIMessage, type UIMessageChunk } from "ai";
import { getRun, start } from "workflow/api";
import { chatMessageHook, chatWorkflow } from "@/workflows/chat";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// In-memory map from session-stable chatId → active workflow runId.
// One run hosts the whole session (multi-turn). Lost on server restart;
// for the POC that's fine — the client just starts a new session.
const chatRuns = new Map<string, string>();

type PostBody = {
  chatId: string;
  messages: UIMessage[];
};

// The session workflow keeps its writable open across turns (preventClose:true)
// so the run's underlying stream never closes by itself. For each POST we want
// to deliver exactly ONE turn's worth of chunks and then end the HTTP response,
// so useChat sees finish → status returns to "ready" → user can queue more.
function closeAfterFinish() {
  return new TransformStream<UIMessageChunk, UIMessageChunk>({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      if ((chunk as { type: string }).type === "finish") {
        controller.terminate();
      }
    },
  });
}

export async function POST(req: Request) {
  const body = (await req.json()) as PostBody;
  const { chatId, messages } = body;
  if (!chatId || !messages?.length) {
    return new Response("chatId and messages are required", { status: 400 });
  }

  const newUserMessage = messages[messages.length - 1];
  const existingRunId = chatRuns.get(chatId);

  // Continue an existing session: resume the workflow's suspended hook with
  // the new user message, then return a fresh stream that picks up at the
  // tail (i.e. only the chunks for THIS turn).
  if (existingRunId) {
    try {
      const run = getRun(existingRunId);
      const tailIndex = await run.getReadable().getTailIndex();
      await chatMessageHook.resume(`chat:${chatId}`, { message: newUserMessage });
      return createUIMessageStreamResponse({
        stream: run.getReadable({ startIndex: tailIndex + 1 }).pipeThrough(closeAfterFinish()),
        headers: {
          "x-workflow-run-id": existingRunId,
          "x-workflow-stream-tail-index": String(tailIndex),
        },
      });
    } catch (e) {
      // Run expired / missing — drop the entry and fall through to start fresh.
      console.warn("[chat] existing run unavailable, starting new session:", e);
      chatRuns.delete(chatId);
    }
  }

  // Start a fresh session workflow.
  const run = await start(chatWorkflow, [{ chatId, initialMessages: messages }]);
  chatRuns.set(chatId, run.runId);

  return createUIMessageStreamResponse({
    stream: run.readable.pipeThrough(closeAfterFinish()),
    headers: {
      "x-workflow-run-id": run.runId,
    },
  });
}
