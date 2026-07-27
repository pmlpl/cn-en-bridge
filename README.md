# pi-translate-output-zh

> Pi agent 的输出侧翻译扩展：把模型英文回复自动翻译成中文展示给用户，配合 [pi-prompt-translate](https://www.npmjs.com/package/pi-prompt-translate)（输入侧）实现「用户全程中文，模型全程英文」的省 token 体验。

## 解决的痛点

### 痛点 1：中文 token 消耗是英文的 2-3 倍

主流 LLM 的 tokenizer 对中文不友好——一个汉字经常被拆成 2-3 个 token，而英文一个单词常是 1 个 token。同样一句话：

| 语言 | 示例 | 大致 token 数 |
|---|---|---|
| 中文 | 帮我写一个排序算法，要求时间复杂度 O(n log n) | 30-40 |
| 英文 | Write a sorting algorithm with O(n log n) time complexity | 15-20 |

**多轮对话时这个差距会被累积放大**——每一轮主模型都要重新读全部历史，历史是英文 vs 中文，token 消耗差距会成倍扩大。

### 痛点 2：现有方案只解决一半

官方市场的 [`pi-prompt-translate`](https://www.npmjs.com/package/pi-prompt-translate) 解决了输入侧（用户中文 → 翻译成英文发给模型），但**不翻译输出**——模型回复你看到的还是英文。用户被迫在「看英文回复」和「省 token」之间二选一。

### 痛点 3：用主模型翻译不划算

如果让 Claude Sonnet / GPT-4 这种主力模型自己翻译，翻译质量过剩、价格过高——翻译是「语义对等转换」，不需要强推理能力，应该用便宜的小模型做。

## 解决方案

```
用户输入中文
    ↓ （pi-prompt-translate 翻译）
英文 prompt 发给模型
    ↓ （模型英文推理 + 英文输出）
英文回复
    ↓ （本扩展翻译）
中文展示给用户
```

**用户全程用中文，模型全程用英文「思考」和「输出」**，token 消耗显著降低。

本扩展只负责输出侧（英→中），与 `pi-prompt-translate` 的输入侧（中→英）配对使用。两个扩展 hook 的事件**完全没有交集**，可放心共存。

## 创作思路

### 1. 只 hook 一个事件，最小侵入

只 hook `message_end`——拿到 assistant 英文 message 后调小模型翻译成中文，`return { message }` 替换写进 session。其他事件都不动，避免和 `pi-prompt-translate`（hook `input`/`message_start`/`context`）冲突。

### 2. 只翻译 text part，不破坏工具调用语义

assistant message 的 content 是数组，每个 part 有 type：
- `text` part — **翻译**（这是给用户看的内容）
- `tool_use` part — **原样保留**（工具调用结构化数据，翻译会破坏语义）
- `thinking` part — **原样保留**（模型内部推理，不需要给用户看）

### 3. 用便宜小模型做翻译，不用主模型

默认用 **DeepSeek V4-Flash**，比 Claude Haiku 4.5 便宜约 16 倍：

| 模型 | 输入 $/M | 输出 $/M | 翻译一次成本（约 50 in + 100 out tokens） |
|---|---|---|---|
| Claude Haiku 4.5 | $1.00 | $5.00 | $0.00055 |
| **DeepSeek V4-Flash（平时）** | $0.14 | $0.28 | **$0.000035**（省 16 倍） |
| DeepSeek V4-Flash（高峰段） | $0.28 | $0.56 | $0.00007（省 8 倍） |
| DeepSeek V4-Flash（缓存命中） | $0.0028 | — | $0.0000014（省 400 倍） |

V4-Flash 在 SWE-bench 拿 79.0%，对翻译这种「语义对等转换」任务能力远超所需。1M token 上下文也远超翻译所需。

### 4. `reasoning: "low"` 跳过推理，进一步省 token

翻译不需要 CoT 推理。调用 `completeSimple` 时传 `reasoning: "low"`，砍掉模型思考过程的 token 开销。

### 5. LRU 缓存避免重复翻译

重复的 assistant 回复（比如模型反复说 "Understood" / "Got it"）会命中缓存，不重复调 LLM。`pi-prompt-translate` 没有这个能力。

### 6. 首次启动引导配置 DeepSeek

默认配置 DeepSeek 需要用户自己拿 API key，对新用户不友好。本扩展在 `session_start` 事件检测 DeepSeek 是否已配置，未配置则弹确认框引导用户粘贴 API key，**全程图形化操作，零环境变量配置**。

### 7. 错误兜底原样透传

翻译失败时（网络错误 / API 限流 / key 失效）**不阻塞主流程**，原英文回复照常展示给用户，只是看不到中文翻译而已。

## 安装

### 前置要求

- [Pi agent](https://pi.dev/) ≥ 0.74（需要支持 `registerProvider`）
- 任意已配置的主模型（Claude / GPT / DeepSeek / Qwen 等均可）

### 安装本扩展

```bash
# 方式一：从 GitHub 安装（推荐，最新版本）
pi install git:https://github.com/pmlpl/cn-en-bridge.git

# 方式二：本地路径安装（开发者）
git clone https://github.com/pmlpl/cn-en-bridge.git
pi install ./cn-en-bridge/pi-translate-zh-en
```

### 配合输入侧翻译使用（推荐）

```bash
pi install npm:pi-prompt-translate                  # 输入侧：中文 → 英文
pi install git:https://github.com/pmlpl/cn-en-bridge.git  # 输出侧：英文 → 中文
```

## 使用方法

### 首次启动

启动 Pi 后，本扩展会自动检测 DeepSeek 是否已配置：

```
$ pi
```

- **已配置 DeepSeek**（环境变量 `DEEPSEEK_API_KEY` 已设，或 Pi 的 `models.json` 已有 DeepSeek provider）→ 静默跳过，直接开始翻译
- **未配置** → 弹确认框：

```
┌─ 配置 DeepSeek 翻译模型 ─────────────────────────────┐
│ 本扩展用 DeepSeek V4-Flash 做翻译，比 Claude 便宜约 16 倍。│
│ 检测到尚未配置 DeepSeek API key。                      │
│                                                       │
│ 现在配置吗？                                           │
│   - 是：粘贴 API key（从 https://platform.deepseek.com 获取）│
│   - 否：翻译会 fallback 到当前主模型（不省钱但不报错）    │
│        可随时运行 /translate-setup 重新配置              │
└──────────────────────────────────────────────────────┘
   ← 是     否 →
```

选「是」→ 弹输入框粘贴 API key → 自动保存到 `~/.pi/agent/.deepseek-key`（权限 0600）→ 注册到 Pi → 完成。

选「否」→ 翻译 fallback 到主模型，不报错。下次启动不再问。

### 日常使用

配置完成后**全自动工作**，无需任何操作：

```
你：帮我写一个快排算法
（pi-prompt-translate 把这句中文翻译成英文发给模型）
（模型用英文思考和输出）
（本扩展把英文输出翻译成中文展示）
模型：这是快速排序的 Python 实现：

```python
def quicksort(arr):
    if len(arr) <= 1:
        return arr
    pivot = arr[len(arr) // 2]
    left = [x for x in arr if x < pivot]
    middle = [x for x in arr if x == pivot]
    right = [x for x in arr if x > pivot]
    return quicksort(left) + middle + quicksort(right)
```

时间复杂度：平均 O(n log n)，最坏 O(n²)。
空间复杂度：O(n)（这个实现）。
```

### 命令参考

| 命令 | 作用 |
|---|---|
| `/translate-output` | 切换输出翻译开关（on/off 之间 toggle） |
| `/translate-output on` | 开启输出翻译 |
| `/translate-output off` | 关闭输出翻译 |
| `/translate-output clear` | 清空翻译缓存 |
| `/translate-setup` | 重新触发 DeepSeek 配置引导（更换 key 时用） |

### CLI Flag

```bash
pi --no-translate-output        # 本次会话临时关闭输出翻译
```

### 环境变量

| 变量 | 作用 | 默认值 |
|---|---|---|
| `TRANSLATE_MODEL` | 翻译用的模型（格式 `provider/modelId`） | `deepseek/deepseek-v4-flash` |
| `TRANSLATE_API_KEY` | 翻译用的 API key（优先级最高） | 不设，从 Pi 的 provider 配置读 |
| `DEEPSEEK_API_KEY` | DeepSeek API key（已配置则跳过引导） | 不设 |
| `TRANSLATE_SKIP_SETUP` | 设为 `0` / `false` / `no` 完全禁用首次引导 | 不设（允许引导） |

### 切换翻译模型

如果想用其他模型翻译，设置环境变量即可：

```bash
# 用 Claude Haiku
export TRANSLATE_MODEL="anthropic/claude-haiku-4-5"
pi

# 用 GPT-4o-mini
export TRANSLATE_MODEL="openai/gpt-4o-mini"
pi

# 用 DeepSeek V4 Pro（更高质量）
export TRANSLATE_MODEL="deepseek/deepseek-v4"
pi
```

## 工作原理

### 事件流

```
用户输入
    │
    ▼
[input 事件] ──── pi-prompt-translate 处理（中→英） ────┐
    │                                                    │
    ▼                                                    │
[before_agent_start] ── 注入英文 systemPrompt ──────────┤
    │                                                    │
    ▼                                                    │
模型推理（英文）                                          │
    │                                                    │
    ▼                                                    │
[message_end 事件] ── 本扩展处理（英→中） ◄──────────────┘
    │
    ▼
展示给用户（中文）
```

### 文件结构

```
pi-translate-zh-en/
├── package.json    # Pi 包 manifest（包名 pi-translate-output-zh）
├── index.ts        # 扩展入口：注册 message_end hook + /translate-output + /translate-setup + session_start 引导
├── translate.ts    # completeSimple(reasoning:"low") 调 LLM 翻译 + systemPrompt 约束
└── cache.ts        # LRU 缓存（256 项）
```

### 关键设计

| 设计点 | 实现 | 作用 |
|---|---|---|
| 只 hook `message_end` | `pi.on("message_end", ...)` | 与 pi-prompt-translate 事件无冲突 |
| 只翻译 `text` part | `content.map(part => part.type === "text" ? 翻译 : part)` | 不破坏 tool_use / thinking 语义 |
| `reasoning: "low"` | `completeSimple(model, ctx, { reasoning: "low" })` | 跳过推理，省翻译 token |
| LRU 缓存 | `cache.ts` 256 项 LRU | 重复回复不重复调 LLM |
| 复用 Pi auth | `ctx.modelRegistry.getApiKeyAndHeaders(model)` | 不需要单独配翻译 API key |
| 错误兜底 | `try/catch + ctx.ui.notify("passthrough")` | 翻译失败不阻塞，原英文照常展示 |
| 持久化标记 | `~/.pi/agent/.translate-setup-done` 文件 | 避免每次启动都弹引导 |
| Key 文件权限 0600 | `fs.writeFileSync(keyFile, key, { mode: 0o600 })` | 仅用户可读，不进 git |

### DeepSeek 峰谷定价注意

DeepSeek V4 正式版引入了峰谷分时计费（2026-07 中旬上线）：

- **高峰时段**：北京时间工作日 9:00-12:00、14:00-18:00，价格翻倍
- **平峰时段**：夜间、周末、节假日，原价

翻译是交互式场景，多数发生在工作日白天，**容易踩到高峰段**。但即便高峰段，V4-Flash 仍比 Haiku 便宜 8 倍，依然划算。

如果想完全避开高峰段，可以设置环境变量切换到其他模型：

```bash
# 在高峰时段用 Haiku（同样便宜，无峰谷定价）
export TRANSLATE_MODEL="anthropic/claude-haiku-4-5"
```

## FAQ

### Q: 必须装 pi-prompt-translate 吗？

**不是必须的**。本扩展可以独立工作——只翻译输出，不翻译输入。

但单独使用时体验是：用户输入中文 → 模型直接处理中文（不省钱）→ 模型英文输出 → 翻译成中文。**输入侧不省钱**。

要达到「全程省 token」效果，必须两个扩展一起装。

### Q: 不配置 DeepSeek 会怎样？

**不会报错**。翻译会 fallback 到当前主模型（比如 Claude Sonnet）。

但这样不省钱——主模型价格高，且每次翻译都要等主模型生成完才能开始，延迟更长。

### Q: 翻译会破坏代码块吗？

**不会**。systemPrompt 明确要求保留代码块、文件路径、变量名、技术术语：

```
Translate the following user message to Chinese.
Preserve all code blocks, file paths, variable names, technical terms exactly.
Only translate natural language portions.
Do NOT add explanations, thinking, or commentary.
Output ONLY the translated text.
```

### Q: 翻译失败怎么办？

**原英文回复照常展示**，并显示警告通知 `Output translation failed (passthrough): <错误原因>`。

主流程不阻塞，用户仍能看到模型的英文回复。

### Q: 如何更换 DeepSeek API key？

```bash
# 方式一：删除 key 文件，重启 Pi，会重新弹引导
rm ~/.pi/agent/.deepseek-key
rm ~/.pi/agent/.translate-setup-done
pi

# 方式二：直接用 /translate-setup 命令
pi
/translate-setup
```

### Q: 如何完全卸载？

```bash
# 1. 卸载扩展
pi uninstall pi-translate-output-zh

# 2. 清理配置文件（可选）
rm ~/.pi/agent/.deepseek-key
rm ~/.pi/agent/.translate-setup-done
```

### Q: 支持其他语言对吗？

当前只支持英→中。如果有其他语言需求，修改 [translate.ts](pi-translate-zh-en/translate.ts) 里的 `EN2ZH_SYSTEM_PROMPT` 即可。

## 开发

### 本地开发

```bash
git clone https://github.com/pmlpl/cn-en-bridge.git
cd cn-en-bridge

# 用本地路径安装到 Pi，支持热重载
pi install ./pi-translate-zh-en

# 启动 Pi，修改 index.ts 后用 /reload 热重载
pi
/reload
```

### 调试

```bash
# 启用 Pi 的 debug 模式
pi --debug

# 查看翻译调用日志
# 错误会通过 ctx.ui.notify 显示在 Pi 界面
```

## 许可证

MIT

## 致谢

- [pi-prompt-translate](https://github.com/Veucci/pi-prompt-translate) by Veucci — 输入侧翻译的参考实现
- [Pi mono](https://github.com/badlogic/pi-mono) by Mario Zechner — Pi agent 本体
- [Custom providers in Pi](https://aliou.me/posts/custom-providers-in-pi/) by Aliou — registerProvider 用法参考

## 相关项目

- [pi-prompt-translate](https://www.npmjs.com/package/pi-prompt-translate) — 输入侧翻译（中文→英文），与本扩展配对使用
- [pi-tool-i18n](https://www.npmjs.com/package/pi-tool-i18n) — 翻译工具 schema 描述（不同场景）
- [pi-lean-ctx](https://www.jsdelivr.com/package/npm/pi-lean-ctx) — 压缩 bash/read/grep 输出省 token
