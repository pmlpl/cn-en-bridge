// Pi 扩展入口：把 assistant 的英文输出翻译成中文。
//
// 这是一个"输出侧"翻译扩展，专门配合 pi-prompt-translate（输入侧翻译）使用：
//   - 输入侧（pi-prompt-translate）：用户中文 → 翻译成英文发给模型
//   - 输出侧（本扩展）：模型英文回复 → 翻译成中文展示给用户
//
// 主要 hook 事件：
//   - message_end：拿到 assistant 英文 message 后翻译成中文，return {message} 替换写进 session
//   - session_start：首次启动检测 DeepSeek 配置，缺失则引导用户配置 API key
//
// 其他事件都不动，避免和 pi-prompt-translate 冲突。
//
// 参考实现：
//   - pi-prompt-translate/extensions/index.ts  (completeSimple + reasoning:"low" + getApiKeyAndHeaders)
//   - Pi 官方 examples/extensions/  (message_end / session_start / registerProvider 模式)
//   - https://aliou.me/posts/custom-providers-in-pi/  (registerProvider 用法)
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { translateEnToZh, clearTranslationCache, type TranslateAuth } from "./translate.ts";

// 翻译用的默认模型：DeepSeek V4 Flash。
// 选择理由（2026-07 验证）：
//   - 价格：$0.14/$0.28 per M tokens（平时），比 Claude Haiku 4.5 ($1/$5) 便宜约 16 倍
//   - 峰谷定价：北京时间工作日 9-12、14-18 点价格翻倍，但仍比 Haiku 便宜 8 倍
//   - 缓存命中：输入仅 $0.0028/M，重复 systemPrompt 几乎零成本
//   - 质量：SWE-bench 79.0%，翻译这种语义对等任务绰绰有余
//   - 上下文：1M tokens，远超翻译所需
// 可通过环境变量 TRANSLATE_MODEL 覆盖；不设的话 fallback 到当前会话主模型
const DEFAULT_TRANSLATE_MODEL = "deepseek/deepseek-v4-flash";

// 首次引导持久化标记。appendEntry 写到 session 文件里，跨重启保留。
// 用 entry type 区分："translate-setup-done" 表示已经引导过（无论配没配）。
const SETUP_ENTRY_TYPE = "translate-setup-done";

interface ModelLike {
  id: string;
  provider?: string;
}

interface ModelRegistryLike {
  find?: (provider: string, modelId: string) => ModelLike | Promise<ModelLike>;
  getApiKeyAndHeaders?: (model: ModelLike) => TranslateAuth | Promise<TranslateAuth>;
  getRequestAuth?: (model: ModelLike) => TranslateAuth | Promise<TranslateAuth>;
}

// registerProvider 接口（参考 https://aliou.me/posts/custom-providers-in-pi/）
// DeepSeek 提供 OpenAI 兼容 + Anthropic 兼容两种 API。这里用 openai-completions。
interface ProviderModelDef {
  id: string;
  name?: string;
  reasoning?: boolean;
  maxTokens?: number;
  contextWindow?: number;
  input?: string[];
}

interface ProviderConfig {
  baseUrl: string;
  apiKey: string; // 字符串：环境变量名；或 "!cmd" 前缀：shell 命令拿 key
  api: "openai-completions" | "anthropic-messages" | string;
  models: ProviderModelDef[];
  compat?: Record<string, any>;
}

interface ExtensionAPIWithProvider extends ExtensionAPI {
  registerProvider?: (name: string, config: ProviderConfig) => void | Promise<void>;
  appendEntry?: (type: string, data?: any) => void | Promise<void>;
  events?: { emit: (event: string, data?: any) => void };
}

// DeepSeek 官方 OpenAI 兼容端点 + V4-Flash 模型定义。
// 参考 https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
const DEEPSEEK_PROVIDER_CONFIG = (apiKeyEnvName: string): ProviderConfig => ({
  baseUrl: "https://api.deepseek.com",
  apiKey: apiKeyEnvName, // 仅作为环境变量名注册，真实 key 由用户通过环境变量提供
  api: "openai-completions",
  models: [
    {
      id: "deepseek-v4-flash",
      name: "DeepSeek V4 Flash (翻译用)",
      reasoning: false, // 翻译不需要思考模式
      maxTokens: 8192,
      contextWindow: 1000000,
      input: ["text"],
    },
  ],
});

export default function (pi: ExtensionAPI) {
  const piExt = pi as ExtensionAPIWithProvider;
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

  // 3. /translate-setup 命令：手动触发 DeepSeek 配置引导（用户随时可调用）
  pi.registerCommand("translate-setup", {
    description: "Configure DeepSeek API key for translation (interactive setup)",
    handler: async (_args, ctx) => {
      await runDeepSeekSetup(piExt, ctx, { force: true });
    },
  });

  // 4. session_start：首次启动自动检测 + 引导配置 DeepSeek
  //    已引导过（session 里有 SETUP_ENTRY_TYPE entry）就跳过，避免反复打扰
  pi.on("session_start", async (_event: any, ctx: ExtensionContext) => {
    // 已配置环境变量，无需引导
    if (process.env.DEEPSEEK_API_KEY || process.env.TRANSLATE_API_KEY) return;
    // 用户显式跳过引导（环境变量设为 false / 0 / no）
    const skip = process.env.TRANSLATE_SKIP_SETUP?.toLowerCase();
    if (skip === "false" || skip === "0" || skip === "no") return;

    // 已引导过则跳过
    if (hasSetupEntry(piExt)) return;

    await runDeepSeekSetup(piExt, ctx, { force: false });
  });

  // 5. 拦截 assistant 输出：英文 → 中文
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
      process.env.DEEPSEEK_API_KEY ||
      process.env.ANTHROPIC_API_KEY ||
      process.env.OPENAI_API_KEY,
  };
}

// ---- DeepSeek 首次引导 ----

// 检查 session 里是否已有 SETUP_ENTRY_TYPE 标记（说明引导过）。
// 注意：appendEntry 的具体形态依赖 Pi 版本，这里做容错。
// 优先用 pi.events 监听，再用 appendEntry 写入。两套都没有时，退化到内存标记。
const setupDoneInMemory = new Set<string>();

function hasSetupEntry(pi: ExtensionAPIWithProvider): boolean {
  // 内存标记（每次进程启动会重置，但这是兜底，主路径靠 session 持久化）
  if (setupDoneInMemory.has(SETUP_ENTRY_TYPE)) return true;
  // appendEntry 写入的 entry 通常通过 session 文件持久化，但读取需要 session_load 事件
  // 这里我们采用更轻量的策略：把"已引导过"的标记同时也写到 ~/.pi/agent/.translate-setup-done
  // 用文件系统作为最稳定的持久化方式（避免依赖 appendEntry 的具体语义）
  try {
    const fs = require("fs");
    const os = require("os");
    const path = require("path");
    const marker = path.join(os.homedir(), ".pi", "agent", ".translate-setup-done");
    return fs.existsSync(marker);
  } catch {
    return false;
  }
}

async function markSetupDone(pi: ExtensionAPIWithProvider, result: "configured" | "skipped"): Promise<void> {
  setupDoneInMemory.add(SETUP_ENTRY_TYPE);
  try {
    // 1. 写入 appendEntry（如果可用）
    if (pi.appendEntry) {
      await pi.appendEntry(SETUP_ENTRY_TYPE, { result, ts: Date.now() });
    }
    // 2. 同时写文件标记（最稳）
    const fs = require("fs");
    const os = require("os");
    const path = require("path");
    const dir = path.join(os.homedir(), ".pi", "agent");
    fs.mkdirSync(dir, { recursive: true });
    const marker = path.join(dir, ".translate-setup-done");
    fs.writeFileSync(marker, JSON.stringify({ result, ts: Date.now() }), "utf8");
  } catch {
    // 持久化失败不阻塞主流程
  }
}

interface UILike {
  notify?: (msg: string, type?: string) => void;
  confirm?: (title: string, message: string) => Promise<boolean>;
  input?: (prompt: string, defaultValue?: string) => Promise<string | undefined>;
  setStatus?: (status: string) => void;
}

/**
 * 引导用户配置 DeepSeek API key。
 *
 * 流程：
 *   1. 检查 Pi 是否已注册 deepseek provider（registry.find 成功 = 已配）
 *   2. 弹确认框："检测到未配置 DeepSeek，是否现在配置？"
 *   3. 用户同意 → 弹输入框让用户粘贴 API key
 *   4. 把 key 写入 ~/.pi/agent/.deepseek-key（用户私有，不进 git）
 *      + 调用 registerProvider("deepseek", ...) 注册到 Pi
 *   5. 持久化"已引导过"标记
 *
 * force=true（/translate-setup 命令触发）：跳过"已引导"检查，强制走流程
 */
async function runDeepSeekSetup(
  pi: ExtensionAPIWithProvider,
  ctx: ExtensionContext,
  opts: { force: boolean },
): Promise<void> {
  const ui = (ctx as any).ui as UILike | undefined;
  if (!ui) {
    // 没有 UI 能力（比如 RPC 模式），静默跳过
    return;
  }

  // step 1：检查 Pi 已有配置
  const registry = (ctx as any).modelRegistry as ModelRegistryLike | undefined;
  let alreadyConfigured = false;
  if (registry?.find) {
    try {
      const found = await registry.find("deepseek", "deepseek-v4-flash");
      alreadyConfigured = !!found;
    } catch {
      // 没找到，继续引导
    }
  }
  if (alreadyConfigured) {
    if (opts.force) {
      ui.notify?.("DeepSeek 已配置完毕，无需重复配置。如需更换 key，删除 ~/.pi/agent/.deepseek-key 后重启。", "info");
    }
    await markSetupDone(pi, "configured");
    return;
  }

  // step 2：弹确认框
  const title = "配置 DeepSeek 翻译模型";
  const message =
    "本扩展用 DeepSeek V4-Flash 做翻译，比 Claude 便宜约 16 倍。\n" +
    "检测到尚未配置 DeepSeek API key。\n\n" +
    "现在配置吗？\n" +
    "  - 是：粘贴 API key（从 https://platform.deepseek.com 获取）\n" +
    "  - 否：翻译会 fallback 到当前主模型（不省钱但不报错）\n" +
    "       可随时运行 /translate-setup 重新配置";

  const wantSetup = ui.confirm ? await ui.confirm(title, message) : false;
  if (!wantSetup) {
    ui.notify?.(
      "已跳过 DeepSeek 配置。翻译将使用主模型。运行 /translate-setup 可重新配置。",
      "info",
    );
    await markSetupDone(pi, "skipped");
    return;
  }

  // step 3：弹输入框让用户粘贴 key
  if (!ui.input) {
    ui.notify?.("当前 Pi 版本不支持 input UI。请手动设置：export DEEPSEEK_API_KEY=sk-...", "warn");
    await markSetupDone(pi, "skipped");
    return;
  }
  const userInput = await ui.input(
    "请粘贴 DeepSeek API key（sk-xxx 格式，从 platform.deepseek.com 获取）：",
    "",
  );
  const trimmedKey = (userInput || "").trim();
  if (!trimmedKey) {
    ui.notify?.("未输入 key，已取消配置。可随时运行 /translate-setup 重新配置。", "warn");
    await markSetupDone(pi, "skipped");
    return;
  }

  // step 4：持久化 key 到 ~/.pi/agent/.deepseek-key + 注册 provider
  // key 文件权限设为 0600（仅用户可读），不进 git。
  let keyFile = "";
  try {
    const fs = require("fs");
    const os = require("os");
    const path = require("path");
    const dir = path.join(os.homedir(), ".pi", "agent");
    fs.mkdirSync(dir, { recursive: true });
    keyFile = path.join(dir, ".deepseek-key");
    fs.writeFileSync(keyFile, trimmedKey, { mode: 0o600 });
    // 显式再 chmod 一次，避免 umask 影响
    fs.chmodSync(keyFile, 0o600);
  } catch (err) {
    ui.notify?.(`保存 key 文件失败：${(err as Error).message}`, "error");
    await markSetupDone(pi, "skipped");
    return;
  }

  // 注册 provider：apiKey 字段填一个会触发读取 keyFile 的命令
  // Pi 的 provider apiKey 支持两种格式：
  //   1. 纯字符串：当作环境变量名
  //   2. "!cmd" 前缀：执行 shell 命令，stdout 作为 key
  // 我们用方式 2 直接从 keyFile 读，避免污染环境变量
  if (pi.registerProvider) {
    try {
      const readKeyCmd = `!cat "${keyFile}"`;
      const config = DEEPSEEK_PROVIDER_CONFIG(readKeyCmd);
      // 改写 apiKey 为 shell 命令（需要把 "!cat xxx" 这种格式塞进去）
      (config as any).apiKey = readKeyCmd;
      await pi.registerProvider("deepseek", config);
    } catch (err) {
      ui.notify?.(`registerProvider 失败：${(err as Error).message}`, "error");
      await markSetupDone(pi, "skipped");
      return;
    }
  } else {
    // 旧版 Pi 不支持 registerProvider，提示用户手动配环境变量
    ui.notify?.(
      "当前 Pi 版本不支持 registerProvider。请手动配置：\n" +
        `  export DEEPSEEK_API_KEY="${trimmedKey.slice(0, 8)}..."  # 完整 key 已存到 ${keyFile}\n` +
        "或把 key 加到 ~/.pi/agent/models.json 的 deepseek provider 配置里。",
      "warn",
    );
    await markSetupDone(pi, "skipped");
    return;
  }

  // step 5：完成
  ui.notify?.(
    "✓ DeepSeek V4-Flash 已配置完成。翻译将使用 V4-Flash（比 Claude 便宜约 16 倍）。\n" +
      `Key 已存到 ${keyFile}（权限 600，仅你可读）。\n` +
      "下次启动不再提示。如需更换 key，删除该文件后运行 /translate-setup。",
    "info",
  );
  await markSetupDone(pi, "configured");
}
