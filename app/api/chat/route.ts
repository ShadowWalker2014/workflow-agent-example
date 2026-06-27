import { createUIMessageStreamResponse, type UIMessage } from "ai";
import { start } from "workflow/api";
import { chatWorkflow } from "@/workflows/chat";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request) {
  const body = (await req.json()) as { messages: UIMessage[] };
  const messages = body.messages ?? [];

  const run = await start(chatWorkflow, [{ messages }]);

  return createUIMessageStreamResponse({
    stream: run.readable,
    headers: {
      "x-workflow-run-id": run.runId,
    },
  });
}
