// 翻译模块：用 pi-ai 的 complete() 调一个轻量模型做中英互译。
// 参考 jayshah5696/pi-agent-extensions/extensions/answer/index.ts 的嵌套 LLM 调用模式。
import { complete, type Model, type Api } from "@earendil-works/pi-ai/compat";
import { isMostlyChinese } from "./language-detector.ts";
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

const ZH2EN_SYSTEM_PROMPT =
  "You are a precise translator. Translate the user's Chinese text into natural, idiomatic English. " +
  "Output ONLY the translation—no explanations, no quotes, no preamble. " +
  "Preserve code blocks, URLs, file paths, command names, and technical terms verbatim. " +
  "If the input is already mostly English or is pure code, return it unchanged.";

const EN2ZH_SYSTEM_PROMPT =
  "You are a precise translator. Translate the user's English text into natural, fluent Simplified Chinese (简体中文). " +
  "Output ONLY the translation—no explanations, no quotes, no preamble. " +
  "Preserve code blocks, URLs, file paths, command names, and technical terms verbatim. " +
  "If the input is already mostly Chinese or is pure code, return it unchanged.";

/**
 * 中文 → 英文。已经是英文的文本会原样返回（不调 LLM）。
 */
export async function translateZhToEn(
  text: string,
  model: Model<Api>,
  options: TranslateOptions = {},
): Promise<string> {
  if (!text || !text.trim()) return text;
  if (!isMostlyChinese(text)) return text;
  return translateWithLLM(text, "zh2en", model, options);
}

/**
 * 英文 → 中文。空文本或纯代码会原样返回。
 */
export async function translateEnToZh(
  text: string,
  model: Model<Api>,
  options: TranslateOptions = {},
): Promise<string> {
  if (!text || !text.trim()) return text;
  return translateWithLLM(text, "en2zh", model, options);
}

async function translateWithLLM(
  text: string,
  direction: "zh2en" | "en2zh",
  model: Model<Api>,
  options: TranslateOptions,
): Promise<string> {
  const cache = direction === "zh2en" ? zh2enCache : en2zhCache;
  const cached = cache.get(text);
  if (cached) return cached;

  const systemPrompt = direction === "zh2en" ? ZH2EN_SYSTEM_PROMPT : EN2ZH_SYSTEM_PROMPT;

  const response = await complete(
    model,
    {
      systemPrompt,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text }],
          timestamp: Date.now(),
        } as const,
      ],
    },
    {
      ...(options.auth?.apiKey ? { apiKey: options.auth.apiKey } : {}),
      ...(options.auth?.headers ? { headers: options.auth.headers } : {}),
      signal: options.signal,
    },
  );

  const translated = response.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n")
    .trim();

  cache.set(text, translated);
  return translated;
}

export function clearTranslationCache(): void {
  zh2enCache.clear();
  en2zhCache.clear();
}
