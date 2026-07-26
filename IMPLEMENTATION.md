# 实施指南：中英互转省 Token 聊天工具

> 本文档为给执行型 Agent 的开发手册，依据 `中英互转省Token聊天工具方案.md` 编写。目标是在 `cn-en-bridge` 仓库的 `feat/initial-scaffold` 分支上，完成一个可本地运行、无需 GPU 的最小可用原型。

## 一、项目目标

构建一个本地 Web 聊天工具，实现：

```
用户输入中文 → 翻译成英文 → 发送给 AI 模型 → 模型英文输出 → 翻译回中文 → 展示给用户
```

让模型全程用英文"思考"和"输出"，显著降低 token 消耗，而用户侧始终用中文交互。

## 二、技术栈

| 层 | 技术 | 说明 |
| --- | --- | --- |
| 后端框架 | FastAPI | 原生 async，适合 I/O 密集场景 |
| 实时通信 | FastAPI WebSocket | 流式输出 |
| ASGI 服务器 | uvicorn | |
| AI 模型调用 | openai SDK（OpenAI 兼容接口） | 适配自建 Agent 的自有模型 |
| 翻译引擎 | HuggingFace transformers + Helsinki-NLP/opus-mt | 轻量、CPU 可跑、无需 GPU |
| 前端 | 原生 HTML + CSS + JavaScript | 双栏对照界面，无需构建工具 |
| Python | 3.10+ | |

## 三、目录结构

```
cn-en-bridge/
├── 中英互转省Token聊天工具方案.md   # 已存在
├── IMPLEMENTATION.md                # 本文档
├── README.md                        # 项目说明与运行方式
├── requirements.txt                 # Python 依赖
├── .env.example                     # 环境变量示例
├── .gitignore
├── app/
│   ├── __init__.py
│   ├── main.py                      # FastAPI 入口，挂载路由和静态文件
│   ├── config.py                    # 配置加载（从环境变量）
│   ├── translator.py                # 翻译模块（中↔英）
│   ├── llm.py                       # AI 模型调用（流式）
│   └── ws.py                        # WebSocket 路由与协议处理
└── static/
    ├── index.html                   # 双栏对照界面
    ├── style.css
    └── app.js                       # WebSocket 客户端逻辑
```

## 四、分阶段实施步骤

### 阶段 1：项目骨架与配置

1. 在 `feat/initial-scaffold` 分支上工作（已存在，勿动 main）。
2. 创建上述目录结构。
3. 编写 `requirements.txt`：
   ```
   fastapi>=0.110
   uvicorn[standard]>=0.27
   openai>=1.30
   transformers>=4.40
   torch>=2.2  # CPU 版本即可
   sentencepiece>=0.2
   python-dotenv>=1.0
   ```
4. 编写 `.env.example`：
   ```
   # AI 模型配置（OpenAI 兼容接口）
   LLM_BASE_URL=http://localhost:8000/v1
   LLM_API_KEY=your-key-here
   LLM_MODEL=your-model-name

   # 服务配置
   APP_HOST=0.0.0.0
   APP_PORT=8088
   ```
5. 编写 `.gitignore`：忽略 `__pycache__/`、`.env`、`*.pyc`、`venv/`、`.venv/`、模型缓存目录。
6. 编写 `app/config.py`：用 `pydantic-settings` 或 `python-dotenv` 加载上述变量。

### 阶段 2：翻译模块 `app/translator.py`

1. 使用 HuggingFace `transformers` 加载两个模型：
   - 中→英：`Helsinki-NLP/opus-mt-zh-en`
   - 英→中：`Helsinki-NLP/opus-mt-en-zh`
2. 实现两个异步函数（翻译本身是 CPU 密集，用 `asyncio.to_thread` 包装避免阻塞事件循环）：
   ```python
   async def zh_to_en(text: str) -> str: ...
   async def en_to_zh(text: str) -> str: ...
   ```
3. 模型在模块加载时初始化一次，后续复用。
4. 首次加载会从 HuggingFace 下载模型（约几百 MB），需提示用户联网；下载后本地缓存，后续离线可用。

### 阶段 3：AI 模型调用 `app/llm.py`

1. 使用 `openai` SDK，配置 `base_url` 指向自建 Agent 的 OpenAI 兼容端点。
2. 实现流式调用函数：
   ```python
   async def stream_chat(history: list[dict]) -> AsyncIterator[str]:
       """history 为 OpenAI messages 格式，全程英文。逐段 yield 英文文本。"""
   ```
3. 历史消息全程以英文保存，保持上下文连贯并持续省 token。

### 阶段 4：WebSocket 路由 `app/ws.py`

**协议设计**（JSON 消息）：

客户端 → 服务端：
```json
{ "type": "chat", "text": "用户输入的中文" }
```

服务端 → 客户端（按顺序推送多条消息）：
```json
{ "type": "translated_input", "en": "翻译后的英文输入" }
{ "type": "ai_chunk", "en": "AI 流式输出的英文片段" }
{ "type": "ai_done", "en": "完整的英文回复" }
{ "type": "translated_output", "zh": "翻译后的中文回复" }
{ "type": "error", "message": "错误说明" }
```

处理流程：
1. 收到 `chat` 消息，取中文文本。
2. 调 `zh_to_en` 得到英文输入，推送 `translated_input`。
3. 把英文输入加入 history（user 角色），调 `stream_chat` 流式获取英文回复。
4. 每收到一个英文片段，推送 `ai_chunk`。
5. 流结束后，拼接完整英文回复，推送 `ai_done`。
6. 把完整英文回复加入 history（assistant 角色）。
7. 调 `en_to_zh` 翻译完整英文回复，推送 `translated_output`。

> 注意：英文→中文翻译对完整回复做一次，不对每个 chunk 单独翻译（避免翻译不一致和额外开销）。

### 阶段 5：FastAPI 入口 `app/main.py`

1. 创建 `FastAPI` 实例。
2. 注册 `app/ws.py` 中的 WebSocket 路由，路径 `/ws`。
3. 挂载 `static/` 目录为静态文件根路径 `/`。
4. 根路径 `/` 返回 `static/index.html`。
5. 启动入口：
   ```python
   if __name__ == "__main__":
       import uvicorn
       uvicorn.run("app.main:app", host=settings.APP_HOST, port=settings.APP_PORT, reload=True)
   ```

### 阶段 6：前端 `static/`

1. `index.html`：双栏布局
   - 左栏：中文输入框 + 发送按钮
   - 右栏：分三块显示
     - 英文输入（翻译后）
     - AI 英文回复（流式滚动）
     - 中文翻译（最终）
2. `style.css`：简洁清晰的双栏样式。
3. `app.js`：
   - 建立 WebSocket 连接到 `/ws`。
   - 发送按钮点击时，发送 `chat` 消息。
   - 根据收到的消息 `type` 更新右侧对应区域。
   - 流式 chunk 追加显示。
   - 支持回车发送。
   - 断线自动重连。

### 阶段 7：README 与运行说明

`README.md` 包含：
- 项目简介（一段话）
- 环境要求：Python 3.10+，无需 GPU
- 安装步骤：
  ```bash
  python -m venv .venv
  source .venv/bin/activate  # Windows: .venv\Scripts\activate
  pip install -r requirements.txt
  cp .env.example .env
  # 编辑 .env 填入模型配置
  ```
- 运行：`python -m app.main` 或 `uvicorn app.main:app --reload`
- 访问：`http://localhost:8088`
- 首次运行会自动下载翻译模型（约几百 MB），请保持联网。

## 五、关键实现要点

1. **翻译不阻塞事件循环**：`transformers` 推理是 CPU 密集，必须用 `asyncio.to_thread` 包装，否则会卡住所有 WebSocket 连接。
2. **模型单例加载**：翻译模型在进程启动时加载一次，不要每次请求加载。
3. **历史以英文保存**：上下文全程英文，这是省 token 的核心，不要把中文混入 history。
4. **错误处理**：翻译失败、模型调用失败都要通过 `error` 类型消息推给前端，不要静默吞掉。
5. **流式体验**：英文 chunk 要实时推送，不要等全部生成完再推；但中文翻译等英文完整后再做。
6. **CPU 环境**：`torch` 装 CPU 版本（`pip install torch --index-url https://download.pytorch.org/whl/cpu`），README 里说明。

## 六、验收标准

- [ ] `pip install -r requirements.txt` 可成功安装。
- [ ] 配置 `.env` 后 `python -m app.main` 可启动，访问 `http://localhost:8088` 看到界面。
- [ ] 输入中文，右侧依次显示：英文输入、流式英文回复、中文翻译。
- [ ] 多轮对话上下文连贯（模型能记住前文）。
- [ ] 全程仅用 CPU，无 GPU 依赖。
- [ ] 代码提交到 `feat/initial-scaffold` 分支，commit 信息清晰。

## 七、提交规范

- 在 `feat/initial-scaffold` 分支上工作，**不要直接推 main**。
- 分阶段提交，每个 commit 聚焦一件事，例如：
  - `chore: 初始化项目骨架与依赖`
  - `feat(translator): 实现中英互译模块`
  - `feat(llm): 实现流式模型调用`
  - `feat(ws): 实现 WebSocket 协议与路由`
  - `feat(frontend): 实现双栏对照界面`
  - `docs: 补充 README 运行说明`
- 完成后推送到 origin，并提一个 PR 到 main（标题：`feat: 中英互转省 token 聊天工具初始原型`）。

## 八、注意事项

- 用户是"自建 Agent 接自有模型"，AI 端点通常是 OpenAI 兼容接口，用 `openai` SDK 配 `base_url` 即可，不要假设是 OpenAI 官方。
- 如果用户的模型端点不支持流式，`stream_chat` 应回退为一次性返回（仍以 chunk 形式推一次给前端）。
- 翻译模型首次下载较慢，README 需明确提示。
- 保持代码简洁，不要过度设计；本阶段只做最小可用原型，不需要用户系统、持久化存储等。
