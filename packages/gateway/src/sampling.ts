// Text generation ("sampling") that another MCP server asks its client for.
// AnyMCP forwards it to the user's AI app when the app supports it. Otherwise, only if the user
// turned it on (`anymcp server sampling on`), it calls the Claude API with the user's own key.

import Anthropic from "@anthropic-ai/sdk";

export interface SamplingSettings {
  enabled?: boolean;
  /** Default claude-opus-5-5. */
  model?: string;
  /** Otherwise the SDK finds credentials itself (ANTHROPIC_API_KEY, `ant auth login`…). */
  apiKey?: string;
}

/** The MCP sampling/createMessage request, as far as we use it. */
export interface McpSamplingRequest {
  messages: { role: "user" | "assistant"; content: McpSamplingContent | McpSamplingContent[] }[];
  systemPrompt?: string;
  maxTokens: number;
  stopSequences?: string[];
}

type McpSamplingContent = { type: string; text?: string; data?: string; mimeType?: string };

export interface McpSamplingResult {
  role: "assistant";
  content: { type: "text"; text: string };
  model: string;
  stopReason?: string;
}

export const DEFAULT_SAMPLING_MODEL = "claude-opus-5-5";
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

function toBlocks(content: McpSamplingContent | McpSamplingContent[]): Anthropic.Beta.BetaContentBlockParam[] {
  const items = Array.isArray(content) ? content : [content];
  const blocks: Anthropic.Beta.BetaContentBlockParam[] = [];
  for (const c of items) {
    if (c.type === "text" && typeof c.text === "string") blocks.push({ type: "text", text: c.text });
    else if (c.type === "image" && c.data && c.mimeType && IMAGE_TYPES.has(c.mimeType)) {
      blocks.push({ type: "image", source: { type: "base64", media_type: c.mimeType as "image/png", data: c.data } });
    } else blocks.push({ type: "text", text: `[${c.type} content not supported here]` });
  }
  return blocks;
}

const STOP: Record<string, string> = { end_turn: "endTurn", max_tokens: "maxTokens", stop_sequence: "stopSequence", refusal: "refusal" };

export async function sampleWithClaude(req: McpSamplingRequest, settings: SamplingSettings): Promise<McpSamplingResult> {
  const client = new Anthropic(settings.apiKey ? { apiKey: settings.apiKey } : {});
  const model = settings.model ?? DEFAULT_SAMPLING_MODEL;
  // The SDK needs streaming for large outputs; MCP servers usually ask for small ones.
  const maxTokens = Math.min(Math.max(req.maxTokens || 1024, 1), 64_000);
  const stream = client.beta.messages.stream({
    model,
    max_tokens: maxTokens,
    ...(req.systemPrompt ? { system: req.systemPrompt } : {}),
    ...(req.stopSequences?.length ? { stop_sequences: req.stopSequences } : {}),
    messages: req.messages.map((m) => ({ role: m.role, content: toBlocks(m.content) })),
    // If the model declines, let the API retry on a fallback model in the same call.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
  });
  const message = await stream.finalMessage();
  const text = message.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  return {
    role: "assistant",
    content: { type: "text", text: message.stop_reason === "refusal" && !text ? "[The model declined this request.]" : text },
    model: message.model,
    stopReason: STOP[message.stop_reason ?? ""] ?? message.stop_reason ?? undefined,
  };
}
