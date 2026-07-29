// 翻译模块：用 pi-ai 的 completeSimple() 调一个轻量模型做双向翻译。
// 参考了 pi-prompt-translate 的调用模式：reasoning:"low" + 复用 Pi 的 modelRegistry 拿 auth。
//
// 两个方向各用一个 LRU 缓存：
//   - zh2enCache：用户输入中文 → 翻译成英文（输入侧，配合 input 事件）
//   - en2zhCache：模型英文回复 → 翻译成中文（输出侧，配合 message_end 事件）
import { completeSimple, type Model, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { LRUCache } from "./cache.ts";

const zh2enCache = new LRUCache<string, string>(256);
const en2zhCache = new LRUCache<string, string>(256);

export interface TranslateAuth {
  apiKey?: string;
  headers?: Record<string, string>;
}

export interface TranslateOptions {
  signal?: AbortSignal;
  auth?: TranslateAuth;
}

// 中→英：翻译用户输入。保留代码块、技术术语，只翻自然语言部分。
const ZH2EN_SYSTEM_PROMPT =
  "Translate the following user message to English. " +
  "Preserve all code blocks, file paths, variable names, command names, URLs, and technical terms exactly. " +
  "Only translate natural language portions. " +
  "Do NOT add explanations, thinking, or commentary. " +
  "Output ONLY the translated text.";

// 英→中：翻译模型回复。保留代码块、技术术语，只翻自然语言部分。
const EN2ZH_SYSTEM_PROMPT =
  "Translate the following assistant message to Simplified Chinese (简体中文). " +
  "Preserve all code blocks, file paths, variable names, command names, URLs, and technical terms exactly. " +
  "Only translate natural language portions. " +
  "Do NOT add explanations, thinking, or commentary. " +
  "Output ONLY the translated text.";

/**
 * 通用翻译函数。direction 决定 systemPrompt 和缓存。
 * 用 reasoning:"low" 跳过推理过程，省翻译本身的 token。
 */
async function translate(
  text: string,
  model: Model,
  direction: "zh2en" | "en2zh",
  options: TranslateOptions = {},
): Promise<string> {
  if (!text || !text.trim()) return text;

  const cache = direction === "zh2en" ? zh2enCache : en2zhCache;
  const systemPrompt = direction === "zh2en" ? ZH2EN_SYSTEM_PROMPT : EN2ZH_SYSTEM_PROMPT;

  const cached = cache.get(text);
  if (cached) return cached;

  const response = await completeSimple(
    model,
    {
      systemPrompt,
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
  cache.set(text, result);
  return result;
}

/** 中文 → 英文（输入侧：翻译用户输入发给模型） */
export async function translateZhToEn(
  text: string,
  model: Model,
  options: TranslateOptions = {},
): Promise<string> {
  return translate(text, model, "zh2en", options);
}

/** 英文 → 中文（输出侧：翻译模型回复展示给用户） */
export async function translateEnToZh(
  text: string,
  model: Model,
  options: TranslateOptions = {},
): Promise<string> {
  return translate(text, model, "en2zh", options);
}

/** 清空两个方向的缓存 */
export function clearTranslationCache(): void {
  zh2enCache.clear();
  en2zhCache.clear();
}
