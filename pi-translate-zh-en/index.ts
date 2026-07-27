// Pi 扩展入口：一站式中英互转省 token 翻译扩展。
//
// 工作流程：
//   用户输入中文 → [input 事件] 翻译成英文发给模型
//   模型英文推理 + 英文输出 → [message_end 事件] 翻译成中文展示给用户
//
// hook 4 个事件：
//   - input：拦截用户输入，中文 → 翻译成英文，return {action:"transform", text:英文}
//   - before_agent_start：注入 systemPrompt 引导模型始终用英文回复
//   - message_end：拦截 assistant 输出，英文 → 翻译成中文，return {message} 替换
//   - session_start：首次启动检测 DeepSeek 配置，缺失则引导用户配置 API key
//
// 兼容性：检测到 pi-prompt-translate 已安装则自动禁用输入侧 hook，避免重复翻译。
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  translateZhToEn,
  translateEnToZh,
  clearTranslationCache,
  type TranslateAuth,
} from "./translate.ts";

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
const SETUP_ENTRY_TYPE = "translate-setup-done";

// 注入给主模型的 systemPrompt，引导它始终用英文回复。
const ENGLISH_REPLY_SYSTEM_PROMPT =
  "Please respond in English by default, even if the user writes in Chinese. " +
  "Code, technical terms, and proper nouns remain in their original form. " +
  "This helps reduce token usage and improve response consistency.";

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
  apiKey: string;
  api: "openai-completions" | "anthropic-messages" | string;
  models: ProviderModelDef[];
  compat?: Record<string, any>;
}

interface ExtensionAPIWithProvider extends ExtensionAPI {
  registerProvider?: (name: string, config: ProviderConfig) => void | Promise<void>;
  appendEntry?: (type: string, data?: any) => void | Promise<void>;
  events?: { emit: (event: string, data?: any) => void };
  getRegisteredCommands?: () => string[];
}

// DeepSeek 官方 OpenAI 兼容端点 + V4-Flash 模型定义。
const DEEPSEEK_PROVIDER_CONFIG = (apiKeyEnvName: string): ProviderConfig => ({
  baseUrl: "https://api.deepseek.com",
  apiKey: apiKeyEnvName,
  api: "openai-completions",
  models: [
    {
      id: "deepseek-v4-flash",
      name: "DeepSeek V4 Flash (翻译用)",
      reasoning: false,
      maxTokens: 8192,
      contextWindow: 1000000,
      input: ["text"],
    },
  ],
});

// CJK Unicode 范围检测：判断文本是否包含中文/日文/韩文字符。
// 如果用户输入纯英文（或代码），就不需要翻译，直接放行。
function containsCJK(text: string): boolean {
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (!code) continue;
    if (code >= 0x4e00 && code <= 0x9fff) return true; // CJK 统一表意文字
    if (code >= 0x3400 && code <= 0x4dbf) return true; // CJK 扩展 A
    if (code >= 0xf900 && code <= 0xfaff) return true; // CJK 兼容表意文字
    if (code >= 0x3040 && code <= 0x30ff) return true; // 平假名 / 片假名
    if (code >= 0xac00 && code <= 0xd7af) return true; // 韩文音节
  }
  return false;
}

export default function (pi: ExtensionAPI) {
  const piExt = pi as ExtensionAPIWithProvider;

  let inputEnabled = true;
  let outputEnabled = true;

  // 1. CLI flag：`pi --no-translate` 临时关闭全部翻译
  pi.registerFlag("translate", {
    description: "Enable zh<->en translation (input + output). Default: true",
    type: "boolean",
    default: true,
  });

  // 2. /translate 命令：统一控制开关 + 清缓存
  pi.registerCommand("translate", {
    description: "Control zh<->en translation (args: on|off|input on|output off|clear|status)",
    handler: async (args, ctx) => {
      const parts = (args || "").trim().toLowerCase().split(/\s+/);
      const cmd = parts[0];
      const side = parts[1];

      if (cmd === "clear") {
        clearTranslationCache();
        ctx.ui.notify("Translation cache cleared (both directions)", "info");
        return;
      }

      if (cmd === "status") {
        ctx.ui.notify(
          `Translate status:\n` +
            `  input  : ${inputEnabled ? "ON" : "OFF"}\n` +
            `  output : ${outputEnabled ? "ON" : "OFF"}\n` +
            `  model  : ${process.env.TRANSLATE_MODEL || DEFAULT_TRANSLATE_MODEL}`,
          "info",
        );
        return;
      }

      const turnOn = cmd === "on" || (cmd === "" && (!inputEnabled || !outputEnabled));
      const turnOff = cmd === "off";

      if (side === "input") {
        inputEnabled = turnOff ? false : turnOn;
        ctx.ui.notify(`Input translation (zh→en): ${inputEnabled ? "ON" : "OFF"}`, "info");
      } else if (side === "output") {
        outputEnabled = turnOff ? false : turnOn;
        ctx.ui.notify(`Output translation (en→zh): ${outputEnabled ? "ON" : "OFF"}`, "info");
      } else {
        inputEnabled = turnOff ? false : turnOn;
        outputEnabled = turnOff ? false : turnOn;
        ctx.ui.notify(
          `Translation: ${inputEnabled && outputEnabled ? "ON" : "OFF"} (input=${inputEnabled ? "ON" : "OFF"}, output=${outputEnabled ? "ON" : "OFF"})`,
          "info",
        );
      }
    },
  });

  // 3. /translate-setup 命令：手动触发 DeepSeek 配置引导
  pi.registerCommand("translate-setup", {
    description: "Configure DeepSeek API key for translation (interactive setup)",
    handler: async (_args, ctx) => {
      await runDeepSeekSetup(piExt, ctx, { force: true });
    },
  });

  // 4. session_start：首次启动自动检测 + 引导配置 DeepSeek
  pi.on("session_start", async (_event: any, ctx: ExtensionContext) => {
    if (process.env.DEEPSEEK_API_KEY || process.env.TRANSLATE_API_KEY) return;
    const skip = process.env.TRANSLATE_SKIP_SETUP?.toLowerCase();
    if (skip === "false" || skip === "0" || skip === "no") return;
    if (hasSetupEntry(piExt)) return;
    await runDeepSeekSetup(piExt, ctx, { force: false });
  });

  // 5. 检测 pi-prompt-translate 是否已安装。如果已装，禁用输入侧避免重复翻译。
  let promptTranslateDetected: boolean | null = null;
  function isPromptTranslateInstalled(): boolean {
    if (promptTranslateDetected !== null) return promptTranslateDetected;
    try {
      const cmds = piExt.getRegisteredCommands?.();
      promptTranslateDetected = !!(cmds && cmds.some((c) => c.includes("translate-toggle") || c.includes("translate-lang")));
    } catch {
      promptTranslateDetected = false;
    }
    return promptTranslateDetected;
  }

  // 6. input 事件：用户中文输入 → 翻译成英文发给模型
  pi.on("input", async (event: any, ctx: ExtensionContext) => {
    if (!inputEnabled) return;
    if (isPromptTranslateInstalled()) return;

    const text = typeof event?.text === "string" ? event.text : "";
    if (!text.trim()) return;
    if (!containsCJK(text)) return;

    try {
      const model = await resolveTranslateModel(ctx);
      const auth = await resolveAuth(ctx, model);
      const translated = await translateZhToEn(text, model, {
        signal: (ctx as any).signal,
        auth,
      });
      if (translated && translated !== text) {
        return { action: "transform", text: translated };
      }
    } catch (err) {
      ctx.ui.notify(
        `Input translation failed (passthrough): ${(err as Error).message}`,
        "warn",
      );
    }
  });

  // 7. before_agent_start：注入 systemPrompt 引导模型用英文回复
  pi.on("before_agent_start", async (_event: any, _ctx: ExtensionContext) => {
    if (!inputEnabled) return;
    if (isPromptTranslateInstalled()) return;
    return {
      systemPromptOptions: {
        extraRules: [ENGLISH_REPLY_SYSTEM_PROMPT],
      },
    };
  });

  // 8. message_end 事件：模型英文输出 → 翻译成中文展示给用户
  pi.on("message_end", async (event: any, ctx: ExtensionContext) => {
    if (!outputEnabled) return;

    const message = event?.message;
    if (!message || message.role !== "assistant") return;

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
  const ctxModel = (ctx as any).model as ModelLike | undefined;
  if (ctxModel) return ctxModel;
  return { id: modelName };
}

async function resolveAuth(ctx: ExtensionContext, model: ModelLike): Promise<TranslateAuth> {
  const registry = (ctx as any).modelRegistry as ModelRegistryLike | undefined;
  if (registry?.getApiKeyAndHeaders) {
    try {
      return await registry.getApiKeyAndHeaders(model);
    } catch {
      // 落到环境变量兜底
    }
  }
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

const setupDoneInMemory = new Set<string>();

function hasSetupEntry(pi: ExtensionAPIWithProvider): boolean {
  if (setupDoneInMemory.has(SETUP_ENTRY_TYPE)) return true;
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
    if (pi.appendEntry) {
      await pi.appendEntry(SETUP_ENTRY_TYPE, { result, ts: Date.now() });
    }
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

async function runDeepSeekSetup(
  pi: ExtensionAPIWithProvider,
  ctx: ExtensionContext,
  opts: { force: boolean },
): Promise<void> {
  const ui = (ctx as any).ui as UILike | undefined;
  if (!ui) return;

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

  let keyFile = "";
  try {
    const fs = require("fs");
    const os = require("os");
    const path = require("path");
    const dir = path.join(os.homedir(), ".pi", "agent");
    fs.mkdirSync(dir, { recursive: true });
    keyFile = path.join(dir, ".deepseek-key");
    fs.writeFileSync(keyFile, trimmedKey, { mode: 0o600 });
    fs.chmodSync(keyFile, 0o600);
  } catch (err) {
    ui.notify?.(`保存 key 文件失败：${(err as Error).message}`, "error");
    await markSetupDone(pi, "skipped");
    return;
  }

  if (pi.registerProvider) {
    try {
      const readKeyCmd = `!cat "${keyFile}"`;
      const config = DEEPSEEK_PROVIDER_CONFIG(readKeyCmd);
      (config as any).apiKey = readKeyCmd;
      await pi.registerProvider("deepseek", config);
    } catch (err) {
      ui.notify?.(`registerProvider 失败：${(err as Error).message}`, "error");
      await markSetupDone(pi, "skipped");
      return;
    }
  } else {
    ui.notify?.(
      "当前 Pi 版本不支持 registerProvider。请手动配置：\n" +
        `  export DEEPSEEK_API_KEY="${trimmedKey.slice(0, 8)}..."  # 完整 key 已存到 ${keyFile}\n` +
        "或把 key 加到 ~/.pi/agent/models.json 的 deepseek provider 配置里。",
      "warn",
    );
    await markSetupDone(pi, "skipped");
    return;
  }

  ui.notify?.(
    "✓ DeepSeek V4-Flash 已配置完成。翻译将使用 V4-Flash（比 Claude 便宜约 16 倍）。\n" +
      `Key 已存到 ${keyFile}（权限 600，仅你可读）。\n` +
      "下次启动不再提示。如需更换 key，删除该文件后运行 /translate-setup。",
    "info",
  );
  await markSetupDone(pi, "configured");
}
