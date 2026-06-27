"use client";

import { useChat } from "@ai-sdk/react";
import { WorkflowChatTransport } from "@workflow/ai";
import { useEffect, useMemo, useState } from "react";
import type { UIMessage } from "ai";

const CHAT_HISTORY_KEY = "chat-history";
const ACTIVE_RUN_ID_KEY = "active-workflow-run-id";

export default function Page() {
  const [hydrated, setHydrated] = useState(false);
  const [initialMessages, setInitialMessages] = useState<UIMessage[]>([]);
  const [initialRunId, setInitialRunId] = useState<string | undefined>(undefined);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(CHAT_HISTORY_KEY);
      if (saved) setInitialMessages(JSON.parse(saved) as UIMessage[]);
    } catch {
      // ignore parse errors
    }
    setInitialRunId(localStorage.getItem(ACTIVE_RUN_ID_KEY) ?? undefined);
    setHydrated(true);
  }, []);

  if (!hydrated) return <div className="app" />;

  return (
    <Chat
      key={initialRunId ?? "fresh"}
      initialMessages={initialMessages}
      initialRunId={initialRunId}
    />
  );
}

function Chat({
  initialMessages,
  initialRunId,
}: {
  initialMessages: UIMessage[];
  initialRunId: string | undefined;
}) {
  const [input, setInput] = useState("");

  // If resuming, drop the in-progress assistant message — the workflow
  // journal will replay it from the beginning. Keep all prior turns.
  const useChatInitial = useMemo(() => {
    if (!initialRunId || initialMessages.length === 0) return initialMessages;
    const last = initialMessages[initialMessages.length - 1];
    return last.role === "assistant" ? initialMessages.slice(0, -1) : initialMessages;
  }, [initialRunId, initialMessages]);

  const transport = useMemo(
    () =>
      new WorkflowChatTransport({
        api: "/api/chat",
        // Replay the workflow journal from chunk 0 on initial reconnect.
        // (We trim the in-progress assistant message before mounting useChat
        // so the replay rebuilds it cleanly. A "tail-only" resume via
        // initialStartIndex: -N would need useChat to apply orphan text-deltas
        // to existing parts, which it doesn't support on a fresh page mount —
        // so we accept the redraw in exchange for correctness.)
        initialStartIndex: 0,
        onChatSendMessage: (response, options) => {
          try {
            localStorage.setItem(
              CHAT_HISTORY_KEY,
              JSON.stringify(options.messages),
            );
          } catch {}
          const runId = response.headers.get("x-workflow-run-id");
          if (runId) localStorage.setItem(ACTIVE_RUN_ID_KEY, runId);
        },
        onChatEnd: () => {
          localStorage.removeItem(ACTIVE_RUN_ID_KEY);
        },
        prepareReconnectToStreamRequest: () => {
          const runId = localStorage.getItem(ACTIVE_RUN_ID_KEY);
          if (!runId) throw new Error("No active workflow run id");
          return { api: `/api/chat/${encodeURIComponent(runId)}/stream` };
        },
      }),
    [],
  );

  const { messages, sendMessage, status, error } = useChat({
    messages: useChatInitial,
    resume: !!initialRunId,
    transport,
  });

  // Persist messages whenever they change (covers final assistant message).
  useEffect(() => {
    if (messages.length > 0) {
      try {
        localStorage.setItem(CHAT_HISTORY_KEY, JSON.stringify(messages));
      } catch {}
    }
  }, [messages]);

  const isStreaming = status === "submitted" || status === "streaming";

  return (
    <div className="app">
      <div className="header">
        <h1>
          workflow-agent-example
          {isStreaming && <span className="status streaming">streaming</span>}
          {status === "ready" && messages.length > 0 && (
            <span className="status">idle</span>
          )}
        </h1>
        <div className="meta">
          {initialRunId ? `resume: ${initialRunId.slice(0, 8)}…` : "fresh"}
        </div>
      </div>

      {messages.length === 0 && (
        <div className="empty">
          <div>Say hello to start.</div>
          <div className="examples">
            Try:
            <code>"weather in Tokyo"</code>
            <code>"who was Ada Lovelace?"</code>
            <code>"calculate (2^10 + 17 * 3) / 5"</code>
            <code>"save a note: gym at 7pm"</code>
            <code>"what notes have I saved?"</code>
            <code>"fetch https://example.com"</code>
          </div>
        </div>
      )}

      {messages.map((m) => (
        <div key={m.id} className={`msg ${m.role}`}>
          <div className="role">{m.role}</div>
          {m.parts.map((p, i) => renderPart(p, i))}
        </div>
      ))}

      {error && (
        <div className="msg" style={{ borderColor: "#7a2a2a" }}>
          <div className="role" style={{ color: "#ff7a7a" }}>
            error
          </div>
          <div className="text">{String(error.message ?? error)}</div>
        </div>
      )}

      <div className="tools-row">
        <button
          type="button"
          onClick={() => {
            localStorage.removeItem(CHAT_HISTORY_KEY);
            localStorage.removeItem(ACTIVE_RUN_ID_KEY);
            window.location.reload();
          }}
        >
          new chat
        </button>
        <span>
          ← clears localStorage. Plain reload keeps history + reconnects to any
          active stream.
        </span>
      </div>

      <div className="composer">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const text = input.trim();
            if (!text || isStreaming) return;
            sendMessage({ text });
            setInput("");
          }}
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={isStreaming ? "streaming…" : "ask anything"}
            autoFocus
          />
          <button type="submit" disabled={isStreaming || !input.trim()}>
            send
          </button>
        </form>
      </div>
    </div>
  );
}

function renderPart(part: UIMessage["parts"][number], i: number) {
  if (part.type === "text") {
    return (
      <div key={i} className="text">
        {(part as { text: string }).text}
      </div>
    );
  }
  if (part.type === "reasoning") {
    return <Reasoning key={i} text={(part as { text: string }).text ?? ""} />;
  }
  if (part.type === "step-start") {
    return <div key={i} className="step-divider" aria-hidden />;
  }
  if (typeof part.type === "string" && part.type.startsWith("tool-")) {
    const toolName = part.type.slice("tool-".length);
    const p = part as {
      type: string;
      toolCallId?: string;
      state?:
        | "input-streaming"
        | "input-available"
        | "output-available"
        | "output-error";
      input?: unknown;
      output?: unknown;
      errorText?: string;
    };
    const label =
      p.state === "input-streaming"
        ? "calling…"
        : p.state === "input-available"
          ? "running"
          : p.state === "output-available"
            ? "done"
            : p.state === "output-error"
              ? "error"
              : "";
    return (
      <div key={i} className={`tool tool-${p.state ?? "unknown"}`}>
        <div className="tool-head">
          <span className="name">{toolName}</span>
          <span className="state">{label}</span>
        </div>
        {p.input !== undefined && (
          <pre>
            <span className="muted">input</span>{" "}
            {JSON.stringify(p.input, null, 2)}
          </pre>
        )}
        {p.state === "output-available" && p.output !== undefined && (
          <pre>
            <span className="muted">output</span>{" "}
            {JSON.stringify(p.output, null, 2)}
          </pre>
        )}
        {p.state === "output-error" && p.errorText && (
          <pre>
            <span className="muted">error</span> {p.errorText}
          </pre>
        )}
      </div>
    );
  }
  return null;
}

function Reasoning({ text }: { text: string }) {
  const [open, setOpen] = useState(true);
  return (
    <div className={`reasoning ${open ? "open" : ""}`}>
      <button
        type="button"
        className="reasoning-toggle"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="chev">{open ? "▾" : "▸"}</span>
        thinking{open ? "" : "…"}
      </button>
      {open && <div className="reasoning-body">{text}</div>}
    </div>
  );
}
