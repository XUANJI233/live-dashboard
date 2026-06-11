import type {
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  LanguageModelV3Message,
  LanguageModelV3Middleware,
} from "@ai-sdk/provider";
import { logAiDebug } from "./ai-debug";

const WARMUP_USER_MESSAGE =
  "请只确认已经读取并理解以上上下文，回复严格 JSON：{\"status\":\"CONTEXT_READY\"}。不要生成总结、规则或监督结论。";
const WARMUP_ASSISTANT_MESSAGE = "{\"status\":\"CONTEXT_READY\"}";

export function deepSeekCachePrimingMiddleware(options: {
  model: string;
  warmupMaxTokens?: number;
}): LanguageModelV3Middleware {
  return {
    specificationVersion: "v3",
    async wrapGenerate({ doGenerate, params, model }) {
      const split = splitFinalUserMessage(params.prompt);
      if (!split) return doGenerate();

      // DeepSeek cache is automatic; this does not set cacheControl, TTL, or cache write options.
      let assistantContent = WARMUP_ASSISTANT_MESSAGE;
      try {
        const warmup = await model.doGenerate({
          ...params,
          prompt: [...split.context, userTextMessage(WARMUP_USER_MESSAGE)],
          responseFormat: { type: "text" },
          maxOutputTokens: options.warmupMaxTokens ?? 32,
          temperature: 0,
        });
        assistantContent = warmupAssistantContent(textFromGenerateResult(warmup));
      } catch (e) {
        logAiDebug("chat.cache_warmup_failed", {
          model: options.model,
          error: safeErrorMessage(e),
        });
        return doGenerate();
      }

      return model.doGenerate({
        ...params,
        prompt: [
          ...split.context,
          userTextMessage(WARMUP_USER_MESSAGE),
          assistantTextMessage(assistantContent),
          split.finalUserMessage,
        ],
      });
    },
  };
}

function splitFinalUserMessage(prompt: LanguageModelV3CallOptions["prompt"]): {
  context: LanguageModelV3Message[];
  finalUserMessage: LanguageModelV3Message;
} | null {
  const finalUserMessage = prompt.at(-1);
  if (!finalUserMessage || finalUserMessage.role !== "user") return null;
  return {
    context: prompt.slice(0, -1),
    finalUserMessage,
  };
}

function userTextMessage(text: string): LanguageModelV3Message {
  return { role: "user", content: [{ type: "text", text }] };
}

function assistantTextMessage(text: string): LanguageModelV3Message {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function textFromGenerateResult(result: LanguageModelV3GenerateResult): string {
  return result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim();
}

function warmupAssistantContent(value: string): string {
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 512);
  if (!clean.includes("CONTEXT_READY")) return WARMUP_ASSISTANT_MESSAGE;
  return clean.startsWith("{") && clean.endsWith("}") ? clean : WARMUP_ASSISTANT_MESSAGE;
}

function safeErrorMessage(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value || "");
  return message.replace(/\s+/g, " ").trim().slice(0, 300) || "request failed";
}
