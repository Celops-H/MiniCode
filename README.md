# MiniCode

从零实现的 AI 编程 Agent 命令行工具（TypeScript + Node.js）。接入你自己的模型 API，在终端里读懂代码库、执行命令、修改文件，以多轮「调用工具 → 观察结果 → 继续行动」的方式完成开发任务。

**这是一个个人学习项目。** 我想做的是把一个 AI 编程 Agent 的完整链路亲手走一遍：Agent 主循环、工具系统、权限、上下文管理、多 Agent 协作、会话存储，全部自己实现，不用现成的 Agent 框架（模型调用与终端渲染分别使用官方 SDK 和 opentui）。功能已大体成型，但未经生产检验，问题还很多，不建议用在重要的工作上；接口和配置也随时可能调整。

## 功能一览

- **多厂商模型接入**：支持 OpenAI 兼容（chat/completions）与 Anthropic Messages 两种协议；可配置多个厂商与模型，用 `modelChain` 组成模型优先级链
- **Agent 主循环**：流式输出、工具调用、把执行结果交回模型继续生成、请求失败自动重试
- **工具系统**：文件读写与编辑（read / write / edit）、检索（glob / grep）、命令执行（bash，支持后台任务）、任务清单（todo）；超长的工具输出自动截断并落盘
- **权限控制**：工具调用经过审批链，default / plan / bypassPermissions 三种模式，内置危险命令识别
- **上下文管理**：接近模型上下文窗口上限时自动压缩历史（可配置阈值与保留策略），`/compact` 手动压缩
- **多 Agent 协作**：主 agent 可派生子 agent 并行执行子任务（有深度、总数、并发上限），子 agent 之间可互发消息；git 仓库下每个子 agent 使用独立的 Git Worktree 分支隔离工作区，避免写文件互相冲突
- **Hook**：十种生命周期事件（会话开始/结束、工具调用前后、子 agent 生命周期等）可配置为 shell 命令，`PreToolUse` 事件可拦截工具调用
- **会话持久化**：消息历史以 JSONL 落盘，按启动工作目录隔离，支持会话列表与继续会话
- **MCP**：以 stdio 传输接入外部 MCP server，其工具并入工具池
- **Skill**：从项目与用户目录发现 SKILL.md 技能，注入系统提示词，可用 `/skills` 管理
- **TUI**：基于 opentui（Solid JSX）的终端界面，支持流式渲染、工具调用卡片折叠、权限确认弹窗、消息排队、多 Agent 线程树展示

## 架构

```
src/
├── cli / tui       交互宿主，消费事件流做渲染
├── agent           Agent 主循环：流式输出 → 提取工具调用 → 执行 → 结果交回模型
├── tools           工具系统：内置工具注册与执行，多 Agent 下按角色过滤工具集
├── llm             模型接入：Provider 与协议适配，按协议与厂商能力位组装请求
├── context         上下文管理：压缩、裁剪、摘要、重试、token 统计
├── permission      权限：审批链、模式、危险命令识别
├── hooks           Hook：生命周期事件分发到 shell 命令
├── mcp / skills    MCP 外部工具与 Skill 技能扩展
├── storage         会话存储：JSONL 消息历史
└── config          配置：zod schema 校验，全局与项目两层
```

## 环境要求

- Node.js ≥ 26.4（TUI 依赖实验性 FFI 能力；可执行入口会在需要时自动带 flag 重启自身）
- pnpm

## 快速开始

```bash
pnpm install
pnpm build
pnpm link --global    # 之后命令行里就有 minicode 命令
```

首次运行会在 `~/.minicode/config.json` 生成一份最小配置。最小可用配置示例（全局配置 `~/.minicode/config.json`，或项目根目录 `.minicode.json`，两层按 provider id 合并）：

```json
{
  "providers": [
    {
      "id": "example",
      "baseUrl": "https://api.example.com/v1",
      "apiKeyEnv": "EXAMPLE_API_KEY",
      "protocol": "openai-chat-completions",
      "models": [
        { "id": "example-chat", "name": "Example Chat", "contextWindow": 128000 }
      ]
    }
  ],
  "modelChain": ["example-chat"]
}
```

注意两种协议的 `baseUrl` 拼接约定不同：`openai-chat-completions` 需要带 `/v1`（SDK 在其下追加路径），`anthropic-messages` 不带（SDK 自动追加 `/v1/messages`）。API key 优先从 `apiKeyEnv` 指定的环境变量读取，也可以在会话内用 `/connect` 直接写入全局配置。配置校验是严格模式，拼错字段名会直接报错而不是被忽略。

## 使用

```bash
minicode              # 无参数直接进 TUI
minicode -c           # 继续最近活跃的会话
minicode new          # 新建会话（-m 指定模型，--no-agents 关闭多 Agent 协作）
minicode continue <id>  # 继续指定会话
minicode list         # 列出会话
minicode tui -c [id]  # 显式进 TUI 并继续会话
```

会话内输入 `/help` 查看全部斜杠命令，常用的有：`/session` 会话管理、`/model` 切换模型、`/compact` 手动压缩上下文、`/mcp` MCP 面板、`/skills` 技能面板。

## 开发

```bash
pnpm test        # 全量测试（vitest）
pnpm typecheck   # tsc --noEmit
pnpm run dev     # 源码直跑 CLI
pnpm run dev:tui # 源码直跑 TUI
```

测试覆盖渲染纯函数断言、事件序列驱动的交互流，以及少量端到端用例；工具调用路径等还依赖真终端观察的部分没有自动化。

## 已知局限

如实列出，避免误会：

- **未经生产检验**：开发以个人使用和跑通链路为主，边界路径、错误处理、安全防护都还薄弱，不要交给它处理不可逆的操作而不盯着
- **厂商兼容靠手动适配**：不同厂商对思考参数、token 用量回传、流式行为等细节支持不一，需要在 provider 配置里手动开合各能力位，配错会收到 400
- **平台覆盖窄**：主要在 Windows（Git Bash）下开发和验证，macOS / Linux 没有系统测试过；TUI 依赖的 FFI 能力本身还在实验阶段
- **较新的模块完成度有限**：MCP、Skill 等功能可用，但还没有经过充分的真实场景验证
- **没有稳定性承诺**：配置字段、命令行为、会话格式都会随开发继续调整，不保证向后兼容
