// Pi 扩展入口：把 assistant 的英文输出翻译成中文。
//
// 这是一个"输出侧"翻译扩展，专门配合 pi-prompt-translate（输入侧翻译）使用：
//   - 输入侧（pi-prompt-translate）：用户中文 → 翻译成英文发给模型
//   - 输出侧（本扩展）：模型英文回复 → 翻译成中文展示给用户
//
// 只 hook 一个事件：message_end。拿到 assistant 英文 message 后翻译成中文，
// return {message} 替换写进 session。其他事件都不动，避免和 pi-prompt-translate 冲突。
//
// 参考实现：
//   - pi-prompt-translate/extensions/index.ts  (completeSimple + reasoning:"low" + getApiKeyAndHeaders)
//   - Pi 官方 examples/extensions/  (message_end 事件 return {message} 替换模式)
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { translateEnToZh, clearTranslationCache, type TranslateAuth } from "./translate.ts";

// 翻译用的模型，可通过环境变量 TRANSLATE_MODEL 覆盖
// 不设的话 fallback 到当前会话主模型
const DEFAULT_TRANSLATE_MODEL = "anthropic/claude-haiku-4-5";

interface ModelLike {
  id: string;
  provider?: string;
}

interface ModelRegistryLike {
  find?: (provider: string, modelId: string) => ModelLike | Promise<ModelLike>;
  getApiKeyAndHeaders?: (model: ModelLike) => TranslateAuth | Promise<TranslateAuth>;
  getRequestAuth?: (model: ModelLike) => TranslateAuth | Promise<TranslateAuth>;
}

export default function (pi: ExtensionAPI) {
  // 运行时开关
  let enabled = true;

  // 1. CLI flag：`pi --no-translate-output` 临时关闭
  pi.registerFlag("translate-output", {
    description: "Translate assistant English responses to Chinese (default: true)",
    type: "boolean",
    default: true,
  });

  // 2. /translate-output 命令：运行时切换 + 清缓存
  //    用法：/translate-output on | off | clear | (toggle)
  pi.registerCommand("translate-output", {
    description: "Toggle English→Chinese output translation on/off (args: on|off|clear)",
    handler: async (args, ctx) => {
      const arg = (args || "").trim().toLowerCase();
      if (arg === "off" || arg === "disable") {
        enabled = false;
        ctx.ui.notify("Output translation: OFF", "info");
      } else if (arg === "on" || arg === "enable") {
        enabled = true;
        ctx.ui.notify("Output translation: ON", "info");
      } else if (arg === "clear") {
        clearTranslationCache();
        ctx.ui.notify("Translation cache cleared", "info");
      } else {
        enabled = !enabled;
        ctx.ui.notify(`Output translation: ${enabled ? "ON" : "OFF"}`, "info");
      }
    },
  });

  // 3. 拦截 assistant 输出：英文 → 中文
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
        // （tool_use 是工具调用结构化数据，翻译会破坏语义；thinking 是模型内部推理，不需要给用户看）
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
            `Output translation failed (passthrough): ${(err as Error).message}`,
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

  // 兼容 pi-prompt-translate 的格式："provider/modelId"
  if (registry?.find && modelName.includes("/")) {
    const slashIdx = modelName.indexOf("/");
    const provider = modelName.slice(0, slashIdx);
    const modelId = modelName.slice(slashIdx + 1);
    try {
      const found = await registry.find(provider, modelId);
      if (found) return found;
    } catch {
      // 落到兜底
    }
  }
  // 兜底：用当前会话主模型
  const ctxModel = (ctx as any).model as ModelLike | undefined;
  if (ctxModel) return ctxModel;
  return { id: modelName };
}

async function resolveAuth(ctx: ExtensionContext, model: ModelLike): Promise<TranslateAuth> {
  const registry = (ctx as any).modelRegistry as ModelRegistryLike | undefined;
  // pi-prompt-translate 用的方法名是 getApiKeyAndHeaders
  if (registry?.getApiKeyAndHeaders) {
    try {
      return await registry.getApiKeyAndHeaders(model);
    } catch {
      // 落到环境变量兜底
    }
  }
  // 另一个可能的方法名
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
