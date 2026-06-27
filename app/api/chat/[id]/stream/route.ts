import { createUIMessageStreamResponse } from "ai";
import { getRun } from "workflow/api";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: runId } = await params;
  const url = new URL(request.url);
  const startIndexParam = url.searchParams.get("startIndex");
  const startIndex = startIndexParam ? parseInt(startIndexParam, 10) : 0;

  const run = getRun(runId);
  const tailIndex = await run.getReadable().getTailIndex();
  const readable = run.getReadable({ startIndex });

  return createUIMessageStreamResponse({
    stream: readable,
    headers: {
      "x-workflow-stream-tail-index": String(tailIndex),
    },
  });
}
