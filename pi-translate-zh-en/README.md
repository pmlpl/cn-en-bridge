# pi-translate-zh-en

> Pi agent 的**一站式中英互转省 token 翻译扩展**：用户输入中文自动翻译成英文发给模型，模型英文回复自动翻译成中文展示给用户。一个包搞定输入+输出双向翻译，无需配合其他扩展。

## 解决的痛点

### 痛点 1：中文 token 消耗是英文的 2-3 倍

主流 LLM 的 tokenizer 对中文不友好——一个汉字经常被拆成 2-3 个 token，而英文一个单词常是 1 个 token。同样一句话：

| 语言 | 示例 | 大致 token 数 |
|---|---|---|
| 中文 | 帮我写一个排序算法，要求时间复杂度 O(n log n) | 30-40 |
| 英文 | Write a sorting algorithm with O(n log n) time complexity | 15-20 |

**多轮对话时这个差距会被累积放大**——每一轮主模型都要重新读全部历史，历史是英文 vs 中文，token 消耗差距会成倍扩大。

### 痛点 2：现有方案只解决一半

官方市场的 [`pi-prompt-translate`](https://www.npmjs.com/package/pi-prompt-translate) 只翻译输入（用户中文 → 翻译成英文发给模型），**不翻译输出**——模型回复你看到的还是英文。用户被迫在「看英文回复」和「省 token」之间二选一。

### 痛点 3：用主模型翻译不划算

如果让 Claude Sonnet / GPT-4 这种主力模型自己翻译，翻译质量过剩、价格过高——翻译是「语义对等转换」，不需要强推理能力，应该用便宜的小模型做。

## 解决方案

**一个扩展搞定双向翻译**，用户全程用中文，模型全程用英文「思考」和「输出」：

```
你输入中文
    ↓ （本扩展 input hook 翻译）
英文 prompt 发给模型
    ↓ （模型英文推理 + 英文输出）
英文回复
    ↓ （本扩展 message_end hook 翻译）
中文展示给你
```

**token 消耗显著降低**，而且你看到的始终是中文。

## 创作思路

### 1. 一个包搞定，不需要装两个

输入侧（中→英）和输出侧（英→中）都在一个包里实现，hook 不同事件，互不冲突：

| 方向 | hook 事件 | 作用 |
|---|---|---|
| 输入侧 | `input` | 拦截用户输入，中文 → 翻译成英文，`return {action:"transform", text:英文}` |
| 输入侧 | `before_agent_start` | 注入 systemPrompt 引导模型用英文回复 |
| 输出侧 | `message_end` | 拦截 assistant 输出，英文 → 翻译成中文，`return {message}` 替换 |
| 配置引导 | `session_start` | 首次启动检测 DeepSeek 配置，缺失则引导用户配置 |

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

### 5. 双向 LRU 缓存避免重复翻译

输入侧和输出侧各用一个 256 项 LRU 缓存：
- 重复的用户输入（比如反复说「继续」「好的」）不重复调 LLM
- 重复的 assistant 回复（比如模型反复说 "Understood" / "Got it"）不重复调 LLM

### 6. CJK 检测，纯英文输入直接放行

用 Unicode 范围检测用户输入是否包含中文/日文/韩文字符。如果用户输入纯英文或代码，就不调翻译 LLM，避免无谓开销。

### 7. 首次启动引导配置 DeepSeek

默认配置 DeepSeek 需要用户自己拿 API key，对新用户不友好。本扩展在 `session_start` 事件检测 DeepSeek 是否已配置，未配置则弹确认框引导用户粘贴 API key，**全程图形化操作，零环境变量配置**。

### 8. 错误兜底原样透传

翻译失败时（网络错误 / API 限流 / key 失效）**不阻塞主流程**：
- 输入侧失败：原中文输入照常发给模型
- 输出侧失败：原英文回复照常展示给用户

只是看不到翻译而已，不会影响 Pi 正常工作。

### 9. 兼容 pi-prompt-translate

如果用户之前装过 `pi-prompt-translate`，本扩展会检测到它已注册 `/translate-toggle` 命令，**自动禁用输入侧 hook**，避免重复翻译。用户可以渐进迁移，最后卸载 pi-prompt-translate 即可。

## 安装

### 前置要求

- [Pi agent](https://pi.dev/) ≥ 0.74（需要支持 `registerProvider`）
- 任意已配置的主模型（Claude / GPT / DeepSeek / Qwen 等均可）

### 安装

```bash
# 方式一：从 npm 安装（推荐）
pi install npm:pi-translate-zh-en

# 方式二：从 GitHub 安装（最新开发版）
pi install git:https://github.com/pmlpl/cn-en-bridge.git

# 方式三：本地路径安装（开发者）
git clone https://github.com/pmlpl/cn-en-bridge.git
pi install ./cn-en-bridge/pi-translate-zh-en
```

**不需要再装 pi-prompt-translate**——本扩展已经包含输入侧翻译。如果之前装过，可以卸载：

```bash
pi uninstall pi-prompt-translate   # 可选，本扩展会自动兼容已装的情况
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
（本扩展 input hook 把这句中文翻译成英文发给模型）
（模型用英文思考和输出）
（本扩展 message_end hook 把英文输出翻译成中文展示）
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
| `/translate` | toggle 全部翻译（输入+输出） |
| `/translate on` | 开启全部翻译 |
| `/translate off` | 关闭全部翻译 |
| `/translate input on` | 只开输入侧（中→英） |
| `/translate input off` | 只关输入侧 |
| `/translate output on` | 只开输出侧（英→中） |
| `/translate output off` | 只关输出侧 |
| `/translate clear` | 清空双向翻译缓存 |
| `/translate status` | 查看当前状态（输入/输出开关 + 当前模型） |
| `/translate-setup` | 重新触发 DeepSeek 配置引导（更换 key 时用） |

### CLI Flag

```bash
pi --no-translate              # 本次会话临时关闭全部翻译
pi --no-translate-output       # 只关闭输出侧（输入侧仍翻译）
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
[input 事件] ──── 本扩展处理（中→英） ─────────────────┐
    │                                                    │
    ▼                                                    │
[before_agent_start] ── 注入英文 systemPrompt ──────────┤
    │                                                    │
    ▼                                                    │
模型英文推理 + 英文输出                                    │
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
├── package.json    # Pi 包 manifest（包名 pi-translate-zh-en）
├── index.ts        # 扩展入口：4 个 hook + /translate + /translate-setup + 首次引导 + CJK 检测 + 兼容检测
├── translate.ts    # 双向翻译：translateZhToEn + translateEnToZh + completeSimple(reasoning:"low")
└── cache.ts        # LRU 缓存（256 项 × 2 方向）
```

### 关键设计

| 设计点 | 实现 | 作用 |
|---|---|---|
| 一个包 hook 4 个事件 | `input` + `before_agent_start` + `message_end` + `session_start` | 输入输出全包，无需配合其他扩展 |
| 只翻译 `text` part | `content.map(part => part.type === "text" ? 翻译 : part)` | 不破坏 tool_use / thinking 语义 |
| `reasoning: "low"` | `completeSimple(model, ctx, { reasoning: "low" })` | 跳过推理，省翻译 token |
| 双向 LRU 缓存 | `zh2enCache` + `en2zhCache` 各 256 项 | 重复输入/回复不重复调 LLM |
| CJK 检测 | `containsCJK(text)` Unicode 范围判断 | 纯英文/代码输入直接放行，不调 LLM |
| 复用 Pi auth | `ctx.modelRegistry.getApiKeyAndHeaders(model)` | 不需要单独配翻译 API key |
| 错误兜底 | `try/catch + ctx.ui.notify("passthrough")` | 翻译失败不阻塞，原文本照常展示 |
| 持久化标记 | `~/.pi/agent/.translate-setup-done` 文件 | 避免每次启动都弹引导 |
| Key 文件权限 0600 | `fs.writeFileSync(keyFile, key, { mode: 0o600 })` | 仅用户可读，不进 git |
| 兼容 pi-prompt-translate | 检测 `translate-toggle` 命令已注册 | 已装的话自动让出输入侧 |

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

### Q: 必须配置 DeepSeek 吗？

**不是必须的**。不配置 DeepSeek 不会报错——翻译会 fallback 到当前主模型（比如 Claude Sonnet）。

但这样不省钱——主模型价格高，且每次翻译都要等主模型生成完才能开始，延迟更长。建议配置 DeepSeek 享受 16 倍价差。

### Q: 已经装了 pi-prompt-translate 怎么办？

**两个选择**：

1. **保留两个**（推荐先这样）：本扩展会检测到 pi-prompt-translate 已装，自动禁用自己的输入侧 hook，让 pi-prompt-translate 负责输入翻译。本扩展只负责输出翻译。功能不冲突。

2. **卸载 pi-prompt-translate**（更干净）：本扩展已经实现了输入侧翻译，完全不需要 pi-prompt-translate。卸载后本扩展会自动接管输入侧。

```bash
pi uninstall pi-prompt-translate
```

### Q: 翻译会破坏代码块吗？

**不会**。systemPrompt 明确要求保留代码块、文件路径、变量名、技术术语：

```
Translate the following user message to English.
Preserve all code blocks, file paths, variable names, command names, URLs, and technical terms exactly.
Only translate natural language portions.
Do NOT add explanations, thinking, or commentary.
Output ONLY the translated text.
```

### Q: 翻译失败怎么办？

**不阻塞主流程**：
- 输入侧失败：原中文输入照常发给模型
- 输出侧失败：原英文回复照常展示给用户

并显示警告通知 `translation failed (passthrough): <错误原因>`。

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
pi uninstall pi-translate-zh-en

# 2. 清理配置文件（可选）
rm ~/.pi/agent/.deepseek-key
rm ~/.pi/agent/.translate-setup-done
```

### Q: 支持其他语言对吗？

当前只支持中↔英双向。如果有其他语言需求，修改 [translate.ts](translate.ts) 里的 `ZH2EN_SYSTEM_PROMPT` 和 `EN2ZH_SYSTEM_PROMPT` 即可。

### Q: 输入翻译会不会有延迟？

会有一点延迟（同步翻译，等 LLM 返回）。如果觉得卡顿，可以临时关闭输入侧：

```bash
pi
/translate input off    # 只关输入侧，输出侧仍翻译
```

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

- [pi-prompt-translate](https://github.com/Veucci/pi-prompt-translate) by Veucci — 输入侧翻译的参考实现，本扩展的 input hook 设计参考了它
- [Pi mono](https://github.com/badlogic/pi-mono) by Mario Zechner — Pi agent 本体
- [Custom providers in Pi](https://aliou.me/posts/custom-providers-in-pi/) by Aliou — registerProvider 用法参考

## 相关项目

- [pi-prompt-translate](https://www.npmjs.com/package/pi-prompt-translate) — 仅输入侧翻译（中文→英文），本扩展已包含其功能
- [pi-tool-i18n](https://www.npmjs.com/package/pi-tool-i18n) — 翻译工具 schema 描述（不同场景）
- [pi-lean-ctx](https://www.jsdelivr.com/package/npm/pi-lean-ctx) — 压缩 bash/read/grep 输出省 token
