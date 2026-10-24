<div align="center">

# CodeGraph

## 🎉 1.0 已发布！

已经安装了？运行 `codegraph upgrade` 即可原地更新。

在 X 上关注 [@getcodegraph](https://x.com/getcodegraph) 获取最新动态。

### 用语义级代码智能为 Claude Code、Cursor、Codex、OpenCode、Hermes Agent、Gemini、Antigravity 和 Kiro 加速

**成本降低约 16% · 工具调用减少约 58% · 100% 本地运行**

### [文档与官网 →](https://colbymchenry.github.io/codegraph/)

[![npm version](https://img.shields.io/npm/v/@colbymchenry/codegraph.svg)](https://www.npmjs.com/package/@colbymchenry/codegraph)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Self-contained](https://img.shields.io/badge/Node.js-bundled%20%C2%B7%20none%20required-brightgreen.svg)](https://nodejs.org/)

[![Windows](https://img.shields.io/badge/Windows-supported-blue.svg)](#支持的平台)
[![macOS](https://img.shields.io/badge/macOS-supported-blue.svg)](#支持的平台)
[![Linux](https://img.shields.io/badge/Linux-supported-blue.svg)](#支持的平台)

[![Claude Code](https://img.shields.io/badge/Claude_Code-supported-blueviolet.svg)](#支持的-agent)
[![Cursor](https://img.shields.io/badge/Cursor-supported-blueviolet.svg)](#支持的-agent)
[![Codex](https://img.shields.io/badge/Codex-supported-blueviolet.svg)](#支持的-agent)
[![opencode](https://img.shields.io/badge/opencode-supported-blueviolet.svg)](#支持的-agent)
[![Hermes Agent](https://img.shields.io/badge/Hermes_Agent-supported-blueviolet.svg)](#支持的-agent)
[![Gemini](https://img.shields.io/badge/Gemini-supported-blueviolet.svg)](#支持的-agent)
[![Antigravity](https://img.shields.io/badge/Antigravity-supported-blueviolet.svg)](#支持的-agent)
[![Kiro](https://img.shields.io/badge/Kiro-supported-blueviolet.svg)](#支持的-agent)

[English](./README.md) · **简体中文**

<br />

<br>

**CodeGraph 平台即将推出** —— 对于每一个 PR，精准了解该测试什么、什么可能会出问题、哪些流程受到影响，以及业务逻辑是否被破坏。

<a href="https://getcodegraph.com"><img alt="Join the waitlist for early beta access" src="https://raw.githubusercontent.com/colbymchenry/codegraph/main/assets/waitlist.svg?v=2" height="52"></a>

<sub>获取托管产品的<b>抢先内测访问权限</b> · <a href="https://getcodegraph.com">getcodegraph.com</a></sub>

</div>

## 快速开始

### 1. 安装 CLI

**无需 Node.js** —— 一条命令即可为你的操作系统获取正确的构建版本：

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.sh | sh

# Windows (PowerShell)
irm https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.ps1 | iex
```

<details>
<summary><b>已经装了 Node？也可以改用 npm（适用于任意版本）</b></summary>

```bash
npm i -g @colbymchenry/codegraph
```

<sub>CodeGraph 自带运行时 —— 无需编译、无需原生构建，在任何环境下表现一致。安装程序会把 `codegraph` 加入你的 PATH，但**不会改变当前 shell** —— 进行下一步前请打开一个新终端，命令才能被解析到。</sub>

<sub>**随时升级**：运行 `codegraph upgrade` —— 它会检测你的安装方式（bundle、npm 或 npx）并原地更新。加上 `--check` 可查看是否有可用更新，或用 `codegraph upgrade <version>` 锁定某个版本。</sub>

</details>

### 2. 接入你的 agent

在一个**新终端**中运行安装程序，把 CodeGraph 连接到你使用的 agent：

```bash
codegraph install
```

<sub>自动检测并配置 Claude Code、Cursor、Codex CLI、opencode、Hermes Agent、Gemini CLI、Antigravity IDE 和 Kiro —— 把 CodeGraph MCP 服务器接入每一个。**正是这一步把 CodeGraph 连接到你的 agent**；第 1 步安装 CLI 本身并不会完成接入。（快捷方式：`npx @colbymchenry/codegraph` 一步下载并运行它。）</sub>

### 3. 初始化每个项目

```bash
cd your-project
codegraph init
```

<sub>`codegraph init` 会创建本地的 `.codegraph/` 目录，并在同一步中构建完整的图 —— 一条命令，搞定。</sub>

<div align="center">

![1_C_VYnhpys0UHrOuOgpgoyw](https://github.com/user-attachments/assets/f168182f-4d9a-44e0-94d7-08d018cc8a3a)

</div>

### 4. 不用再手动同步了！

自动同步默认开启。CodeGraph 会监视项目并在每次文件变更时更新图 —— 无论是你的 agent 在改代码，还是你自己新增、修改或删除文件。**索引永不过期，也没有任何东西需要重新运行。**

### 卸载

改主意了？一条命令即可把 CodeGraph 从它配置过的每一个 agent 中移除：

```bash
codegraph uninstall
```

<sub>逆向执行安装过程 —— 从每个已配置的 agent 中剥离 CodeGraph 的 MCP 服务器配置、指令和权限。你的项目索引（`.codegraph/`）会保持原样；如需逐项目删除，请用 `codegraph uninit`。用 `--target` 从指定 agent 移除，或用 `--yes` 以非交互方式运行。</sub>

---

## 为什么选择 CodeGraph？

当 Claude Code 探索一个代码库时，它会派生出**探索（Explore）agent**，用 grep、glob 和 Read 扫描文件 —— 每次工具调用都在消耗 token。

**CodeGraph 为这些 agent 提供一个预先建好的知识图谱** —— 符号关系、调用图和代码结构。agent 直接查询图，而不再扫描文件，瞬间获得结果。

### 基准测试结果

在**横跨 7 种语言的 7 个真实开源代码库**上测试，对比一个 agent（无头模式的 Claude Code）在**有** CodeGraph 和**没有** CodeGraph 的情况下回答同一个架构问题。每个单元格都是**每组 4 次运行取中位数**的节省幅度。_已在 Opus 4.8（2026-06-02）、当前构建（以 `codegraph_explore` 为主力工具）上重新验证。_

> **平均：成本降低 16% · token 减少 47% · 速度提升 22% · 工具调用减少 58%**

| 代码库 | 语言 | 成本 | Token | 时间 | 工具调用 |
|----------|----------|------|--------|------|------------|
| **VS Code** | TypeScript · 约 10k 文件 | 降低 18% | 减少 64% | 提升 11% | 减少 81% |
| **Excalidraw** | TypeScript · 约 640 | 持平 | 减少 25% | 提升 27% | 减少 40% |
| **Django** | Python · 约 3k | 降低 8% | 减少 60% | 提升 13% | 减少 77% |
| **Tokio** | Rust · 约 790 | 持平 | 减少 38% | 提升 18% | 减少 57% |
| **OkHttp** | Java · 约 645 | 降低 25% | 减少 54% | 提升 31% | 减少 50% |
| **Gin** | Go · 约 110 | 降低 19% | 减少 23% | 提升 24% | 减少 44% |
| **Alamofire** | Swift · 约 110 | 降低 40% | 减少 64% | 提升 33% | 减少 58% |

CodeGraph 在**每一个代码库上都削减了 token、工具调用和实际耗时** —— 无论是小型、中型还是大型代码库 —— 并以**近乎为零的文件读取**回答问题，而没有 CodeGraph 的 agent 则把预算花在 grep/find/Read 的发现过程上。`codegraph_explore` 会完整展示答案 —— 既给出机制，也给出你问到的确切方法，即便它们埋在一个数千行的文件里 —— 同时把冗余的、可互换的实现折叠为签名，因此响应的大小贴合**答案**本身，而非文件数量。**成本在各处都保持持平到更便宜** —— 在小型仓库（Alamofire、OkHttp）上节省最多，在响应量最大的仓库（Excalidraw、Tokio）上大致打平：在这些仓库上，CodeGraph 用几次大体量、可大量命中缓存的工具响应，换掉了无 CodeGraph agent 的许多次小型 grep/read 往返。

<details>
<summary><strong>逐仓库明细 —— 有 vs 无（4 次取中位数）</strong></summary>

**VS Code** · 约 10k 文件
| 指标 | 有 cg | 无 cg | Δ |
|---|---|---|---|
| 时间 | 1m 59s | 2m 13s | 提升 11% |
| 文件读取 | 0 | 9 | −9 |
| Grep/Bash | 0 | 11 | −11 |
| 工具调用 | 4 | 21 | 减少 81% |
| 总 token | 640k | 1.79M | 减少 64% |
| 成本 | $0.68 | $0.83 | 降低 18% |

**Excalidraw** · 约 640 文件
| 指标 | 有 cg | 无 cg | Δ |
|---|---|---|---|
| 时间 | 1m 32s | 2m 6s | 提升 27% |
| 文件读取 | 0 | 7 | −7 |
| Grep/Bash | 1 | 8 | −7 |
| 工具调用 | 9 | 15 | 减少 40% |
| 总 token | 1.27M | 1.69M | 减少 25% |
| 成本 | $0.78 | $0.78 | 持平 |

**Django** · 约 3k 文件
| 指标 | 有 cg | 无 cg | Δ |
|---|---|---|---|
| 时间 | 1m 43s | 1m 58s | 提升 13% |
| 文件读取 | 0 | 9 | −9 |
| Grep/Bash | 0 | 5 | −5 |
| 工具调用 | 3 | 13 | 减少 77% |
| 总 token | 559k | 1.41M | 减少 60% |
| 成本 | $0.57 | $0.62 | 降低 8% |

**Tokio** · 约 790 文件
| 指标 | 有 cg | 无 cg | Δ |
|---|---|---|---|
| 时间 | 1m 55s | 2m 20s | 提升 18% |
| 文件读取 | 0 | 8 | −8 |
| Grep/Bash | 0 | 6 | −6 |
| 工具调用 | 6 | 14 | 减少 57% |
| 总 token | 1.08M | 1.73M | 减少 38% |
| 成本 | $0.82 | $0.82 | 持平 |

**OkHttp** · 约 645 文件
| 指标 | 有 cg | 无 cg | Δ |
|---|---|---|---|
| 时间 | 1m 1s | 1m 29s | 提升 31% |
| 文件读取 | 0 | 4 | −4 |
| Grep/Bash | 2 | 6 | −4 |
| 工具调用 | 5 | 10 | 减少 50% |
| 总 token | 502k | 1.10M | 减少 54% |
| 成本 | $0.41 | $0.55 | 降低 25% |

**Gin** · 约 110 文件
| 指标 | 有 cg | 无 cg | Δ |
|---|---|---|---|
| 时间 | 1m 14s | 1m 37s | 提升 24% |
| 文件读取 | 1 | 6 | −5 |
| Grep/Bash | 1 | 2 | −1 |
| 工具调用 | 5 | 9 | 减少 44% |
| 总 token | 651k | 847k | 减少 23% |
| 成本 | $0.46 | $0.57 | 降低 19% |

**Alamofire** · 约 110 文件
| 指标 | 有 cg | 无 cg | Δ |
|---|---|---|---|
| 时间 | 1m 35s | 2m 21s | 提升 33% |
| 文件读取 | 0 | 9 | −9 |
| Grep/Bash | 0 | 4 | −4 |
| 工具调用 | 5 | 12 | 减少 58% |
| 总 token | 766k | 2.10M | 减少 64% |
| 成本 | $0.57 | $0.95 | 降低 40% |

</details>

<details>
<summary><strong>完整基准测试细节</strong></summary>

**方法。** 每一组都是 `claude -p`（Claude Opus 4.8），以 `--strict-mcp-config` 无头方式针对该仓库运行：**有** = 启用 CodeGraph 的 MCP 服务器，**无** = 一个空的 MCP 配置。两组都保留内置的 Read/Grep/Bash。每个仓库使用相同的问题，**每组 4 次运行，取中位数报告**。成本 = 该次运行的 `total_cost_usd`；Token = 处理的总 token 数（输入含缓存 + 输出）；时间 = 实际耗时；工具调用 = 每一次工具调用，包括模型派生的任何子 agent 内部的调用。仓库以 `--depth 1` 克隆，并由提供它们的同一个 CodeGraph 构建版本来索引。已于 2026-06-02 在当前构建上重新验证。这些数字低于此前的 Opus 4.7 验证 —— 这并非 CodeGraph 退步，而是原生基线更强了：Opus 4.8 在主线程上高效地 grep/read，而不再扇出成大型的 Explore 子 agent 扫描，所以无 CodeGraph 那一组比过去更精简。逐仓库数字会随着无 CodeGraph 组挣扎程度的不同而在多次运行间波动（4 次取中位数能平滑它，但尾部依旧存在 —— 例如 Django 的无 CodeGraph 组在某一批次飙到了 $2.71/14m）。

**查询：**
| 代码库 | 查询 |
|----------|-------|
| VS Code | "How does the extension host communicate with the main process?" |
| Excalidraw | "How does Excalidraw render and update canvas elements?" |
| Django | "How does Django's ORM build and execute a query from a QuerySet?" |
| Tokio | "How does tokio schedule and run async tasks on its runtime?" |
| OkHttp | "How does OkHttp process a request through its interceptor chain?" |
| Gin | "How does gin route requests through its middleware chain?" |
| Alamofire | "How does Alamofire build, send, and validate a request?" |

**CodeGraph 为何胜出：** 当索引可用时，agent 直接作答 —— 通常一次 `codegraph_explore` 就返回相关源码 —— 然后停下，往往零文件读取。没有它，agent 会把大部分预算花在发现上（find/ls/grep），才读到正确的代码。CodeGraph 只在被*直接*查询时才有帮助，因此它的指令引导 agent 直接作答，而不是把探索委派给读文件的子 agent —— 否则子 agent 无论如何都会读文件，CodeGraph 就成了额外开销。

</details>

---

## 核心特性

| | |
|---|---|
| **智能上下文构建** | 一次工具调用即返回入口点、相关符号和代码片段 —— 无需昂贵的探索 agent |
| **全文搜索** | 由 FTS5 驱动，在整个代码库中按名称即时查找代码 |
| **影响分析** | 在改动前追踪任意符号的调用者、被调用者及其完整影响半径 |
| **始终最新** | 文件监视器使用原生操作系统事件（FSEvents/inotify/ReadDirectoryChangesW），配合带防抖的自动同步 —— 图随你编码保持最新，零配置 |
| **20+ 种语言** | TypeScript、JavaScript、Python、Go、Rust、Java、C#、PHP、Ruby、C、C++、Objective-C、Swift、Kotlin、Scala、Dart、Lua、Luau、R、Svelte、Vue、Astro、Liquid、Pascal/Delphi |
| **框架感知的路由** | 识别 Web 框架的路由文件，并在 17 种框架间把 URL 模式链接到它们的处理函数 |
| **混合 iOS / React Native / Expo** | 闭合静态解析会遗漏的跨语言流程：Swift ↔ ObjC 桥接、React Native 旧版 bridge + TurboModules + Fabric 视图组件、原生 → JS 事件发射器、Expo Modules |
| **100% 本地** | 没有数据离开你的机器。无需 API key。无外部服务。仅一个 SQLite 数据库 |

<details>
<summary><strong>自动同步是如何工作的 —— 以及为什么你不需要手动运行 <code>codegraph sync</code></strong></summary>

当你的 agent（Claude Code、Cursor、Codex、opencode）启动 `codegraph serve --mcp` 时，三层机制让索引与你的代码保持同步 —— 并确保在一次编辑与下一次同步之间的短暂窗口里，agent 永远不会悄无声息地得到一个错误答案：

1. **带防抖的文件监视自动同步。** 一个原生的 FSEvents / inotify / ReadDirectoryChangesW 监视器捕获每一次源文件的创建 / 修改 / 删除，并在一个防抖窗口（默认 `2000ms`，可通过 `CODEGRAPH_WATCH_DEBOUNCE_MS` 调节，钳制在 `[100ms, 60s]`）之后触发重新索引。密集的编辑会合并为一次同步。

2. **逐文件的过期横幅。** 在短暂的防抖窗口期间，凡是会引用某个仍在等待中的文件的 MCP 工具响应，都会在前面加上一个 `⚠️` 横幅，点名该文件并告诉 agent 直接 `Read` 它。响应未引用的等待中文件，则以一个小脚注的形式出现。无论哪种方式，agent 都会得到明确信号 —— 已在 Claude Code 上验证，agent 会直接说出 "Reading the file directly for the live content"（直接读取文件以获取实时内容）后再打开它。

3. **连接时追平。** 当 MCP 服务器（重新）连接时，CodeGraph 会在回答第一个查询前，先对工作树做一次快速的 `(size, mtime)` + 内容哈希对账 —— 这样在没有 MCP 服务器运行期间所做的编辑（从终端的一次 `git pull`、来自另一个编辑器的改动、上一个已退出的 agent 会话）都会在下一个会话的首次工具调用时被吸收进来。

```
agent writes src/Widget.ts
  → watcher fires (<100ms)
  → debounce (default 2s)
  → sync; Widget.ts is in the index
  → next agent query sees it
```

**随时验证**：用 `codegraph_status`（通过 MCP）或 `codegraph status`（CLI）。如果有任何等待中的内容，你会看到一个 `### Pending sync:` 小节，列出文件及其编辑时长。

少数几种手动 `codegraph sync` 有意义的场景：监视器被禁用（沙箱环境，或 `CODEGRAPH_NO_DAEMON=1`），或者你在 agent 会话之外编写脚本操作索引，并希望在脚本开始时做一次预先同步。

→ 完整深入说明见 [指南 → 索引一个项目](https://colbymchenry.github.io/codegraph/guides/indexing/#stay-fresh-automatically)。

</details>

---

## 框架感知的路由

CodeGraph 会检测 Web 框架的路由文件，并发出 `route` 节点，通过 `references` 边链接到它们的处理类或函数。如今查询某个视图/控制器的调用者，会顺带浮现出绑定它的 URL 模式。

| 框架 | 识别的形态 |
|---|---|
| **Django** | `urls.py` 中的 `path()`、`re_path()`、`url()`、`include()`（CBV `.as_view()`、点号路径） |
| **Flask** | `@app.route('/path', methods=[...])`、蓝图（blueprint）路由 |
| **FastAPI** | `@app.get(...)`、`@router.post(...)`，以及所有标准方法 |
| **Express** | 带中间件链的 `app.get(...)`、`router.post(...)` |
| **NestJS** | `@Controller` + `@Get/@Post/...`、GraphQL `@Resolver` + `@Query/@Mutation`、`@MessagePattern`/`@EventPattern`、`@SubscribeMessage` |
| **Laravel** | `Route::get()`、`Route::resource()`、`Controller@action`、元组语法 |
| **Drupal** | `*.routing.yml` 路由（`_controller`、`_form`、实体处理器）；`.module`/`.theme`/`.install`/`.inc` 中的 `hook_*` 实现 |
| **Rails** | `get '/x', to: 'users#index'`、hash-rocket `=>` 语法 |
| **Spring** | 方法上的 `@GetMapping`、`@PostMapping`、`@RequestMapping` |
| **Play** | `conf/routes` 中的 `GET`/`POST`/… 动词路由 → `Controller.method` action（Scala + Java） |
| **Gin / chi / gorilla / mux** | `r.GET(...)`、`router.HandleFunc(...)` |
| **Axum / actix / Rocket** | `.route("/x", get(handler))` |
| **ASP.NET** | action 方法上的 `[HttpGet("/x")]` 特性 |
| **Vapor** | `app.get("x", use: handler)` |
| **React Router** / **SvelteKit** | 路由组件节点 |
| **Vue Router** / **Nuxt** | `pages/` 基于文件的路由、`server/api/` 端点、路由中间件 |
| **Astro** | `src/pages/` 基于文件的路由（`.astro` 页面 + `.ts` 端点，`[param]`/`[...rest]` 语法） |

---

## 混合 iOS / React Native / Expo 桥接

真实的 iOS 和 React Native 代码库横跨多种语言 —— 一个 Swift 调用者调用一个被自动桥接的 Objective-C selector，一个 JS 文件通过 React Native bridge 调入原生模块，一个 JSX 组件委托给一个原生视图管理器。静态的 tree-sitter 提取会在每个语言边界处止步。CodeGraph 把它们桥接起来，让 `trace`、`callers`、`callees` 和 `impact` 能跨越这道鸿沟端到端地连通。

| 边界 | JS / Swift 侧 | 原生侧 | 方式 |
|---|---|---|---|
| **Swift → ObjC** | Swift `obj.foo(bar:)` | ObjC selector `-fooWithBar:` | `@objc` 自动桥接规则（含 init/property/protocol 形式）+ Cocoa 介词前缀（`With`/`For`/`By`/`In`/`On`/`At`/…） |
| **ObjC → Swift** | ObjC `[obj fooWithBar:]` | Swift `@objc func foo(bar:)` | 反向桥接名称候选；从源码核实 `@objc` 暴露 |
| **React Native 旧版 bridge** | JS `NativeModules.X.fn(...)` | ObjC `RCT_EXPORT_METHOD` / `RCT_REMAP_METHOD` · Java/Kotlin `@ReactMethod` | 解析宏/注解声明，构建 JS 名称 → 原生方法的映射 |
| **React Native TurboModules** | JS `import M from './NativeM'; M.fn(...)` | 匹配 Codegen spec 的原生实现 | 把 `Native<X>.ts` spec 接口当作基准事实 |
| **RN 原生 → JS 事件** | JS `new NativeEventEmitter(...).addListener('e', cb)` | ObjC `[self sendEventWithName:@"e" body:...]` · Swift `sendEvent(withName: "e", ...)` · Java/Kotlin `.emit("e", ...)` | 以字面事件名为键合成的跨语言事件通道 |
| **Expo Modules** | JS `requireNativeModule('X').fn(...)` | Swift / Kotlin `Module { Name("X"); AsyncFunction("fn") { ... } }` | 解析 Expo DSL 字面量；合成的方法节点通过既有的名称匹配解析 |
| **Fabric 视图组件** | JSX `<MyView prop={v}/>` | TS Codegen spec + 原生实现类 | spec → `component` 节点；基于约定的名称+后缀查找（`View`/`ComponentView`/`Manager`/`ViewManager`）桥接到原生 |
| **旧版 Paper 视图管理器** | JSX `<MyView prop={v}/>` | ObjC `RCT_EXPORT_VIEW_PROPERTY` · Java/Kotlin `@ReactProp` | 与 Fabric 相同 —— Paper 时代的声明同样产生 `component` + `property` 节点 |

**已在真实代码库上验证**（每个桥接各取 小 + 中 + 大）：

| 桥接 | 小型 | 中型 | 大型 |
|---|---|---|---|
| Swift ↔ ObjC | [Charts](https://github.com/danielgindi/Charts) | [realm-swift](https://github.com/realm/realm-swift) | [Wikipedia-iOS](https://github.com/wikimedia/wikipedia-ios) |
| RN 旧版 bridge | [AsyncStorage](https://github.com/react-native-async-storage/async-storage) | [react-native-svg](https://github.com/software-mansion/react-native-svg) | [react-native-firebase](https://github.com/invertase/react-native-firebase) |
| RN 原生 → JS 事件 | [RNGeolocation](https://github.com/Agontuk/react-native-geolocation-service) | — | react-native-firebase |
| Expo Modules | expo-haptics | expo-camera | expo SDK 扫描（7 个包） |
| Fabric / Paper 视图 | [react-native-segmented-control](https://github.com/react-native-segmented-control/segmented-control) | [react-native-screens](https://github.com/software-mansion/react-native-screens) | [react-native-skia](https://github.com/Shopify/react-native-skia) |

每个桥接发出的边都标记为 `provenance:'heuristic'`，并把 `metadata.synthesizedBy:` 设为一个稳定的通道名（例如 `swift-objc-bridge`、`rn-event-channel`、`fabric-native-impl`、`expo-module-extract`），这样 agent 一眼就能看出某一跳是如何进入图的。

---

## 快速上手

### 1. 运行安装程序

```bash
npx @colbymchenry/codegraph
```

安装程序将会：
- 询问要配置哪些 agent —— 从以下选项中自动检测已安装的：**Claude Code**、**Cursor**、**Codex CLI**、**opencode**、**Hermes Agent**、**Gemini CLI**、**Antigravity IDE**、**Kiro**
- 提示把 `codegraph` 安装到你的 PATH（这样 agent 才能启动 MCP 服务器）
- 询问配置应用于你的所有项目，还是仅当前这一个
- 写入每个选定 agent 的 MCP 服务器配置，外加在该 agent 的指令文件（`CLAUDE.md` / `AGENTS.md` / `GEMINI.md`）中写入一小段以标记包裹的 CodeGraph 区块 —— 子 agent 和非 MCP 的 agent 正是通过它来了解 `codegraph explore` / `codegraph node` 命令的，因为 MCP 服务器自身的指引只能到达主 agent。可由 `codegraph uninstall` 干净移除。
- 当 Claude Code 是目标之一时，设置自动允许权限
- 初始化你当前的项目（仅本地安装）

**非交互式（脚本 / CI）：**

```bash
codegraph install --yes                              # auto-detect agents, install global
codegraph install --target=cursor,claude --yes       # explicit target list
codegraph install --target=auto --location=local     # detected agents, project-local
codegraph install --print-config codex               # print snippet, no file writes
```

| 标志 | 取值 | 默认 |
|---|---|---|
| `--target` | `auto`、`all`、`none`，或 csv（`claude,cursor,...`） | 提示 |
| `--location` | `global`、`local` | 提示 |
| `--yes` | （布尔） | 每一步都提示 |
| `--no-permissions` | （布尔）跳过 Claude 自动允许列表 | 权限开启 |
| `--print-config <id>` | 为单个 agent 输出配置片段并退出 | — |

### 2. 重启你的 agent

重启你的 agent（Claude Code / Cursor / Codex CLI / opencode / Hermes Agent / Gemini CLI / Antigravity IDE / Kiro），以便加载 MCP 服务器。

### 3. 初始化项目

```bash
cd your-project
codegraph init
```

构建逐项目的知识图谱索引，之后会在每次文件变更时自动同步。一次全局的 `codegraph install` 在你打开的每个项目中都生效 —— 无需逐项目重新运行安装程序。

就这样 —— 只要存在 `.codegraph/` 目录，你的 agent 就会自动使用 CodeGraph 工具。

<details>
<summary><strong>手动设置（备选）</strong></summary>

**全局安装：**
```bash
npm install -g @colbymchenry/codegraph
```

**添加到 `~/.claude.json`：**
```json
{
  "mcpServers": {
    "codegraph": {
      "type": "stdio",
      "command": "codegraph",
      "args": ["serve", "--mcp"]
    }
  }
}
```

**添加到 `~/.claude/settings.json`（可选，用于自动允许）：**
```json
{
  "permissions": {
    "allow": [
      "mcp__codegraph__codegraph_search",
      "mcp__codegraph__codegraph_explore",
      "mcp__codegraph__codegraph_callers",
      "mcp__codegraph__codegraph_callees",
      "mcp__codegraph__codegraph_impact",
      "mcp__codegraph__codegraph_node",
      "mcp__codegraph__codegraph_status",
      "mcp__codegraph__codegraph_files"
    ]
  }
}
```

</details>

<details>
<summary><strong>Agent 工具指引</strong></summary>

CodeGraph 的 MCP 服务器会**自动**在 MCP `initialize` 响应中把使用指引交付给你的 agent。简而言之，它告诉 agent：

- **用 CodeGraph 直接回答结构性问题** —— 它*就是*那个预先建好的索引，所以一轮 grep/read 只是在重复它已经做过的工作。把返回的源码当作已经读过。
- **按意图选工具：** 几乎任何事都用 `codegraph_explore` —— "X 如何工作"、一个流程／"X 如何到达 Y"，或勘察某个区域（一次调用即返回相关符号的源码，按文件分组）；`codegraph_search` 用于仅定位某个符号；`codegraph_callers` 用于查找每一个调用点（包括回调注册）；`codegraph_node` 用于获取单个符号的完整源码 + 调用者，或像 Read 工具那样读取一个文件。
- **信任结果 —— 不要再用 grep 复核**，并在编辑后查看过期横幅。
- 在没有索引的工作区里，CodeGraph 会声明自己处于非活动状态并不提供任何工具 —— 是否索引始终由你决定。

确切文本见 `src/mcp/server-instructions.ts` —— 主 agent 的唯一事实来源。由于子 agent 和非 MCP 框架永远看不到 MCP 指引，安装程序还会在 agent 的指令文件中写入一段四行、以标记包裹的小节，指向 `codegraph explore` / `codegraph node` 的 CLI 等价命令。

</details>

---

## 工作原理

```
┌───────────────────────────────────────────────────────────────────┐
│                            Claude Code                            │
│                                                                   │
│   "How does a request reach the database?"                        │
│       calls CodeGraph tools directly — no Explore sub-agent       │
│                                 │                                 │
└─────────────────────────────────┬─────────────────────────────────┘
                                  │
                                  ▼
┌───────────────────────────────────────────────────────────────────┐
│                        CodeGraph MCP Server                       │
│                                                                   │
│       explore · search · callers · callees · impact · node        │
│                                 │                                 │
│                                 ▼                                 │
│                       SQLite knowledge graph                      │
│          symbols · edges · files · FTS5 full-text search          │
└───────────────────────────────────────────────────────────────────┘
```

1. **提取** —— [tree-sitter](https://tree-sitter.github.io/) 把源代码解析为 AST。语言专属的查询提取节点（函数、类、方法）和边（调用、导入、继承、实现）。

2. **存储** —— 一切都进入一个本地 SQLite 数据库（`.codegraph/codegraph.db`），带 FTS5 全文搜索。

3. **解析** —— 提取之后，引用被解析：函数调用 → 定义、导入 → 源文件、类继承，以及框架专属的模式。

4. **自动同步** —— MCP 服务器使用原生操作系统文件事件监视你的项目。变更被防抖处理（2 秒安静窗口）、仅过滤源文件，并增量同步。图随你编码保持最新 —— 无需任何配置。

---

## CLI 参考

```bash
codegraph                         # Run interactive installer
codegraph install                 # Run installer (explicit)
codegraph uninstall               # Remove CodeGraph from your agents (inverse of install)
codegraph init [path]             # Initialize in a project (--index to also index)
codegraph uninit [path]           # Remove CodeGraph from a project (--force to skip prompt)
codegraph index [path]            # Full index (--force to re-index, --quiet for less output)
codegraph sync [path]             # Incremental update
codegraph status [path]           # Show statistics
codegraph unlock [path]           # Remove a stale lock file that's blocking indexing
codegraph query <search>          # Search symbols (--kind, --limit, --json)
codegraph explore <query>         # Relevant symbols' source + call paths in one shot (same output as the codegraph_explore MCP tool)
codegraph node <symbol|file>      # One symbol's source + callers, or read a file with line numbers (same output as codegraph_node)
codegraph files [path]            # Show file structure (--format, --filter, --max-depth, --json)
codegraph callers <symbol>        # Find what calls a function/method (--limit, --json)
codegraph callees <symbol>        # Find what a function/method calls (--limit, --json)
codegraph impact <symbol>         # Analyze what code is affected by changing a symbol (--depth, --json)
codegraph affected [files...]     # Find test files affected by changes (see below)
codegraph daemon                  # Manage background daemons — pick one to stop (alias: daemons)
codegraph telemetry [on|off]      # Show or change anonymous usage telemetry
codegraph upgrade [version]       # Update to the latest release (--check, --force)
codegraph version                 # Print the installed version (also -v, --version)
codegraph help [command]          # Show help, optionally for one command
```

### `codegraph affected`

传递性地追踪导入依赖，找出哪些测试文件受变更的源文件影响。

```bash
codegraph affected src/utils.ts src/api.ts         # Pass files as arguments
git diff --name-only | codegraph affected --stdin   # Pipe from git diff
codegraph affected src/auth.ts --filter "e2e/*"     # Custom test file pattern
```

| 选项 | 说明 | 默认 |
|--------|-------------|---------|
| `--stdin` | 从 stdin 读取文件列表 | `false` |
| `-d, --depth <n>` | 最大依赖遍历深度 | `5` |
| `-f, --filter <glob>` | 用于识别测试文件的自定义 glob | 自动检测 |
| `-j, --json` | 以 JSON 输出 | `false` |
| `-q, --quiet` | 仅输出文件路径 | `false` |

**CI / hook 示例：**

```bash
#!/usr/bin/env bash
AFFECTED=$(git diff --name-only HEAD | codegraph affected --stdin --quiet)
if [ -n "$AFFECTED" ]; then
  npx vitest run $AFFECTED
fi
```

---

## MCP 工具

作为 MCP 服务器运行时，CodeGraph 暴露一组精炼的四个工具 —— 实测的 agent 行为表明，更精简的列表能引导 agent 选对工具，并在每个会话中节省上下文：

| 工具 | 用途 |
|------|---------|
| `codegraph_explore` | **主力。** 一次调用回答几乎任何问题 —— "X 如何工作"、一个流程（"X 如何到达 Y"），或勘察某个区域 —— 返回相关符号的逐字源码（按文件分组），外加一张关系图和影响范围。浮现 grep 跟不上的动态分派跳转（回调、React 重渲染、接口→实现）。 |
| `codegraph_node` | 单个符号的完整源码 + 调用者/被调用者轨迹（对于有歧义的名称返回每一个重载）—— 或传入一个文件路径来**像 Read 工具那样读取整个文件**（相同的带行号输出，`offset`/`limit`），并附带其依赖者。 |
| `codegraph_search` | 在整个代码库中按名称查找符号 |
| `codegraph_callers` | 某个函数的每一个调用点 —— 包括它被注册为回调之处 —— 当多个定义同名时，每个定义一个小节 |

另有四个工具（`codegraph_callees`、`codegraph_impact`、`codegraph_files`、`codegraph_status`）保持完全可用，但默认不列出 —— 跨多次 eval 运行实测，agent 从不或极少选用它们，而且它们的信息已经随上面四个内联到达（explore 的影响范围小节、node 的依赖者提示、把符号的函数体当作其被调用者列表）。用 `CODEGRAPH_MCP_TOOLS` 环境变量可重新启用其中任意一个（例如 `CODEGRAPH_MCP_TOOLS=explore,node,search,callers,impact`），或使用它们的 CLI 等价命令（`codegraph callees` / `impact` / `files` / `status`）。

在一个没有 `.codegraph/` 索引的工作区里，服务器会声明自己处于非活动状态并**不**列出任何工具 —— agent 照常用其内置工具工作，而是否索引始终由你决定。

---

## 作为库使用

CodeGraph 可以被直接嵌入。npm 包重新导出了它的编程式 API，因此 `import` 和 `require` 都会在你自己的进程中解析到 `CodeGraph` 类 —— 便于把它嵌入到应用中（例如一个 Electron 主进程）。

```typescript
import CodeGraph from '@colbymchenry/codegraph';
// CommonJS works too:
//   const { CodeGraph } = require('@colbymchenry/codegraph');

const cg = await CodeGraph.init('/path/to/project');
// Or: const cg = await CodeGraph.open('/path/to/project');

await cg.indexAll({
  onProgress: (p) => console.log(`${p.phase}: ${p.current}/${p.total}`)
});

const results = cg.searchNodes('UserService');
const callers = cg.getCallers(results[0].node.id);
const context = await cg.buildContext('fix login bug', { maxNodes: 20, includeCode: true, format: 'markdown' });
const impact = cg.getImpactRadius(results[0].node.id, 2);

cg.watch();   // auto-sync on file changes
cg.unwatch(); // stop watching
cg.close();
```

更底层的构件从同一入口点导出，供直接驱动图的调用方使用：`DatabaseConnection`、`QueryBuilder`、`getDatabasePath`、`initGrammars` / `loadGrammarsForLanguages`，以及 `FileLock`。

**嵌入要求**

- 从 npm 安装（`npm i @colbymchenry/codegraph`），以便匹配的逐平台包 —— 它携带编译好的库及其依赖 —— 与 shim 一起被拉取下来。
- 该 API 运行在**你的**运行时上，因此它需要 **Node 22.5+** 来支持内置的 `node:sqlite`（当 Electron 自带的 Node 为 22.5+ 时即满足）。CLI 和 MCP 服务器不受影响 —— 它们运行在自带的捆绑运行时上。
- TypeScript 类型随包一起提供。与任何面向 Node 的库一样，保持 `@types/node` 可用并设置 `skipLibCheck: true`（常见默认值）。

---

## 配置

没有任何配置 —— CodeGraph 是零配置的，**没有配置文件**需要编写或保持同步。语言支持由文件扩展名自动判定；无需逐语言进行任何接线。

它开箱即用地跳过：

- **依赖、构建和缓存目录** —— 横跨每一个[受支持的技术栈](#支持的语言)的 `node_modules`、`vendor`、`dist`、`build`、`target`、`.venv`、`Pods`、`.next` 之类 —— 这样图里是你的代码，而非第三方噪声。即便没有 `.gitignore` 也是如此。
- **你的 `.gitignore` 中的任何内容** —— 在 git 仓库里通过 git 遵循，在非 git 项目里通过直接读取 `.gitignore`（根目录和嵌套）遵循。
- **大于 1 MB 的文件** —— 生成的 bundle、压缩过的 JS、内置的二进制块。

要排除别的东西，把它加进 `.gitignore`。要把一个默认排除的目录重新拉**回**索引（比如你确实想索引某个内置依赖），加一条否定规则 —— `!vendor/`。默认规则统一生效，所以提交了某个依赖或构建目录并不会强行把它塞进图里；`.gitignore` 的否定规则才是显式的选择加入。

## 遥测

CodeGraph 收集**匿名使用统计** —— 哪些工具和命令被使用、哪些语言被索引 —— 以指导语言和 agent 支持工作的方向。**绝不**收集任何代码、路径、文件或符号名称、查询或 IP 地址；使用数据先在本地聚合为每日总量，然后才发送任何内容，而接收端点是[本仓库中的公开代码](telemetry-worker/)，它强制执行已文档化的字段列表。安装程序会一开始就询问；可随时关闭：

```bash
codegraph telemetry off    # or: CODEGRAPH_TELEMETRY=0, or DO_NOT_TRACK=1
```

[`TELEMETRY.md`](TELEMETRY.md) 列出了每一个字段，以及各个关闭开关和完整的数据处理说明。

## 支持的平台

每个发布版都为三种桌面操作系统、在 Intel/AMD（x64）和 ARM（arm64）两种架构上，提供一个自带（捆绑 Node 运行时 —— 无需编译）的构建：

| 平台 | 架构 | 安装 |
|----------|---------------|---------|
| Windows | x64、arm64 | PowerShell 安装程序或 npm |
| macOS | x64、arm64 | shell 安装程序或 npm |
| Linux | x64、arm64 | shell 安装程序或 npm |

一行安装命令见[快速开始](#快速开始)。

## 支持的 Agent

交互式安装程序会自动检测并配置以下每一个 —— 接好 MCP 服务器（它交付自己的使用指引，因此不写入指令文件）：

- **Claude Code**
- **Cursor**
- **Codex CLI**
- **opencode**
- **Hermes Agent**
- **Gemini CLI**
- **Antigravity IDE**
- **Kiro**

## 支持的语言

| 语言 | 扩展名 | 状态 |
|----------|-----------|--------|
| TypeScript | `.ts`、`.tsx` | 完全支持 |
| JavaScript | `.js`、`.jsx`、`.mjs` | 完全支持 |
| Python | `.py` | 完全支持 |
| Go | `.go` | 完全支持 |
| Rust | `.rs` | 完全支持 |
| Java | `.java` | 完全支持 |
| C# | `.cs` | 完全支持 |
| PHP | `.php` | 完全支持 |
| Ruby | `.rb` | 完全支持 |
| C | `.c`、`.h` | 完全支持 |
| C++ | `.cpp`、`.hpp`、`.cc` | 完全支持 |
| Objective-C | `.m`、`.mm`、`.h` | 部分支持（类、协议、方法、`@property`、`#import`、消息发送；`.mm` ObjC++ 可能解析不完整） |
| Swift | `.swift` | 完全支持 |
| Kotlin | `.kt`、`.kts` | 完全支持 |
| Scala | `.scala`、`.sc` | 完全支持（类、trait、方法、类型别名、Scala 3 枚举） |
| Dart | `.dart` | 完全支持 |
| Svelte | `.svelte` | 完全支持（脚本提取、Svelte 5 runes、SvelteKit 路由） |
| Vue | `.vue` | 完全支持（script + script-setup 提取，Nuxt 页面/API/中间件路由） |
| Astro | `.astro` | 完全支持（frontmatter + 脚本提取、模板组件/调用引用、`src/pages/` 路由） |
| Liquid | `.liquid` | 完全支持 |
| Pascal / Delphi | `.pas`、`.dpr`、`.dpk`、`.lpr` | 完全支持（类、记录、接口、枚举、DFM/FMX 窗体文件） |
| Lua | `.lua` | 完全支持（函数、带接收者的方法、局部变量、`require` 导入、调用边） |
| R | `.R` `.r` | 完全支持（各种赋值形式的函数，带方法的 S4/R5/R6 类，`library`/`require` 导入，`source()` 文件引用，调用边） |
| Luau | `.luau` | 完全支持（Lua 的一切，外加 `type`/`export type` 别名、带类型的签名，以及 Roblox 实例路径 `require`） |

## 实测的跨文件覆盖率

影响与影响范围查询的好坏，取决于其背后的依赖图，因此覆盖率是被测量出来的，而非断言出来的。**Fair 覆盖率** = 在每种语言一个真实世界基准仓库上，至少拥有一个*已解析的跨文件依赖者*（有东西导入、调用、引用它们，或通过框架约定路由到它们）的、承载符号的源文件所占的比例。残差始终是真正的静态分析前沿（运行时动态分派、反射 / DI 容器、框架约定入口点、内置的第三方代码），绝不通过操纵分母来掩盖。

| 语言 | 基准仓库 | 覆盖率 |
|---|---|---|
| TypeScript / JavaScript | 本仓库 | 95.8% |
| Python | psf/requests | 100% |
| Go | gin-gonic/gin | 96.6% |
| Rust | BurntSushi/ripgrep | 86.7% |
| Java | google/gson | 93.3% |
| C# | jbogard/MediatR | 85.2% |
| PHP | guzzle/guzzle | 100% |
| Ruby | sidekiq/sidekiq | 100% |
| C | redis/redis | 92.2% |
| C++ | google/leveldb | 94.8% |
| Objective-C | SDWebImage | 91.6% |
| Swift | Alamofire | 95.3% |
| Kotlin | square/okhttp | 96.2% |
| Scala | gatling/gatling | 91.2% |
| Dart | flutter/packages | 92.4% |
| Svelte / SvelteKit | sveltejs/realworld | 100% |
| Vue / Nuxt | nuxt/movies | 93.5% |
| Astro | xingwangzhe/stalux | 93.0% |
| Lua | nvim-telescope/telescope.nvim | 84.2% |
| Luau | dphfox/Fusion | 92.2% |
| Liquid | Shopify/dawn | 73.8% |
| Pascal / Delphi | PascalCoin | 77.4% |

框架路由以同样方式验证，每个框架取一个标准应用：Express 100%、FastAPI 98%、Flask 100%、NestJS 96.8%、Gin 96.5%、Axum 100%、Rocket 93.8%、Vapor 100%、Laravel 92%、Rails 89.6%、React Router 100% —— 以及那些约定/反射偏重、处于其诚实静态分析上限的：ASP.NET 83.9%、Spring 83.3%、Drupal 78.9%、Play 76.3%、Django 74.1%。SvelteKit、Vue/Nuxt 和 Astro 使用基于文件的路由，因此它们的页面/端点覆盖率即为上表中的 Svelte/SvelteKit（100%）、Vue/Nuxt（93.5%）和 Astro（93.0% —— 在两个验证仓库上，每个 `src/pages/` 文件都映射到一个 route 节点）这些数字。

## 故障排查

**"CodeGraph not initialized"** —— 先在你的项目目录中运行 `codegraph init`。

**索引很慢** —— 检查 `node_modules` 和其他大目录是否被排除。用 `--quiet` 减少输出开销。

**MCP 遇到 `database is locked`** —— 当前构建不应出现：CodeGraph 自带 Node 运行时，并以 WAL 模式使用 Node 内置的 `node:sqlite`，在该模式下并发读取永远不会被写入者阻塞。如果你仍然看到它：

- **你装的是旧版（0.9 之前）。** 重新安装以获取捆绑运行时 —— `curl -fsSL https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.sh | sh`（macOS/Linux）、`irm https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.ps1 | iex`（Windows），或 `npm i -g @colbymchenry/codegraph@latest`。
- **`codegraph status` 显示 `Journal:` 不是 `wal`** —— WAL 在这个文件系统上无法启用（在网络共享和 WSL2 `/mnt` 上很常见），所以读取会被写入阻塞。把项目（连同它的 `.codegraph/` 文件夹）移到本地磁盘上。

**MCP 服务器无法连接** —— 你的 agent 会自己启动服务器，所以你不用手动去启动它。确保项目已初始化并索引（`codegraph status`），且你 MCP 配置中的路径正确。如果它仍然连不上，重新运行 `codegraph install` 来重写配置。

**符号缺失** —— MCP 服务器在保存时自动同步（等待几秒）。需要时手动运行 `codegraph sync`。检查该文件的语言是否受支持，以及它是否位于被 `.gitignore` 忽略或默认排除的目录内（例如 `node_modules`、`dist`）。

**在 Windows 和 WSL 之间共享同一个检出** —— 不要让两者指向同一个 `.codegraph/`：后台服务器锁和 SQLite 索引与写入它们的操作系统绑定，而跨 WSL2/Windows 文件系统边界的 SQLite 加锁并不可靠。在同一棵目录树里给每一侧各自的索引：在其中一侧把 `CODEGRAPH_DIR` 设为一个不同的名字 —— 例如在 Windows 上设 `CODEGRAPH_DIR=.codegraph-win`，让 WSL 保持默认的 `.codegraph`。CodeGraph 在索引和监视时会跳过任何兄弟 `.codegraph-*` 目录，所以两者永不互相干扰。

## Star 历史

<a href="https://www.star-history.com/?repos=colbymchenry%2Fcodegraph&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=colbymchenry/codegraph&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=colbymchenry/codegraph&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=colbymchenry/codegraph&type=date&legend=top-left" />
 </picture>
</a>

## 许可证

MIT

---

<div align="center">

**为 AI 编码 agent 打造 —— Claude Code、Cursor、Codex CLI、opencode、Hermes Agent、Gemini CLI、Antigravity IDE 和 Kiro**

[报告 Bug](https://github.com/colbymchenry/codegraph/issues) · [功能请求](https://github.com/colbymchenry/codegraph/issues)

</div>
