// Pi 扩展入口：中英互转省 token 翻译层
//
// 工作流程：
//   1. 用户输入中文  →  pi.on("input")            → 翻译成英文，transform 后发给模型
//   2. 模型推理前    →  pi.on("before_agent_start") → 注入 systemPrompt 引导模型始终用英文
//   3. 模型输出完成  →  pi.on("message_end")       → 翻译 assistant 英文回复为中文，写进 session
//
// 参考实现：
//   - input-transform.ts           (input 事件 transform 用法)
//   - prompt-customizer.ts         (before_agent_start 改 systemPromptOptions)
//   - context-projection (第三方)  (嵌套 LLM 调用 + ctx.modelRegistry 用法)
//   - answer (第三方)              (complete() 调用模板)
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { translateZhToEn, translateEnToZh, clearTranslationCache, type TranslateAuth } from "./translate.ts";

// 翻译用的模型，可通过环境变量 TRANSLATE_MODEL 覆盖
const DEFAULT_TRANSLATE_MODEL = "anthropic/claude-haiku-4-5";

// 引导主模型始终用英文回复的 system prompt 片段
const SYSTEM_PROMPT_HINT = [
  "IMPORTANT — Translation Layer Active:",
  "The user types in Chinese, but a translation layer converts all user input to English before it reaches you.",
  "You MUST:",
  "1. Always respond in English (the layer will translate your reply back to Chinese for the user).",
  "2. Always reason, write code, and write comments in English unless the user explicitly asks for Chinese.",
  "3. Do not mention the translation layer or apologize for language — just respond naturally in English.",
].join("\n");

interface ModelLike {
  id: string;
  provider?: string;
}

interface ModelRegistryLike {
  find?: (modelId: string) => ModelLike | Promise<ModelLike>;
  getRequestAuth?: (model: ModelLike) => TranslateAuth | Promise<TranslateAuth>;
}

export default function (pi: ExtensionAPI) {
  // 运行时开关，初始值由 --translate / --no-translate flag 决定
  let enabled = true;

  // 1. CLI flag：`pi --no-translate` 临时关闭
  pi.registerFlag("translate", {
    description: "Enable Chinese-English translation layer (default: true)",
    type: "boolean",
    default: true,
  });

  // 2. /translate 命令：运行时切换 + 清缓存
  //    用法：/translate on | /translate off | /translate (toggle)
  pi.registerCommand("translate", {
    description: "Toggle the Chinese-English translation layer on/off (args: on|off|clear)",
    handler: async (args, ctx) => {
      const arg = (args || "").trim().toLowerCase();
      if (arg === "off" || arg === "disable") {
        enabled = false;
        ctx.ui.notify("Translation: OFF", "info");
      } else if (arg === "on" || arg === "enable") {
        enabled = true;
        ctx.ui.notify("Translation: ON", "info");
      } else if (arg === "clear") {
        clearTranslationCache();
        ctx.ui.notify("Translation cache cleared", "info");
      } else {
        enabled = !enabled;
        ctx.ui.notify(`Translation: ${enabled ? "ON" : "OFF"}`, "info");
      }
    },
  });

  // 3. 拦截用户输入：中文 → 英文
  pi.on("input", async (event: any, ctx: ExtensionContext) => {
    if (!enabled) return;
    // 跳过 steering 期间（要低延迟）
    if (event.streamingBehavior === "steer") return;

    const text = event.text;
    if (typeof text !== "string" || !text.trim()) return;

    try {
      const model = await resolveTranslateModel(ctx);
      const auth = await resolveAuth(ctx, model);
      const translated = await translateZhToEn(text, model, {
        signal: (ctx as any).signal,
        auth,
      });

      if (translated && translated !== text) {
        const preview = translated.length > 60 ? translated.slice(0, 60) + "…" : translated;
        ctx.ui.setStatus?.(`zh→en: ${preview}`, "info");
        return { action: "transform", text: translated };
      }
    } catch (err) {
      ctx.ui.notify(
        `Translation failed (input passthrough): ${(err as Error).message}`,
        "warn",
      );
    }
  });

  // 4. 注入 systemPrompt 引导主模型始终用英文回复
  pi.on("before_agent_start", async (event: any, _ctx: ExtensionContext) => {
    if (!enabled) return;
    if (!event || !event.systemPromptOptions) return;
    const opts = event.systemPromptOptions;
    opts.extraRules = Array.isArray(opts.extraRules) ? opts.extraRules : [];
    opts.extraRules.push(SYSTEM_PROMPT_HINT);
  });

  // 5. 拦截模型输出：英文 → 中文
  pi.on("message_end", async (event: any, ctx: ExtensionContext) => {
    if (!enabled) return;
    const message = event?.message;
    if (!message || message.role !== "assistant") return;

    // 只翻译正常停止的消息，避免半截/出错的消息被翻译
    const stopReason = event.stopReason;
    if (
      stopReason &&
      stopReason !== "stop" &&
      stopReason !== "end_turn" &&
      stopReason !== "max_tokens"
    ) {
      return;
    }

    const content = Array.isArray(message.content) ? message.content : [];
    if (content.length === 0) return;

    let changed = false;
    const newContent = await Promise.all(
      content.map(async (part: any) => {
        // 只翻译 text part；tool_use / thinking / 其他 part 原样保留
        if (!part || part.type !== "text") return part;
        const text = typeof part.text === "string" ? part.text : "";
        if (!text.trim()) return part;

        try {
          const model = await resolveTranslateModel(ctx);
          const auth = await resolveAuth(ctx, model);
          const translated = await translateEnToZh(text, model, {
            signal: (ctx as any).signal,
            auth,
          });
          if (translated && translated !== text) {
            changed = true;
            return { ...part, text: translated };
          }
        } catch (err) {
          ctx.ui.notify(
            `Translation failed (output passthrough): ${(err as Error).message}`,
            "warn",
          );
        }
        return part;
      }),
    );

    if (changed) {
      return { message: { ...message, content: newContent } };
    }
  });
}

// ---- helpers ----

async function resolveTranslateModel(ctx: ExtensionContext): Promise<ModelLike> {
  const modelName = process.env.TRANSLATE_MODEL || DEFAULT_TRANSLATE_MODEL;
  const registry = (ctx as any).modelRegistry as ModelRegistryLike | undefined;
  if (registry?.find) {
    const model = await registry.find(modelName);
    if (model) return model;
  }
  // 兜底：返回一个最小 model 对象，complete() 会用默认 provider
  return { id: modelName };
}

async function resolveAuth(ctx: ExtensionContext, model: ModelLike): Promise<TranslateAuth> {
  const registry = (ctx as any).modelRegistry as ModelRegistryLike | undefined;
  if (registry?.getRequestAuth) {
    try {
      return await registry.getRequestAuth(model);
    } catch {
      // 落到环境变量兜底
    }
  }
  return {
    apiKey:
      process.env.TRANSLATE_API_KEY ||
      process.env.ANTHROPIC_API_KEY ||
      process.env.OPENAI_API_KEY,
  };
}
