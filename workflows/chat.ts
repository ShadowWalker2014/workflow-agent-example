import { convertToModelMessages, tool, type UIMessage, type UIMessageChunk } from "ai";
import { z } from "zod";
import { DurableAgent } from "@workflow/ai/agent";
import { getWritable } from "workflow";

// --- Tool steps (durable; cached on replay, journaled per run) ---

async function getWeatherStep(city: string) {
  "use step";
  const temps = [62, 68, 71, 74, 77, 80];
  const conds = ["sunny", "cloudy", "partly cloudy", "rainy"];
  const seed = [...city].reduce((a, c) => a + c.charCodeAt(0), 0);
  return {
    city,
    tempF: temps[seed % temps.length],
    condition: conds[seed % conds.length],
  };
}

async function getTimeStep(timezone: string) {
  "use step";
  try {
    const now = new Date();
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      dateStyle: "medium",
      timeStyle: "long",
    });
    return { timezone, now: fmt.format(now) };
  } catch {
    return { timezone, error: `Unknown IANA timezone: ${timezone}` };
  }
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
    instructions:
      "You are a helpful assistant with two tools: get_weather(city) and " +
      "get_time(timezone). Call them when relevant. Otherwise answer directly. " +
      "When you think step-by-step, your reasoning will be shown to the user.",
    tools: {
      get_weather: tool({
        description: "Get the current weather for a city",
        inputSchema: z.object({
          city: z.string().describe("City name, e.g. 'San Francisco'"),
        }),
        execute: async ({ city }) => await getWeatherStep(city),
      }),
      get_time: tool({
        description: "Get the current time in an IANA timezone",
        inputSchema: z.object({
          timezone: z
            .string()
            .describe("IANA timezone, e.g. 'America/Los_Angeles'"),
        }),
        execute: async ({ timezone }) => await getTimeStep(timezone),
      }),
    },
  });

  await agent.stream({
    messages: modelMessages,
    writable: getWritable<UIMessageChunk>(),
  });
}
