import { convertToModelMessages, tool, type UIMessage, type UIMessageChunk } from "ai";
import { z } from "zod";
import { DurableAgent } from "@workflow/ai/agent";
import { getWritable } from "workflow";

// --- Tool steps (durable; cached on replay, journaled per run) ---

async function getTimeStep(timezone: string) {
  "use step";
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      dateStyle: "medium",
      timeStyle: "long",
    });
    return { timezone, now: fmt.format(new Date()) };
  } catch {
    return { timezone, error: `Unknown IANA timezone: ${timezone}` };
  }
}

async function getWeatherStep(city: string) {
  "use step";
  // Open-Meteo: free, no API key
  const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1`;
  const geoRes = await fetch(geoUrl);
  if (!geoRes.ok) return { city, error: `Geocoding failed: ${geoRes.status}` };
  const geo = (await geoRes.json()) as {
    results?: Array<{ latitude: number; longitude: number; country: string; name: string; admin1?: string }>;
  };
  if (!geo.results?.length) return { city, error: "City not found" };
  const place = geo.results[0];

  const wxUrl =
    `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${place.latitude}&longitude=${place.longitude}` +
    `&current=temperature_2m,wind_speed_10m,weather_code` +
    `&temperature_unit=fahrenheit&wind_speed_unit=mph`;
  const wxRes = await fetch(wxUrl);
  if (!wxRes.ok) return { city, error: `Weather fetch failed: ${wxRes.status}` };
  const wx = (await wxRes.json()) as {
    current: { temperature_2m: number; wind_speed_10m: number; weather_code: number };
  };

  return {
    place: [place.name, place.admin1, place.country].filter(Boolean).join(", "),
    tempF: wx.current.temperature_2m,
    windMph: wx.current.wind_speed_10m,
    condition: weatherCodeText(wx.current.weather_code),
  };
}

function weatherCodeText(code: number): string {
  // https://open-meteo.com/en/docs (WMO codes)
  if (code === 0) return "clear";
  if (code <= 3) return "partly cloudy";
  if (code <= 48) return "foggy";
  if (code <= 67) return "rainy";
  if (code <= 77) return "snowy";
  if (code <= 82) return "showers";
  if (code <= 99) return "thunderstorm";
  return `code ${code}`;
}

async function calculateStep(expression: string) {
  "use step";
  const { evaluate } = await import("mathjs");
  try {
    const result = evaluate(expression);
    const out =
      typeof result === "number" || typeof result === "string" || typeof result === "boolean"
        ? result
        : result?.toString?.() ?? JSON.stringify(result);
    return { expression, result: out };
  } catch (e) {
    return { expression, error: e instanceof Error ? e.message : String(e) };
  }
}

async function fetchUrlStep(url: string) {
  "use step";
  if (!/^https?:\/\//i.test(url)) {
    return { url, error: "URL must start with http:// or https://" };
  }
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "workflow-agent-example/0.1" },
    });
    const text = await res.text();
    const truncated = text.length > 8000;
    return {
      url,
      status: res.status,
      contentType: res.headers.get("content-type"),
      text: text.slice(0, 8000),
      truncated,
    };
  } catch (e) {
    return { url, error: e instanceof Error ? e.message : String(e) };
  }
}

// Wikipedia requires a User-Agent identifying the app + a contact URL or email
// per https://meta.wikimedia.org/wiki/User-Agent_policy. Generic UAs get 403/429.
const WIKI_UA =
  "workflow-agent-example/0.1 (https://github.com/ShadowWalker2014/workflow-agent-example)";

async function fetchWiki(url: string, attempt = 1): Promise<Response> {
  const res = await fetch(url, { headers: { "User-Agent": WIKI_UA, "Api-User-Agent": WIKI_UA } });
  if (res.status === 429 && attempt < 3) {
    const retryAfter = Number(res.headers.get("retry-after") ?? "1");
    await new Promise((r) => setTimeout(r, Math.max(1000, retryAfter * 1000)));
    return fetchWiki(url, attempt + 1);
  }
  return res;
}

async function searchWikipediaStep(query: string) {
  "use step";
  try {
    // Step 1: search for the page title
    const searchUrl =
      `https://en.wikipedia.org/w/api.php?action=opensearch&limit=1&namespace=0&format=json` +
      `&search=${encodeURIComponent(query)}`;
    const sRes = await fetchWiki(searchUrl);
    if (!sRes.ok) return { query, error: `Wikipedia search failed: ${sRes.status}` };
    const sJson = (await sRes.json()) as [string, string[], string[], string[]];
    if (!sJson[1]?.length) return { query, error: "No Wikipedia results" };
    const title = sJson[1][0];

    // Step 2: fetch the summary
    const sumUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(
      title.replace(/ /g, "_"),
    )}`;
    const sumRes = await fetchWiki(sumUrl);
    if (!sumRes.ok) return { query, title, error: `Wikipedia summary failed: ${sumRes.status}` };
    const sum = (await sumRes.json()) as {
      title: string;
      extract: string;
      content_urls?: { desktop?: { page?: string } };
    };
    return {
      title: sum.title,
      extract: sum.extract,
      url: sum.content_urls?.desktop?.page,
    };
  } catch (e) {
    return { query, error: e instanceof Error ? e.message : String(e) };
  }
}

async function saveNoteStep(title: string, body: string) {
  "use step";
  const { saveNote } = await import("@/lib/db");
  const id = await saveNote(title, body);
  return { id, title, saved: true };
}

async function listNotesStep() {
  "use step";
  const { listNotes } = await import("@/lib/db");
  const rows = await listNotes();
  return {
    count: rows.length,
    notes: rows.map((r) => ({
      id: r.id,
      title: r.title,
      createdAt: r.created_at.toISOString(),
    })),
  };
}

async function readNoteStep(id: number) {
  "use step";
  const { readNote } = await import("@/lib/db");
  const row = await readNote(id);
  if (!row) return { id, error: "Note not found" };
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    createdAt: row.created_at.toISOString(),
  };
}

// --- Workflow ---

export type ChatWorkflowInput = {
  messages: UIMessage[];
};

export async function chatWorkflow(input: ChatWorkflowInput) {
  "use workflow";

  const modelMessages = await convertToModelMessages(input.messages);

  const agent = new DurableAgent({
    model: "deepseek/deepseek-v4-pro",
    instructions: [
      "You are a helpful assistant with several real tools.",
      "Available tools:",
      "- get_weather(city): real current weather via Open-Meteo (free, no key)",
      "- get_time(timezone): current time in an IANA timezone (e.g. 'Europe/Paris')",
      "- calculate(expression): evaluate a math expression (mathjs syntax — arithmetic, units, sin/sqrt/log)",
      "- fetch_url(url): fetch text from a URL (first 8KB)",
      "- search_wikipedia(query): look up the top Wikipedia article and return its summary",
      "- save_note(title, body): persist a note to durable storage",
      "- list_notes(): list saved notes (id, title, created)",
      "- read_note(id): read a saved note's full body by id",
      "",
      "Call tools when relevant; otherwise answer directly.",
      "When you think step-by-step, your reasoning is shown to the user.",
    ].join("\n"),
    tools: {
      get_weather: tool({
        description:
          "Get the current weather (temperature, wind, condition) for a city using Open-Meteo.",
        inputSchema: z.object({
          city: z.string().describe("City name, e.g. 'Tokyo' or 'San Francisco'"),
        }),
        execute: async ({ city }) => await getWeatherStep(city),
      }),
      get_time: tool({
        description: "Get the current local time in an IANA timezone.",
        inputSchema: z.object({
          timezone: z.string().describe("IANA timezone, e.g. 'America/Los_Angeles'"),
        }),
        execute: async ({ timezone }) => await getTimeStep(timezone),
      }),
      calculate: tool({
        description:
          "Evaluate a math expression. Supports arithmetic, units, and functions like sin/sqrt/log (mathjs syntax).",
        inputSchema: z.object({
          expression: z.string().describe("e.g. '(12.7 * 3 + 2^10) / 5'  or  '12 inch to cm'"),
        }),
        execute: async ({ expression }) => await calculateStep(expression),
      }),
      fetch_url: tool({
        description:
          "Fetch text content from an http(s) URL. Returns up to the first 8KB of the response body.",
        inputSchema: z.object({
          url: z.string().describe("Full URL beginning with http:// or https://"),
        }),
        execute: async ({ url }) => await fetchUrlStep(url),
      }),
      search_wikipedia: tool({
        description: "Search Wikipedia and return the top article's summary + URL.",
        inputSchema: z.object({
          query: z.string().describe("e.g. 'Alan Turing' or 'pendulum clock'"),
        }),
        execute: async ({ query }) => await searchWikipediaStep(query),
      }),
      save_note: tool({
        description:
          "Persist a note (title + body) to durable storage so it can be recalled later via list_notes / read_note.",
        inputSchema: z.object({
          title: z.string().describe("Short title for the note"),
          body: z.string().describe("Note content"),
        }),
        execute: async ({ title, body }) => await saveNoteStep(title, body),
      }),
      list_notes: tool({
        description: "List all saved notes (id, title, created time). Use before read_note to find an id.",
        inputSchema: z.object({}),
        execute: async () => await listNotesStep(),
      }),
      read_note: tool({
        description: "Read a saved note's full body by id.",
        inputSchema: z.object({
          id: z.number().int().describe("Note id obtained from list_notes"),
        }),
        execute: async ({ id }) => await readNoteStep(id),
      }),
    },
  });

  await agent.stream({
    messages: modelMessages,
    writable: getWritable<UIMessageChunk>(),
  });
}
