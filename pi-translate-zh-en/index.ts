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
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as process from "node:process";

import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
  ModelRegistry,
  ProviderConfig,
  ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  translateZhToEn,
  translateEnToZh,
  clearTranslationCache,
  type TranslateAuth,
} from "./translate.ts";
import { containsCJK } from "./cjk.ts";

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

// 输入侧翻译超时：超过这个时间还没拿到翻译结果就放行原文，避免阻塞用户输入。
const INPUT_TRANSLATE_TIMEOUT_MS = 3000;

// Windows 的权限模型和 POSIX 不一样：chmod 基本是空操作。
// 在 Windows 上跳过 chmod 相关调用，改用提示告知用户。
const isWindows = process.platform === "win32";

// DeepSeek V4-Flash 模型定义。cost 用平时价（$0.14/$0.28 per M tokens），
// cacheRead 用 $0.0028/M（缓存命中价）。单位是 $/M tokens。
const DEEPSEEK_V4_FLASH_MODEL: ProviderModelConfig = {
  id: "deepseek-v4-flash",
  name: "DeepSeek V4 Flash (翻译用)",
  reasoning: false,
  maxTokens: 8192,
  contextWindow: 1000000,
  input: ["text"],
  cost: {
    input: 0.00014,
    output: 0.00028,
    cacheRead: 0.0000028,
    cacheWrite: 0,
  },
};

// DeepSeek 官方 OpenAI 兼容端点。apiKey 由调用方传入（支持 $ENV / !command 形式）。
function buildDeepSeekProviderConfig(apiKey: string): ProviderConfig {
  return {
    baseUrl: "https://api.deepseek.com",
    apiKey,
    api: "openai-completions",
    models: [DEEPSEEK_V4_FLASH_MODEL],
  };
}

// ---- 模块级 fs/path 辅助 ----
// 把 fs/os/path 相关逻辑提到模块级，避免在函数体内 require()（ESM 不支持 require）。
function piAgentDir(): string {
  return path.join(os.homedir(), ".pi", "agent");
}
function setupMarkerPath(): string {
  return path.join(piAgentDir(), ".translate-setup-done");
}
function deepSeekKeyPath(): string {
  return path.join(piAgentDir(), ".deepseek-key");
}
function ensurePiAgentDir(): void {
  fs.mkdirSync(piAgentDir(), { recursive: true });
}

// ---- input 翻译超时控制 ----
// 翻译超过 ms 毫秒还没返回就放行 fallback（原文），不阻塞用户输入。
async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// 首次引导的内存级缓存标记。一个布尔值足够：SETUP_ENTRY_TYPE 是固定字符串。
let setupDoneInMemory = false;

export default function (pi: ExtensionAPI) {
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
      await runDeepSeekSetup(pi, ctx, { force: true });
    },
  });

  // 4. session_start：首次启动自动检测 + 引导配置 DeepSeek
  pi.on("session_start", async (_event, ctx) => {
    if (process.env.DEEPSEEK_API_KEY || process.env.TRANSLATE_API_KEY) return;
    const skip = process.env.TRANSLATE_SKIP_SETUP?.toLowerCase();
    if (skip === "false" || skip === "0" || skip === "no") return;
    if (hasSetupEntry(pi)) return;
    await runDeepSeekSetup(pi, ctx, { force: false });
  });

  // 5. 检测 pi-prompt-translate 是否已安装。如果已装，禁用输入侧避免重复翻译。
  let promptTranslateDetected: boolean | null = null;
  function isPromptTranslateInstalled(): boolean {
    if (promptTranslateDetected !== null) return promptTranslateDetected;
    try {
      const cmds = pi.getCommands();
      promptTranslateDetected = cmds.some(
        (c) => c.name.includes("translate-toggle") || c.name.includes("translate-lang"),
      );
    } catch {
      promptTranslateDetected = false;
    }
    return promptTranslateDetected;
  }

  // 6. input 事件：用户中文输入 → 翻译成英文发给模型
  pi.on("input", async (event, ctx) => {
    if (!inputEnabled) return;
    if (isPromptTranslateInstalled()) return;

    const text = typeof event?.text === "string" ? event.text : "";
    if (!text.trim()) return;
    if (!containsCJK(text)) return;

    try {
      const model = await resolveTranslateModel(ctx);
      const auth = await resolveAuth(ctx, model);
      // 翻译加超时：超过 3 秒放行原文，不阻塞用户输入。
      const translated = await withTimeout(
        translateZhToEn(text, model, { signal: ctx.signal, auth }),
        INPUT_TRANSLATE_TIMEOUT_MS,
        text,
      );
      if (translated && translated !== text) {
        return { action: "transform" as const, text: translated };
      }
    } catch (err) {
      ctx.ui.notify(
        `Input translation failed (passthrough): ${(err as Error).message}`,
        "warning",
      );
    }
  });

  // 7. before_agent_start：注入 systemPrompt 引导模型用英文回复
  // 官方 BeforeAgentStartEventResult 只支持 { message?, systemPrompt? }，
  // 要追加规则只能替换整个 systemPrompt：在原 prompt 后拼一段。
  pi.on("before_agent_start", async (event, _ctx) => {
    if (!inputEnabled) return;
    if (isPromptTranslateInstalled()) return;
    return {
      systemPrompt: `${event.systemPrompt}\n\n${ENGLISH_REPLY_SYSTEM_PROMPT}`,
    };
  });

  // 8. message_end 事件：模型英文输出 → 翻译成中文展示给用户
  pi.on("message_end", async (event, ctx) => {
    if (!outputEnabled) return;

    const message = event?.message;
    if (!message || message.role !== "assistant") return;

    // AssistantMessage.stopReason 是规范化的值：stop | length | toolUse | error | aborted。
    // 只在干净停止或长度上限上翻译；工具调用 / 错误 / 中断不翻。
    const stopReason = (message as { stopReason?: string }).stopReason;
    if (stopReason && stopReason !== "stop" && stopReason !== "length") {
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
            signal: ctx.signal,
            auth,
          });
          if (translated && translated !== text) {
            changed = true;
            return { ...part, text: translated };
          }
        } catch (err) {
          ctx.ui.notify(
            `Output translation failed (passthrough): ${(err as Error).message}`,
            "warning",
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

async function resolveTranslateModel(ctx: ExtensionContext): Promise<Model<Api>> {
  const modelName = process.env.TRANSLATE_MODEL || DEFAULT_TRANSLATE_MODEL;
  const registry = ctx.modelRegistry;

  if (modelName.includes("/")) {
    const slashIdx = modelName.indexOf("/");
    const provider = modelName.slice(0, slashIdx);
    const modelId = modelName.slice(slashIdx + 1);
    try {
      const found = registry.find(provider, modelId);
      if (found) return found;
    } catch {
      // 落到兜底
    }
  }
  if (ctx.model) return ctx.model;
  // 兜底：仅用 id 构造一个最小 Model。运行时通常用不到这条路径
  // （completeSimple 会通过 registry 重新解析），这里用 as 避免手搓 Model 全部字段。
  return { id: modelName } as Model<Api>;
}

async function resolveAuth(ctx: ExtensionContext, model: Model<Api>): Promise<TranslateAuth> {
  const registry = ctx.modelRegistry;
  try {
    const auth = await registry.getApiKeyAndHeaders(model);
    if (auth.ok) {
      return { apiKey: auth.apiKey, headers: auth.headers };
    }
  } catch {
    // 落到环境变量兜底
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

function hasSetupEntry(_pi: ExtensionAPI): boolean {
  if (setupDoneInMemory) return true;
  try {
    return fs.existsSync(setupMarkerPath());
  } catch {
    return false;
  }
}

async function markSetupDone(
  pi: ExtensionAPI,
  result: "configured" | "skipped",
): Promise<void> {
  setupDoneInMemory = true;
  try {
    pi.appendEntry(SETUP_ENTRY_TYPE, { result, ts: Date.now() });
    ensurePiAgentDir();
    fs.writeFileSync(setupMarkerPath(), JSON.stringify({ result, ts: Date.now() }), "utf8");
  } catch {
    // 持久化失败不阻塞主流程
  }
}

async function runDeepSeekSetup(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  opts: { force: boolean },
): Promise<void> {
  const ui: ExtensionUIContext = ctx.ui;
  const registry: ModelRegistry = ctx.modelRegistry;

  let alreadyConfigured = false;
  try {
    const found = registry.find("deepseek", "deepseek-v4-flash");
    alreadyConfigured = !!found;
  } catch {
    // 没找到，继续引导
  }
  if (alreadyConfigured) {
    if (opts.force) {
      ui.notify(
        "DeepSeek 已配置完毕，无需重复配置。如需更换 key，删除 ~/.pi/agent/.deepseek-key 后重启。",
        "info",
      );
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

  const wantSetup = ctx.hasUI ? await ui.confirm(title, message) : false;
  if (!wantSetup) {
    ui.notify(
      "已跳过 DeepSeek 配置。翻译将使用主模型。运行 /translate-setup 可重新配置。",
      "info",
    );
    await markSetupDone(pi, "skipped");
    return;
  }

  if (!ctx.hasUI) {
    ui.notify(
      "当前 Pi 版本不支持 input UI。请手动设置：export DEEPSEEK_API_KEY=sk-...",
      "warning",
    );
    await markSetupDone(pi, "skipped");
    return;
  }
  const userInput = await ui.input(
    "请粘贴 DeepSeek API key（sk-xxx 格式，从 platform.deepseek.com 获取）：",
    "",
  );
  const trimmedKey = (userInput || "").trim();
  if (!trimmedKey) {
    ui.notify("未输入 key，已取消配置。可随时运行 /translate-setup 重新配置。", "warning");
    await markSetupDone(pi, "skipped");
    return;
  }

  let keyFile = "";
  try {
    ensurePiAgentDir();
    keyFile = deepSeekKeyPath();
    if (isWindows) {
      // Windows 的 chmod 基本是空操作，NTFS ACL 默认仅当前用户可读，
      // 这里只写文件，不调 chmodSync（避免在某些 Windows 环境下抛异常）。
      fs.writeFileSync(keyFile, trimmedKey);
    } else {
      fs.writeFileSync(keyFile, trimmedKey, { mode: 0o600 });
      fs.chmodSync(keyFile, 0o600);
    }
  } catch (err) {
    ui.notify(`保存 key 文件失败：${(err as Error).message}`, "error");
    await markSetupDone(pi, "skipped");
    return;
  }

  try {
    // apiKey 支持 !command 形式：Pi 会执行 `cat <keyFile>` 读取真实 key。
    const readKeyCmd = `!cat "${keyFile}"`;
    pi.registerProvider("deepseek", buildDeepSeekProviderConfig(readKeyCmd));
  } catch (err) {
    ui.notify(`registerProvider 失败：${(err as Error).message}`, "error");
    await markSetupDone(pi, "skipped");
    return;
  }

  // 平台相关的权限提示：POSIX 上 chmod 600 有效，Windows 上要靠 ACL（默认就是当前用户可读）。
  const permNote = isWindows
    ? `Key 已存到 ${keyFile}。Windows 上请确认该文件未被其他用户读取（NTFS 默认 ACL 仅当前用户可读）。`
    : `Key 已存到 ${keyFile}（权限 600，仅你可读）。`;

  ui.notify(
    "✓ DeepSeek V4-Flash 已配置完成。翻译将使用 V4-Flash（比 Claude 便宜约 16 倍）。\n" +
      permNote +
      "\n下次启动不再提示。如需更换 key，删除该文件后运行 /translate-setup。",
    "info",
  );
  await markSetupDone(pi, "configured");
}
