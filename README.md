# cn-en-bridge

> Pi agent 的**一站式中英互转省 token 翻译扩展**：用户输入中文自动翻译成英文发给模型，模型英文回复自动翻译成中文展示给用户。一个包搞定输入+输出双向翻译，无需配合其他扩展。

## 这是什么

`pi-translate-zh-en` 是套在 Pi agent 外层的翻译插件，用便宜的 DeepSeek V4-Flash 做翻译，比用主模型翻译省约 16 倍成本。核心解决两个痛点：

- **中文 token 消耗是英文的 2-3 倍**（多轮对话差距累积放大）
- **现有方案只翻译输入不翻译输出**（用户被迫在「看英文回复」和「省 token」之间二选一）

## 快速开始

```bash
# 安装
pi install npm:@pmlpm/pi-translate-zh-en

# 启动 Pi，首次会自动引导配置 DeepSeek API key
pi
```

安装后**全自动工作**，无需任何操作。

## 文档

完整文档（痛点分析、创作思路、使用方法、工作原理、FAQ）在子目录：

**👉 [pi-translate-zh-en/README.md](pi-translate-zh-en/README.md)**

## 仓库结构

```
cn-en-bridge/
└── pi-translate-zh-en/      # npm 包源码（@pmlpm/pi-translate-zh-en）
    ├── package.json
    ├── index.ts             # 扩展入口：4 个 hook + 命令注册 + 首次引导
    ├── translate.ts         # 双向翻译 + completeSimple(reasoning:"low")
    ├── cache.ts             # LRU 缓存（256 项 × 2 方向）
    ├── cjk.ts               # CJK 字符检测
    └── README.md            # 完整文档
```

## 链接

- **npm 包**：https://www.npmjs.com/package/@pmlpm/pi-translate-zh-en
- **GitHub 仓库**：https://github.com/pmlpl/cn-en-bridge
- **问题反馈**：https://github.com/pmlpl/cn-en-bridge/issues

## 许可证

MIT
