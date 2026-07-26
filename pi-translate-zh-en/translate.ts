// 翻译模块：用 pi-ai 的 completeSimple() 调一个轻量模型做英→中翻译。
// 参考了 pi-prompt-translate 的调用模式：reasoning:"low" + 复用 Pi 的 modelRegistry 拿 auth。
import { completeSimple, type Model, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { LRUCache } from "./cache.ts";

// 仅做英→中方向，LRU 缓存避免重复翻译相同回复
const en2zhCache = new LRUCache<string, string>(256);

export interface TranslateAuth {
  apiKey?: string;
  headers?: Record<string, string>;
}

export interface TranslateOptions {
  signal?: AbortSignal;
  auth?: TranslateAuth;
}

const EN2ZH_SYSTEM_PROMPT =
  "Translate the following assistant message to Simplified Chinese (简体中文). " +
  "Preserve all code blocks, file paths, variable names, command names, URLs, and technical terms exactly. " +
  "Only translate natural language portions. " +
  "Do NOT add explanations, thinking, or commentary. " +
  "Output ONLY the translated text.";

/**
 * 英文 → 中文。空文本原样返回。
 * 用 reasoning:"low" 跳过推理过程，省翻译本身的 token。
 */
export async function translateEnToZh(
  text: string,
  model: Model,
  options: TranslateOptions = {},
): Promise<string> {
  if (!text || !text.trim()) return text;

  const cached = en2zhCache.get(text);
  if (cached) return cached;

  const response = await completeSimple(
    model,
    {
      systemPrompt: EN2ZH_SYSTEM_PROMPT,
      messages: [
        {
          role: "user" as const,
          content: text,
          timestamp: Date.now(),
        },
      ],
    },
    {
      reasoning: "low",
      ...(options.auth?.apiKey ? { apiKey: options.auth.apiKey } : {}),
      ...(options.auth?.headers ? { headers: options.auth.headers } : {}),
      signal: options.signal,
    } as SimpleStreamOptions,
  );

  if (response.errorMessage) {
    throw new Error(response.errorMessage);
  }

  let translated = "";
  for (const item of response.content) {
    if (item.type === "text") {
      translated += item.text;
    }
  }

  const trimmed = translated.trim();
  const result = trimmed.length > 0 ? trimmed : text;
  en2zhCache.set(text, result);
  return result;
}

export function clearTranslationCache(): void {
  en2zhCache.clear();
}
