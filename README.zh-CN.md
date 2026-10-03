<div align="center">

# CodeGraph

<p><a href="./README.md">English</a> · <a href="./README.zh-CN.md">简体中文</a></p>

已经装过了？运行 `codegraph upgrade`

在 X 上关注 [@getcodegraph](https://x.com/getcodegraph) 获取更新。

### 用语义代码智能增强 Claude Code、Cursor、Codex、OpenCode、Hermes Agent、Gemini、Antigravity、Kiro 和 GitHub Copilot

**最快的完整代码图 · 精确上下文 · 按 Agent 真实工作方式设计 · 100% 本地**

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/colbymchenry/codegraph/main/assets/rust-logo-dark.svg?v=1">
  <img src="https://raw.githubusercontent.com/colbymchenry/codegraph/main/assets/rust-logo.svg?v=1" height="30" alt="Rust" align="center">
</picture>&nbsp; **内核由 Rust 驱动**

### [文档与网站 →](https://colbymchenry.github.io/codegraph/)

[![npm version](https://img.shields.io/npm/v/@colbymchenry/codegraph.svg)](https://www.npmjs.com/package/@colbymchenry/codegraph)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Self-contained](https://img.shields.io/badge/Node.js-bundled%20%C2%B7%20none%20required-brightgreen.svg)](https://nodejs.org/)
[![npm provenance](https://img.shields.io/badge/npm-provenance-brightgreen.svg)](#verified-releases)
[![Attested builds](https://img.shields.io/badge/releases-signed%20%26%20attested-brightgreen.svg)](#verified-releases)

[![Windows](https://img.shields.io/badge/Windows-supported-blue.svg)](#supported-platforms)
[![macOS](https://img.shields.io/badge/macOS-supported-blue.svg)](#supported-platforms)
[![Linux](https://img.shields.io/badge/Linux-supported-blue.svg)](#supported-platforms)

[![Claude Code](https://img.shields.io/badge/Claude_Code-supported-blueviolet.svg)](#supported-agents)
[![Cursor](https://img.shields.io/badge/Cursor-supported-blueviolet.svg)](#supported-agents)
[![Codex](https://img.shields.io/badge/Codex-supported-blueviolet.svg)](#supported-agents)
[![opencode](https://img.shields.io/badge/opencode-supported-blueviolet.svg)](#supported-agents)
[![Hermes Agent](https://img.shields.io/badge/Hermes_Agent-supported-blueviolet.svg)](#supported-agents)
[![Gemini](https://img.shields.io/badge/Gemini-supported-blueviolet.svg)](#supported-agents)
[![Antigravity](https://img.shields.io/badge/Antigravity-supported-blueviolet.svg)](#supported-agents)
[![Kiro](https://img.shields.io/badge/Kiro-supported-blueviolet.svg)](#supported-agents)
[![GitHub Copilot](https://img.shields.io/badge/GitHub_Copilot-supported-blueviolet.svg)](#supported-agents)

<br>

**CodeGraph 平台即将到来** — 每一次 PR，都能准确知道该测什么、什么可能坏掉、哪些流程受影响，以及业务逻辑是否被破坏。

<a href="https://getcodegraph.com"><img alt="Join the waitlist for early beta access" src="https://raw.githubusercontent.com/colbymchenry/codegraph/main/assets/waitlist.svg?v=2" height="52"></a>

<sub>获取托管产品的 <b>early beta</b> 资格 · <a href="https://getcodegraph.com">getcodegraph.com</a></sub>

</div>

## 目录

- [开始使用](#开始使用)
- [语言支持](#语言支持)
- [为什么选择 CodeGraph？](#为什么选择-codegraph)
- [主要特性](#主要特性)
- [在浏览器里阅读你的图](#在浏览器里阅读你的图)
- [框架感知路由](#框架感知路由)
- [混合 iOS / React Native / Expo 桥接](#混合-ios--react-native--expo-桥接)
- [快速开始](#快速开始)
- [工作原理](#工作原理)
- [CLI 参考](#cli-参考)
- [MCP 工具](#mcp-工具)
- [作为库使用](#作为库使用)
- [配置](#配置)
- [遥测](#遥测)
- [已验证的发布](#verified-releases)
- [支持的平台](#supported-platforms)
- [支持的 Agent](#supported-agents)
- [支持的语言](#supported-languages)
- [实测跨文件覆盖率](#实测跨文件覆盖率)
- [故障排查](#故障排查)
- [许可证](#许可证)

## 开始使用

### 1. 安装 CLI

**不需要 Node.js** — 一条命令即可下载适合你操作系统的构建：

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.sh | sh

# Windows (PowerShell)
irm https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.ps1 | iex
```

<details>
<summary><b>已经有 Node？改用 npm（任意版本都可以）</b></summary>

```bash
npm i -g @colbymchenry/codegraph
```

<sub>CodeGraph 自带运行时 — 不用编译，没有原生构建，到处都一样。安装器会把 `codegraph` 放进 PATH，但 **不会改你当前这个 shell** — 下一步请开一个新终端，命令才能解析到。</sub>

<sub>**随时升级** 用 `codegraph upgrade` — 它会识别你当初怎么装的（bundle、npm 或 npx）并原地更新。加 `--check` 只查看是否有新版本，或 `codegraph upgrade <version>` 钉到指定版本。</sub>

</details>

### 2. 接入你的 Agent

在一个 **新终端** 里运行安装器，把 CodeGraph 接到你使用的 Agent 上：

```bash
codegraph install
```

<sub>会检测并自动配置 Claude Code、Cursor、Codex CLI、opencode、Hermes Agent、Gemini CLI、Antigravity IDE、Kiro 和 GitHub Copilot（VS Code、Copilot CLI、JetBrains IDE）— 把 CodeGraph MCP 服务器接到每一个上面。**真正把 CodeGraph 接到 Agent 上的是这一步；** 第 1 步只装 CLI，不会自动完成接入。它只接线，**不会** 给任何代码建索引；每个项目的图要在第 3 步用 `codegraph init` 单独构建。（快捷方式：`npx @colbymchenry/codegraph` 一次下载并跑完安装器。）</sub>

### 3. 初始化每个项目

```bash
cd your-project
codegraph init
```

<sub>`codegraph init` 会创建本地 `.codegraph/` 目录，并在同一步构建完整的图 — 一条命令就完成。</sub>

<div align="center">

![1_C_VYnhpys0UHrOuOgpgoyw](https://github.com/user-attachments/assets/f168182f-4d9a-44e0-94d7-08d018cc8a3a)

</div>

### 4. 再也不用手动同步

默认开启自动同步。CodeGraph 会监视项目，每次文件变化都更新图 — 无论是 Agent 在改代码，还是你自己新增、修改、删除文件。**索引不会过期，也没有需要反复跑的命令。**

### 5. 看见 Agent 所看见的

```bash
codegraph ui
```

在浏览器打开图，地址是 `http://127.0.0.1:4747` — 左边是调用者，中间是该符号的源码，右边是它调用的内容。详见
[在浏览器里阅读你的图](#在浏览器里阅读你的图)。

### 卸载

改主意了？一条命令会从它配置过的每一个 Agent 里移除 CodeGraph，**同时卸掉 CLI 本身** — 它能找到的每一种安装（独立 bundle、npm 全局包、启动器链接）都会先列给你看，再删除：

```bash
codegraph uninstall
```

加 `--keep-cli` 则只移除 Agent 配置，保留已安装的 CLI。

<sub>相当于安装器的逆操作 — 从每个已配置的 Agent 里剥掉 CodeGraph 的 MCP 服务器配置、说明文字和权限。项目索引（`.codegraph/`）不会动；要按项目删掉它们，用 `codegraph uninit`。用 `--target` 只从指定 Agent 移除，或 `--yes` 非交互运行。</sub>

---

## 语言支持

下面每一种语言都按同样方式处理 — 完整结构抽取和跨文件解析，合成一张图，不需要按语言单独配置：

<p align="center">
  <img src="https://raw.githubusercontent.com/colbymchenry/codegraph/main/assets/languages/typescript.svg?v=1" width="104" height="104" alt="TypeScript" />
  <img src="https://raw.githubusercontent.com/colbymchenry/codegraph/main/assets/languages/javascript.svg?v=1" width="104" height="104" alt="JavaScript" />
  <img src="https://raw.githubusercontent.com/colbymchenry/codegraph/main/assets/languages/arkts.svg?v=1" width="104" height="104" alt="ArkTS" />
  <img src="https://raw.githubusercontent.com/colbymchenry/codegraph/main/assets/languages/python.svg?v=1" width="104" height="104" alt="Python" />
  <img src="https://raw.githubusercontent.com/colbymchenry/codegraph/main/assets/languages/go.svg?v=1" width="104" height="104" alt="Go" />
  <img src="https://raw.githubusercontent.com/colbymchenry/codegraph/main/assets/languages/rust.svg?v=1" width="104" height="104" alt="Rust" />
  <img src="https://raw.githubusercontent.com/colbymchenry/codegraph/main/assets/languages/java.svg?v=1" width="104" height="104" alt="Java" />
  <img src="https://raw.githubusercontent.com/colbymchenry/codegraph/main/assets/languages/csharp.svg?v=1" width="104" height="104" alt="C#" />
  <img src="https://raw.githubusercontent.com/colbymchenry/codegraph/main/assets/languages/php.svg?v=1" width="104" height="104" alt="PHP" />
  <img src="https://raw.githubusercontent.com/colbymchenry/codegraph/main/assets/languages/ruby.svg?v=1" width="104" height="104" alt="Ruby" />
  <img src="https://raw.githubusercontent.com/colbymchenry/codegraph/main/assets/languages/c.svg?v=1" width="104" height="104" alt="C" />
  <img src="https://raw.githubusercontent.com/colbymchenry/codegraph/main/assets/languages/cpp.svg?v=1" width="104" height="104" alt="C++" />
  <img src="https://raw.githubusercontent.com/colbymchenry/codegraph/main/assets/languages/objective-c.svg?v=1" width="104" height="104" alt="Objective-C" />
  <img src="https://raw.githubusercontent.com/colbymchenry/codegraph/main/assets/languages/metal.svg?v=1" width="104" height="104" alt="Metal" />
  <img src="https://raw.githubusercontent.com/colbymchenry/codegraph/main/assets/languages/cuda.svg?v=1" width="104" height="104" alt="CUDA" />
  <img src="https://raw.githubusercontent.com/colbymchenry/codegraph/main/assets/languages/swift.svg?v=1" width="104" height="104" alt="Swift" />
  <img src="https://raw.githubusercontent.com/colbymchenry/codegraph/main/assets/languages/kotlin.svg?v=1" width="104" height="104" alt="Kotlin" />
  <img src="https://raw.githubusercontent.com/colbymchenry/codegraph/main/assets/languages/scala.svg?v=1" width="104" height="104" alt="Scala" />
  <img src="https://raw.githubusercontent.com/colbymchenry/codegraph/main/assets/languages/dart.svg?v=1" width="104" height="104" alt="Dart" />
  <img src="https://raw.githubusercontent.com/colbymchenry/codegraph/main/assets/languages/svelte.svg?v=1" width="104" height="104" alt="Svelte" />
  <img src="https://raw.githubusercontent.com/colbymchenry/codegraph/main/assets/languages/vue.svg?v=1" width="104" height="104" alt="Vue" />
  <img src="https://raw.githubusercontent.com/colbymchenry/codegraph/main/assets/languages/astro.svg?v=1" width="104" height="104" alt="Astro" />
  <img src="https://raw.githubusercontent.com/colbymchenry/codegraph/main/assets/languages/liquid.svg?v=1" width="104" height="104" alt="Liquid" />
  <img src="https://raw.githubusercontent.com/colbymchenry/codegraph/main/assets/languages/delphi.svg?v=1" width="104" height="104" alt="Pascal / Delphi" />
  <img src="https://raw.githubusercontent.com/colbymchenry/codegraph/main/assets/languages/lua.svg?v=1" width="104" height="104" alt="Lua" />
  <img src="https://raw.githubusercontent.com/colbymchenry/codegraph/main/assets/languages/r.svg?v=1" width="104" height="104" alt="R" />
  <img src="https://raw.githubusercontent.com/colbymchenry/codegraph/main/assets/languages/luau.svg?v=1" width="104" height="104" alt="Luau" />
  <img src="https://raw.githubusercontent.com/colbymchenry/codegraph/main/assets/languages/cfml.svg?v=1" width="104" height="104" alt="CFML" />
  <img src="https://raw.githubusercontent.com/colbymchenry/codegraph/main/assets/languages/cobol.svg?v=1" width="104" height="104" alt="COBOL" />
  <img src="https://raw.githubusercontent.com/colbymchenry/codegraph/main/assets/languages/vbnet.svg?v=1" width="104" height="104" alt="Visual Basic .NET" />
  <img src="https://raw.githubusercontent.com/colbymchenry/codegraph/main/assets/languages/erlang.svg?v=1" width="104" height="104" alt="Erlang" />
  <img src="https://raw.githubusercontent.com/colbymchenry/codegraph/main/assets/languages/solidity.svg?v=1" width="104" height="104" alt="Solidity" />
  <img src="https://raw.githubusercontent.com/colbymchenry/codegraph/main/assets/languages/terraform.svg?v=1" width="104" height="104" alt="Terraform / OpenTofu" />
  <img src="https://raw.githubusercontent.com/colbymchenry/codegraph/main/assets/languages/nix.svg?v=1" width="104" height="104" alt="Nix" />
</p>

<sub>每种语言的细节 — 扩展名、框架、以及具体抽取什么 — 见 [支持的语言](#supported-languages)。</sub>

---

## 为什么选择 CodeGraph？

当 AI Agent 需要理解代码 — 回答一个问题，或做一次改动 — 它发现结构的方式很慢：grep、glob、Read，一次一个文件，亲手拼调用路径和依赖。还没开始真正干活，就已经堆了一堆工具调用和来回往返。

**CodeGraph 一次调用就把 Agent 真正需要的代码交到它手里。** 这是一张预先建好的知识图，覆盖你代码库里的每一个符号、调用边和依赖 — 所以 Agent 不用爬文件，问一个问题就能拿到相关源码、这些符号之间的调用路径（包括 grep 跟不到的动态分发跳转），以及一次改动的爆炸半径。**精确上下文，而不是逐文件搜索** — 无论仓库大还是小，都意味着更少的工具调用、更快的回答。

<img width="1536" height="1024" alt="token-cost-savings-scale" src="https://github.com/user-attachments/assets/eb74a11a-a3ab-4b01-80a6-19f78352ae8e" />

> **关于成本：** CodeGraph 在 *每一个* 代码库上的胜处都是精度 — Agent 不再爬文件，而是从图里作答。在当前模型上，这种精度也是一笔很大的直接节省：2026-08 的复测，在两边都拦截 CLI 的 harness 上，七个基准仓库平均 **成本低 44%、token 少 62%**，因为没有这张图的强模型会把预算花在重新推导结构上。成本更跟着问题需要多少 *发现* 走，而不是仓库原始体积：文件阅读 Agent 需要 28–43 次工具调用才能答上的问题可省 57–78%；它 7 次就走到的地方则几乎打平。

> **关于上下文：** 上面的数字量的是 *吞吐* — 处理了多少 token、调用了多少工具、花了多少钱才得到一个答案。它们不衡量回答之后还留在上下文窗口里的东西，而在那条轴上 CodeGraph 占用的是 **更多**，不是更少。同样七个仓库的多轮会话里，CodeGraph 的回答在会话结束时大约会留下 **多 80% 的检索上下文常驻** — 在 VS Code 上是 67k token 对 18k。机制和它为什么快是同一件事：CodeGraph 返回一份稠密、逐字的载荷，答完问题后还留在窗口里；而 grep-and-read 的 Agent 会刷过许多小结果，随后被挤出去。更少的 *处理* token 和更大的持久 *占用* 可以同时成立。如果你在小窗口里跑长会话，请为此留预算。按仓库测量：[docs/benchmarks/residual-context-occupancy.md](docs/benchmarks/residual-context-occupancy.md)。

### 基准结果

在 **7 个真实开源代码库**、覆盖 7 种语言上测试，比较一个 Agent（Claude Code，无头模式）回答同一个架构问题，**有** 和 **没有** CodeGraph，**每臂 4 次取中位数**。_于 2026-08-05 在 **Claude Opus 4.8** 与当前构建上复测；harness 在 **两臂** 都拦截 `codegraph` CLI — 污染行：无图臂 28 次运行中 0 次污染。_

> **普遍的胜处 — 每个仓库、每种体量：工具调用少 88% · 快 53% · token 少 62% · 便宜 44% · 七个仓库的文件读取全部降到零。**

有索引时，Agent 用一到四次 `codegraph_explore` 就停。没有它，Agent 把预算烧在发现上 — 最多 **43 次工具调用和 19 次文件读取**，去重新推导图里已经知道的东西。这次测量里每个仓库有 CodeGraph 都更快 — 最窄的问题快 35%，最宽的快 3.6 倍。

| 代码库 | 语言 | 工具调用 | 时间 | 文件读取 | Tokens | 成本 |
|----------|----------|------------|------|------------|--------|------|
| **VS Code** | TypeScript · ~11k 文件 | **2 vs 28** | **快 2.2×**（58s vs 2m 10s） | **0** vs 12 | 少 77% | 便宜 71% |
| **Excalidraw** | TypeScript · ~640 | **2 vs 43** | **快 3.6×**（45s vs 2m 42s） | **0** vs 18 | 少 84% | 便宜 78% |
| **Django** | Python · ~3k | 3 vs 14 | 快 35%（54s vs 1m 23s） | **0** vs 8.5 | 少 41% | 便宜 13%¹ |
| **Tokio** | Rust · ~790 | 3 vs 29 | **快 2.6×**（1m 3s vs 2m 43s） | **0** vs 19 | 少 65% | 便宜 64% |
| **OkHttp** | Java · ~645 | 1 vs 6 | 快 43%（33s vs 58s） | **0** vs 2 | 少 54% | 便宜 21% |
| **Gin** | Go · ~110 | 1 vs 7 | 快 39%（28s vs 46s） | **0** vs 4 | 少 52% | 几乎持平¹ |
| **Alamofire** | Swift · ~110 | 4 vs 33 | **快 2.6×**（54s vs 2m 22s） | **0** vs 16.5 | 少 59% | 便宜 57% |

<sub>¹ 成本跟着问题需要多少 *发现* 走，所以这一列波动远大于其他列：文件阅读臂需要 28–43 次工具调用的仓库可省 57–78%，但 Django 只有 13%，Gin 持平，因为那边分别 14 次和 7 次就走到了。有图的一臂仍然用 3 次和 1 次调用、零文件读取作答。**文件读取** = 打开文件数的中位数 — 精确上下文的胜利写在这一列：有 CodeGraph 时，七个仓库上 Agent 从不读文件。</sub>

<details>
<summary><strong>按仓库拆分 — WITH vs WITHOUT（4 次中位数）</strong></summary>

| 代码库 | 指标 | WITH cg | WITHOUT cg |
|---|---|---|---|
| **VS Code** | Time / Tools / Tokens / Cost | 58s / 2 / 155k / $0.53 | 2m 10s / 28 / 670k / $1.80 |
| **Excalidraw** | Time / Tools / Tokens / Cost | 45s / 2 / 156k / $0.54 | 2m 42s / 43 / 991k / $2.43 |
| **Django** | Time / Tools / Tokens / Cost | 54s / 3 / 183k / $0.55 | 1m 23s / 14 / 309k / $0.63 |
| **Tokio** | Time / Tools / Tokens / Cost | 1m 3s / 3 / 201k / $0.66 | 2m 43s / 29 / 573k / $1.83 |
| **OkHttp** | Time / Tools / Tokens / Cost | 33s / 1 / 107k / $0.39 | 58s / 6 / 230k / $0.50 |
| **Gin** | Time / Tools / Tokens / Cost | 28s / 1 / 87k / $0.31 | 46s / 7 / 180k / $0.31 |
| **Alamofire** | Time / Tools / Tokens / Cost | 54s / 4 / 209k / $0.54 | 2m 22s / 33 / 505k / $1.27 |

</details>

<details>
<summary><strong>完整基准细节</strong></summary>

**方法。** 每一臂都是 `claude -p`（Claude Opus 4.8，`claude-opus-4-8`）无头跑在仓库上，带 `--strict-mcp-config`：**WITH** = 启用 CodeGraph 的 MCP 服务器，**WITHOUT** = 空的 MCP 配置。两边都仍可使用内置 Read/Grep/Bash。每个仓库同一问题，**每臂 4 次，报告中位数**。成本 = 该次运行的 `total_cost_usd`；Tokens = 处理的总 token，按 assistant 轮次加总（input 含 cache reads + cache creation + output）；时间 = 墙钟；工具调用 = 每一次工具调用，包括模型拉起的任何子 Agent 内部的调用。仓库以 `--depth 1` 克隆，并由为它们服务的同一份 CodeGraph 构建建立索引。于 2026-08-05 在当前构建上复测。

**两臂都拦截 `codegraph` CLI。** 一份清洗过的 `PATH` 加上 `PreToolUse` hook，会拒绝任何通过 Bash 调用 CLI 的行为，无图臂和有图臂一样。这很重要：没有这道拦截，对照组就不是对照。在未拦截的 harness 上，我们测到 WITHOUT Agent 在 PATH 上找到 CLI，并在 **28 次中的 26 次** 通过 Bash 走到 CodeGraph — 这会从两个方向扭曲比较，因为一次 CLI 调用不算工具调用，它的输出却仍进入窗口。更早公布的数字是在没有这道拦截时产生的。上面这次运行里，28 次 WITHOUT 全部尝试过 CLI，**28 次全部被拦住 — 0 次污染**。

**问题：**
| 代码库 | 问题 |
|----------|-------|
| VS Code | "How does the extension host communicate with the main process?" |
| Excalidraw | "How does Excalidraw render and update canvas elements?" |
| Django | "How does Django's ORM build and execute a query from a QuerySet?" |
| Tokio | "How does tokio schedule and run async tasks on its runtime?" |
| OkHttp | "How does OkHttp process a request through its interceptor chain?" |
| Gin | "How does gin route requests through its middleware chain?" |
| Alamofire | "How does Alamofire build, send, and validate a request?" |

**CodeGraph 为什么赢：** 有索引时，Agent 直接作答 — 通常一次 `codegraph_explore` 就返回相关源码 — 然后停下，每个基准仓库上都是零文件读取。没有它，Agent 把大部分预算花在发现上（find/ls/grep），然后才读到正确的代码。CodeGraph 只有被 *直接* 查询时才有帮助，所以它的说明会引导 Agent 直接作答，而不是把探索委派给读文件的子 Agent — 否则子 Agent 照样读文件，CodeGraph 就变成开销。

</details>

---

## 为速度而建 — Rust 内核

CodeGraph 的解析引擎是 **原生 Rust 内核**：20 种语言 — TypeScript、JavaScript、Java、Python、Go、C、C++、Rust、C#、Ruby、PHP、Swift、Kotlin、Scala、Dart、R、Lua、Luau（Metal 和 CUDA 走 C++ 路径）— 在编译后的代码里解析，每个文件只跨一次边界。每种语言都是在真实仓库上证明图与参考引擎 **逐字节一致** 之后才发布的，从小库一直到 Linux 内核；没有预构建二进制的平台、以及有语法错误的文件，会按文件自动回退，两种路径得到同一张图。

**而且它会按所在机器自我缩放。** Worker 池、并行解析和分析缓存，都按系统实际拥有的资源来定大小 — 真实核心数（感知容器/cgroup，所以只给 2 核的 VPS 会按 2 核定，而不是宿主机的 64 核）、在 macOS 和 Linux 上诚实测到的可用 RAM，以及 *你这个* 项目解析工作的实测成本：

- **在工作站上：** 完整并行流水线 — 原生解析 worker、一旦划算就会接入的多 worker 解析池、受内存门控的分析缓存。Swift 编译器仓库（2.7 万个 Swift 和 C++ 文件）全新索引大约 100 秒；改一个文件再同步约 4 秒。
- **在 2 核 / 6GB 的 VPS 上：** 同一张图，流水线调成 *能跑完* — Linux 内核（7 万文件、200 万符号、640 万关系）在 12 分钟内索引完成；而 RAM 优先的设计会在到达 1% 之前就内存耗尽。
- **第一天之后的每一天：** 保存一个文件会在远不到一秒内更新图 — 单独一次保存后约 300ms watcher 触发，并且只同步改动的部分（4400 文件的项目约 0.3s，2.7 万文件的 Swift 编译器仓库约 0.4s），从不重新扫描整棵树。对比最快竞品「有改动就整库重索引」：在 31 个仓库、30 种语言的基准上，中型和更大的仓库快 2–7 倍 — 仓库越大差距越大，因为它们的成本跟着仓库涨，我们的成本跟着这次改动涨。

---

## 主要特性

| | |
|---|---|
| **原生 Rust 内核** | 20 种语言的解析和抽取跑在编译后的 Rust 引擎里 — 图与参考引擎逐字节验证一致，并按文件自动回退，所以什么都不会坏 |
| **适应你的机器** | Worker 池和缓存按系统实际拥有的资源定大小 — 真实核心数（感知容器）、诚实的可用 RAM、按项目测到的成本。工作站拿到完整并行流水线；2 核 VPS 拿到一份调成能稳定跑完的流水线 |
| **精确上下文** | 一次工具调用返回入口点、相关符号和代码片段 — 不用慢慢逐文件探索 |
| **全文搜索** | 按名字在整个代码库里瞬间查找，由 FTS5 驱动 |
| **影响分析** | 在改之前追踪调用者、被调用者，以及任意符号的完整影响半径 |
| **始终新鲜** | 文件监视使用原生 OS 事件（FSEvents/inotify/ReadDirectoryChangesW），带去抖自动同步 — 你写代码时图保持最新，零配置 |
| **20+ 种语言** | TypeScript、JavaScript、ArkTS、Python、Go、Rust、Java、C#、VB.NET、PHP、Ruby、C、C++、CUDA、Objective-C、Metal、Swift、Kotlin、Scala、Dart、Lua、Luau、R、Nix、Erlang、CFML、COBOL、Solidity、Terraform/OpenTofu、Svelte、Vue、Astro、Liquid、Pascal/Delphi |
| **框架感知路由** | 识别 Web 框架的路由文件，把 URL 模式连到处理函数，覆盖 17 种框架 |
| **混合 iOS / React Native / Expo** | 补上静态解析跨不过去的跨语言流：Swift ↔ ObjC 桥接、React Native legacy bridge + TurboModules + Fabric 视图组件、native → JS 事件发射器、Expo Modules |
| **100% 本地** | 没有数据离开你的机器。没有 API key。没有外部服务。只有 SQLite 数据库 |

<details>
<summary><strong>自动同步怎么工作 — 以及为什么你不必手动跑 <code>codegraph sync</code></strong></summary>

当你的 Agent（Claude Code、Cursor、Codex、opencode）启动 `codegraph serve --mcp` 时，三层机制让索引跟着代码走 — 并确保在编辑和下一次同步之间那一小段窗口里，Agent 不会拿到一声不响的错误答案：

1. **带去抖自动同步的文件监视。** 原生 FSEvents / inotify / ReadDirectoryChangesW watcher 捕获每一次源文件的创建 / 修改 / 删除，并在去抖窗口之后触发重索引（默认 `2000ms`，可用 `CODEGRAPH_WATCH_DEBOUNCE_MS` 调整，限制在 `[100ms, 60s]`）。一阵连改会收成一次同步。

2. **按文件的过期横幅。** 在短暂的去抖窗口里，如果 MCP 工具响应会引用仍在等待中的文件，会在前面加上 `⚠️` 横幅，点名该文件并告诉 Agent 直接 `Read` 它。响应没有引用到的 pending 文件则出现在一个小页脚里。无论哪种，Agent 都会拿到明确信号 — 在 Claude Code 上验证过，Agent 会字面说出 “Reading the file directly for the live content” 再打开它。

3. **连接时补齐。** MCP 服务器（重新）连接时，codegraph 会在回答第一个查询之前，用一次快速的 `(size, mtime)` + 内容哈希对照工作树 — 所以没有 MCP 服务器在跑时发生的编辑（终端里的 `git pull`、另一个编辑器的改动、上一次已退出的 Agent 会话）会在下一会话的第一次工具调用时被吸收。

```
agent writes src/Widget.ts
  → watcher fires (<100ms)
  → debounce (default 2s)
  → sync; Widget.ts is in the index
  → next agent query sees it
```

**随时用 CLI 的 `codegraph status` 核对。** 如果有东西在等待，你会看到 `### Pending sync:` 一节，列出文件和它们的编辑年龄。

少数适合手动 `codegraph sync` 的情况：watcher 被关掉了（沙箱环境，或 `CODEGRAPH_NO_DAEMON=1`），或者你在 Agent 会话之外对着索引写脚本，希望在脚本开头先做一次预同步。

→ 完整深入见 [Guides → Indexing a Project](https://colbymchenry.github.io/codegraph/guides/indexing/#stay-fresh-automatically)。

</details>

---

## 在浏览器里阅读你的图

`codegraph ui` 会为已经建过索引的项目打开查看器。它就是 Agent 在读的那同一张图，摊在屏幕上：选一个符号，你会看到 **左边是谁调用它**，**中间是逐字源码**，**右边是它调用的内容 — 每一项都画在发出那次调用的那一行的高度上**。

```bash
codegraph init          # once per project, if you haven't already
codegraph ui            # opens http://127.0.0.1:4747 in your browser
```

<img src="https://raw.githubusercontent.com/colbymchenry/codegraph/main/assets/codegraph-ui-symbol-view.png?v=1" alt="The CodeGraph viewer: callers on the left, the symbol's source in the middle with a marker on every calling line, and the symbols it calls on the right, each level with its call site" width="100%">

这个屏幕上你会得到：

- **按文件分组的调用者**，每一个都带上它发出调用的精确行 — 点一下就能跳过去。测试调用者收成一行，好让真正的调用者留在视野里。
- **真正的源码**，带语法高亮，每一行只要调用了什么，装订线里就有一个标记。
- **右边的被调用者**，放在调用它们的那一行，用一根细线连起来。悬停任意一端，两端都会亮。
- **爆炸半径** — 直接依赖者、三跳之内的一切，以及这会碰到多少文件和测试文件。
- **诚实的边。** CodeGraph 没把握的猜测会收成 “uncertain”，而不是当成事实摆出来；三跳之内没有任何测试能到达的符号也会说出来。
- **搜索**（`/` 或 ⌘K）覆盖每一个符号和文件，以及你走过的 **trail** 就活在 URL 里，所以可以把你走的精确路线发给别人。输入名字还会在单独的标题下带出匹配的 **入口点**，于是一个 URL 会连同为它服务的符号一起回来，而不是孤零零一个地址。
- **入口点** — 你从没打开过的代码库上该看的第一屏，也是 “任何事情从哪开始” 的答案。每一条路由及其处理函数、以及它注册所在的行，按路由文件分组，并用检测到的框架命名；在 import 时就会跑起来的文件（CLI、worker 入口、脚本）；测试，按各自覆盖项目的多少排序；以及最多代码所依赖的符号。没有任何东西是从文件名猜的 — 全是从图里读出来的，没有路由的项目会直接说没有，而不是画一张空列表。任何点名一个符号的行都可以开始一条 **flow**：再挑第二个符号，你就得到它们之间的路径，所以 “`POST /v1/payroll/cycles/{cycleID}/run` 怎么到达数据库” 是两次点击。
- 点任何文件路径打开 **文件视图**：这个文件依赖的一切、按源码顺序的大纲、以及依赖它的一切。它的 **Source** 页签展示整个文件，同样的装订线标记，再加上左边距里每一条留在文件内部的调用弧 — 因为源码顺序就是布局，这是文件内部调用结构唯一能一眼读懂的地方。6800 行的文件也能全速滚动。
- **问一条路径。** 输入 “how does execute reach getFile”（或 `execute -> getFile`）你会得到 **flow**：一跳一张卡片，每张都打开在发出下一次调用的那一行。图上没有静态边的跳转 — 回调、接口分发、React 重渲染 — 画成虚线，并写明 handler 是在哪里接上的。“Read as flow” 把你亲手走的一趟变成同一条带子。
- **路走到头时，它会说停在哪。** 到不了的 flow 会停在 “Where the graph stops”：结束它的那种分发（计算出来的成员调用、`getattr`、反射 invoke、消息总线）、它所在的行、源码里写明的 key，以及另一侧可能是什么的短名单 — 外加 CodeGraph 拒绝跟随的仅按名字匹配及其置信度。没有猜测；真正连上的 flow 从不会显示这一段。
- **从这里会发生什么。** 在有屏幕的应用上，**Screens** 页签一屏一个方块，每一种从一屏到另一屏的走法都是一条箭头，并标上它发生的条件。**Steps** 页签对一屏 *上* 发生的事做同样的事：选一屏（或任意符号），你会得到它的 handler、跨进 native 的调用、native 事件怎么回来、它写入的 store action 以及离开应用的请求，都是带类型的步骤，它们之间的管道折进箭头里 — 一个 React Native 应用从采集到上传的整条流，一张图，每一步都可以点成下一个锚点或一条 Flow 带子。
- **地图**：整个项目按模块粒度，从图里排布，依赖朝下 — 从不手摆，每次都是同一张图。环列出来，而不是被拉直藏掉。
- **把图带走。** 一条 flow 带子或一张地图可以复制成图片直接贴进 PR 评论，或存成 SVG 放进 README — 永远是浅色主题，不管你正在用哪套阅读，并带一句说明这张图是什么。SVG 是真正的文字，所以任意尺寸都清晰，里面的名字可以选中。
- **留下一次行走。** 在 trail 条上按 **Save trail**，起个名字，这条路径就被留下 — 列在空白屏和入口点上、建议的上面，并从你离开的那个符号重新打开，整段行走都恢复。步骤按它们 *是什么* 记住，而不是当时坐在哪，所以描述它的代码被改过，保存的 trail 也能活下来；真的挪了位置时，它会说哪一步动了、哪一步被改名走了、这段行走还剩多少能打开。Trail 是 `.codegraph/ui/trails/` 下的普通 JSON（git 已经忽略它），**Export** 会把文件交给你，如果你更想提交一份。
- **它跟得上。** 保存一个文件后大约三分之一秒会出现横幅，说索引还没赶上 — 屏幕会切到文件现在的源码，而不是按它已经不再拥有的行切出来的正文。有东西重新索引时，屏幕上无论什么都会自己再读一遍，并说 “Index updated · reloaded”。你在上面加了两行而导致符号挪位时，它会跟上，而不是弄丢。没有轮询：查看器在监视；如果和服务器失联，它会重试几次，然后说出来，而不是不停砸它。

选项：`--port <n>` 钉死一个端口（不指定时查看器占用 4747，或下一个空闲端口），
`--no-open` 只打印 URL（无头机器或 SSH），以及
`CODEGRAPH_BROWSER=<command>` 选择浏览器（`CODEGRAPH_BROWSER=none` 永远不打开）。
`codegraph web` 是同一条命令的别名。

**隐私：** 查看器只监听 `127.0.0.1`，所以你网络上的任何东西都到不了它，
声称来自其他 host 的请求会被拒绝。它打开一份已经存在的索引，从不创建，
也从不改你的图或你的任何一行代码。它会写的唯一一件事，是你要求保存的 trail，
写进 `.codegraph/ui/trails/`；`codegraph ui --read-only` 连这个也拒绝。
**它什么都不往外发**：没有代码、没有路径、没有分析。这个功能里没有账号，也没有云。

查看器读的是已经存在的索引 — 它从不创建 — 所以必须先跑过 `codegraph init`。
`codegraph ui /path/to/project` 可以指向你在别处建过索引的项目。

---

## 框架感知路由

CodeGraph 会检测 Web 框架的路由文件，发出由 `references` 边连到处理类或函数的 `route` 节点。查询某个 view/controller 的调用者时，现在会带出绑定它的 URL 模式。

| Framework | 识别的形态 |
|---|---|
| **Django** | `urls.py` 里的 `path()`、`re_path()`、`url()`、`include()`（CBV `.as_view()`、点分路径） |
| **Flask** | `@app.route('/path', methods=[...])`、blueprint 路由 |
| **FastAPI** | `@app.get(...)`、`@router.post(...)`，全部标准方法 |
| **Express** | `app.get(...)`、`router.post(...)` 及中间件链 |
| **NestJS** | `@Controller` + `@Get/@Post/...`，GraphQL `@Resolver` + `@Query/@Mutation`，`@MessagePattern`/`@EventPattern`，`@SubscribeMessage` |
| **Laravel** | `Route::get()`、`Route::resource()`、`Controller@action`、tuple 语法 |
| **Drupal** | `*.routing.yml` 路由（`_controller`、`_form`、实体处理器）；`.module`/`.theme`/`.install`/`.inc` 里的 `hook_*` 实现 |
| **Rails** | `get '/x', to: 'users#index'`，hash-rocket `=>` 语法 |
| **Spring** | 方法上的 `@GetMapping`、`@PostMapping`、`@RequestMapping` |
| **Play** | `conf/routes` 里的 `GET`/`POST`/… 动词路由 → `Controller.method` action（Scala + Java） |
| **Gin / chi / gorilla / mux** | `r.GET(...)`、`router.HandleFunc(...)` |
| **Axum / actix / Rocket** | `.route("/x", get(handler))` |
| **ASP.NET** | action 方法上的 `[HttpGet("/x")]` 特性 |
| **Vapor** | `app.get("x", use: handler)` |
| **Astro** | `src/pages/` 基于文件的路由（`.astro` 页面 + `.ts` 端点，`[param]`/`[...rest]` 语法） |

### 路由器 — 路由 *以及* 它们之间的导航

这些框架还会额外发出 **`navigates`** 边：把用户送去某处的函数，连到它点名的那一屏，所以 “点这里会去哪” 是图上的一跳，而不是一次搜索。每一条都读字面目的地 — 算出来的，或没有任何路由服务的路径，会保持未解析而不是去猜 — 写在 markup 里的链接会标成推断。

| Router | 路由来自 | 导航来自 |
|---|---|---|
| **Expo Router** | `app/` 下每一个屏幕文件（`app/item/[id].tsx` → `/item/[id]`，group 被剥掉），绑到它的 default-export 组件 | `router.push` / `replace` / `navigate`、模板 href、`{ pathname }` 对象，以及 helper 返回的 href |
| **Next.js** | App Router 的 `app/**/page.tsx` 和 Pages Router 页面（剥掉 `(group)`，`[slug]` → `:slug`）；`app/api/**/route.ts` 的导出和 `pages/api/*` 是端点，不是屏幕 | `router.push` / `replace` / `prefetch`，server action 或页面里的 `redirect()` / `permanentRedirect()`，middleware 里的 `NextResponse.redirect(new URL(…))`，`<Link href>` 和内部 `<a href>` |
| **React Router** | `<Route path component/element>`（v5 和 v6）以及 `createBrowserRouter([{ path, element }])` | `history.push` / `replace`，`useNavigate` 的 `navigate`，loader 的 `redirect`，`<Link to>` / `<NavLink to>` / `<Navigate to>` / react-router-bootstrap 的 `<LinkContainer to>` |
| **TanStack Router** | `createFileRoute('/posts/$postId')`（基于文件）以及沿父链组合的 `createRoute({ path, getParentRoute })`（基于代码）；`_pathless` 段、`(group)` 文件夹、`__root` 和 `<Outlet/>` 布局不是地址 | `navigate({ to })`、抛出的 `redirect({ to })`、`<Link to>` / `<Navigate to>` — 其中 `to` 是路由 PATTERN，值走旁边的 `params` |
| **Vue Router** / **Nuxt** | `createRouter({ routes: [...] })` 以及每条命名的视图，外加 Nuxt `pages/` 基于文件的路由、`server/api/` 端点和路由中间件 | `router.push` / `replace`、`$router.push`、Nuxt 的 `navigateTo`、`<router-link>` / `<RouterLink>` / `<NuxtLink>` — **按路由名**（`push({ name: 'profile' })`）也可以按路径 |
| **SvelteKit** | `src/routes/**/+page.svelte`（`[slug]` → `:slug`，`[[opt]]` → `:opt?`），接到旁边的 `+page.server.js`，好让 loader 的守卫属于它的页面 | `goto('/x')`，load 或 form action 里的 `redirect(status, '/x')`，以及 SvelteKit 应用里作为链接的普通 `<a href>` |

一个仓库里有多个应用时，每个应用的路由只和写在该应用内部的导航匹配。

---

## 混合 iOS / React Native / Expo 桥接

真正的 iOS 和 React Native 代码库活在多种语言之间 — Swift 调用者调用一个已经自动桥接的 Objective-C selector，JS 文件通过 React Native bridge 调进 native 模块，JSX 组件把事情交给 native view manager。静态 tree-sitter 抽取会停在每道语言边界。CodeGraph 把它们接起来，让 `codegraph_explore` 跨过缺口把流从头连到尾 — 调用路径和爆炸半径穿过边界，而不是停在边界上。

| 边界 | JS / Swift 侧 | Native 侧 | 做法 |
|---|---|---|---|
| **Swift → ObjC** | Swift `obj.foo(bar:)` | ObjC selector `-fooWithBar:` | `@objc` 自动桥接规则（含 init/property/protocol 形态）+ Cocoa 介词前缀（`With`/`For`/`By`/`In`/`On`/`At`/…） |
| **ObjC → Swift** | ObjC `[obj fooWithBar:]` | Swift `@objc func foo(bar:)` | 反向桥接名字候选；从源码验证 `@objc` 暴露 |
| **React Native legacy bridge** | JS `NativeModules.X.fn(...)` | ObjC `RCT_EXPORT_METHOD` / `RCT_REMAP_METHOD` · Java/Kotlin `@ReactMethod` | 解析宏/注解声明，建立 JS 名 → native 方法映射 |
| **React Native TurboModules** | JS `import M from './NativeM'; M.fn(...)` | 匹配 Codegen spec 的 native 实现 | 把 `Native<X>.ts` spec 接口当作事实来源 |
| **RN native → JS events** | JS `new NativeEventEmitter(...).addListener('e', cb)` | ObjC `[self sendEventWithName:@"e" body:...]` · Swift `sendEvent(withName: "e", ...)` · Java/Kotlin `.emit("e", ...)` | 按字面事件名合成跨语言事件通道 |
| **Expo Modules** | JS `requireNativeModule('X').fn(...)` | Swift / Kotlin `Module { Name("X"); AsyncFunction("fn") { ... } }` | 解析 Expo DSL 字面量；合成方法节点走现有的名字匹配 |
| **Fabric view components** | JSX `<MyView prop={v}/>` | TS Codegen spec + native 实现类 | Spec → `component` 节点；按约定的名字+后缀查找（`View`/`ComponentView`/`Manager`/`ViewManager`）桥到 native |
| **Legacy Paper view managers** | JSX `<MyView prop={v}/>` | ObjC `RCT_EXPORT_VIEW_PROPERTY` · Java/Kotlin `@ReactProp` | 与 Fabric 相同 — Paper 时代的声明也会产生 `component` + `property` 节点 |

**在真实代码库上验证过**（每种桥接都有小 + 中 + 大）：

| 桥接 | 小 | 中 | 大 |
|---|---|---|---|
| Swift ↔ ObjC | [Charts](https://github.com/danielgindi/Charts) | [realm-swift](https://github.com/realm/realm-swift) | [Wikipedia-iOS](https://github.com/wikimedia/wikipedia-ios) |
| RN legacy bridge | [AsyncStorage](https://github.com/react-native-async-storage/async-storage) | [react-native-svg](https://github.com/software-mansion/react-native-svg) | [react-native-firebase](https://github.com/invertase/react-native-firebase) |
| RN native → JS events | [RNGeolocation](https://github.com/Agontuk/react-native-geolocation-service) | — | react-native-firebase |
| Expo Modules | expo-haptics | expo-camera | expo SDK 扫过（7 个包） |
| Fabric / Paper views | [react-native-segmented-control](https://github.com/react-native-segmented-control/segmented-control) | [react-native-screens](https://github.com/software-mansion/react-native-screens) | [react-native-skia](https://github.com/Shopify/react-native-skia) |

每座桥发出的边都打上 `provenance:'heuristic'`，并把 `metadata.synthesizedBy:` 设成稳定的通道名（例如 `swift-objc-bridge`、`rn-event-channel`、`fabric-native-impl`、`expo-module-extract`），好让 Agent 一眼看出这一跳是怎么进图的。

---

## 快速开始

### 1. 运行安装器

```bash
npx @colbymchenry/codegraph
```

安装器会：
- 询问要配置哪些 Agent — 自动检测已安装的：**Claude Code**、**Cursor**、**Codex CLI**、**opencode**、**Hermes Agent**、**Gemini CLI**、**Antigravity IDE**、**Kiro**、**GitHub Copilot**（VS Code、Copilot CLI、JetBrains IDE）
- 提示把 `codegraph` 装到 PATH 上（这样 Agent 才能拉起 MCP 服务器）
- 询问配置是应用到你所有项目，还是只应用到这一个
- 写入每个所选 Agent 的 MCP 服务器配置，并在 Agent 的说明文件（`CLAUDE.md` / `AGENTS.md` / `GEMINI.md`）里写一小段带标记围栏的 CodeGraph 小节 — 子 Agent 和非 MCP Agent 就是这样学到 `codegraph explore` 命令的，因为 MCP 服务器自己的指引只到达主 Agent。`codegraph uninstall` 会干净地删掉。
- 当 Claude Code 是目标之一时，设置自动允许权限

安装器 **只接线到你的 Agent — 不会给代码建索引。** 它结束后，用 `codegraph init`（第 3 步）自己给每个项目建图。一次全局的 `codegraph install` 覆盖所有项目；`codegraph init` 每个项目跑一次。

**非交互（脚本 / CI）：**

```bash
codegraph install --yes                              # auto-detect agents, install global
codegraph install --yes --init                       # same, then build the current project's index (one-shot bootstrap)
codegraph install --target=cursor,claude --yes       # explicit target list
codegraph install --target=auto --location=local     # detected agents, project-local
codegraph install --target=copilot-vscode,copilot-cli,copilot-jetbrains --yes  # GitHub Copilot everywhere
codegraph install --print-config codex               # print snippet, no file writes
codegraph install --print-config copilot-vscode      # same, for Copilot in VS Code
```

| 标志 | 取值 | 默认 |
|---|---|---|
| `--target` | `auto`、`all`、`none`，或 csv（`claude,cursor,...`） | 询问 |
| `--location` | `global`、`local` | 询问 |
| `--yes` | （布尔） | 每一步都询问 |
| `--init` | （布尔）接线后在当前目录跑 `codegraph init` | — |
| `--no-permissions` | （布尔）跳过 Claude 自动允许列表 | 开着权限 |
| `--print-config <id>` | 打印某个 Agent 的片段然后退出 | — |

### 2. 重启你的 Agent

重启你的 Agent（Claude Code / Cursor / Codex CLI / opencode / Hermes Agent / Gemini CLI / Antigravity IDE / Kiro / VS Code、Copilot CLI，或 JetBrains IDE 里的 GitHub Copilot），MCP 服务器才会加载。

### 3. 初始化项目

```bash
cd your-project
codegraph init
```

构建按项目的知识图索引，之后每次文件变化都会自动同步。一次全局的 `codegraph install` 在你打开的每个项目里都有效 — 不必每个项目再跑一遍安装器。加 `--yes` 跳过所有提示（脚本 / CI / 容器引导）。

就这些 — 只要存在 `.codegraph/` 目录，你的 Agent 就会自动使用 CodeGraph 工具。

<details>
<summary><strong>手动配置（备选）</strong></summary>

**全局安装：**
```bash
npm install -g @colbymchenry/codegraph
```

**加到 `~/.claude.json`：**
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

**加到 `~/.claude/settings.json`（可选，用于自动允许）：**
```json
{
  "permissions": {
    "allow": [
      "mcp__codegraph__*"
    ]
  }
}
```

<sub>一个通配符会自动批准每一个 CodeGraph 工具 — 默认列出的只有 `codegraph_explore`，但如果你通过 `CODEGRAPH_MCP_TOOLS` 重新启用其他工具，它们也已经被允许，不会再提示。</sub>

</details>

<details>
<summary><strong>Agent 工具指引</strong></summary>

CodeGraph 的 MCP 服务器会在 MCP `initialize` 响应里 **自动** 把用法指引交给你的 Agent。简而言之，它告诉 Agent：

- **用 CodeGraph 直接回答结构性问题** — 它 *就是* 预先建好的索引，所以 grep/read 循环只是把已经做过的活再做一遍。把返回的源码当成已经读过。
- **几乎任何事都伸手去拿 `codegraph_explore`** — “X 怎么工作”、一条流/“X 怎么到达 Y”，或扫一眼某个区域。一次调用返回按文件分组的相关符号逐字源码、它们之间的调用路径（含动态分发跳转），以及爆炸半径摘要。在查询里点名一个文件或符号，就能读到它当前带行号的源码。
- **相信结果 — 不要再用 grep 复核**，编辑之后检查过期横幅。
- **按项目工作**：传 `projectPath` 就可以查询任何带 `.codegraph/` 索引的项目 — 所以只有部分服务建过索引的 monorepo，或第二个仓库，都能在同一次会话里用。没有索引的路径会干净地指引你改用内置工具；建不建索引仍由你决定。

精确文本在 `src/mcp/server-instructions.ts` — 主 Agent 的唯一事实来源。因为子 Agent 和非 MCP harness 永远看不到 MCP 指引，安装器还会在 Agent 的说明文件里写一小段带标记围栏的小节，指向等价的 `codegraph explore` CLI。

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
│ explore  ·  one call → verbatim source + call flow + blast radius │
│                                 │                                 │
│                                 ▼                                 │
│                       SQLite knowledge graph                      │
│          symbols · edges · files · FTS5 full-text search          │
└───────────────────────────────────────────────────────────────────┘
```

1. **抽取** — 原生 **Rust 内核** 用编译进去的 [tree-sitter](https://tree-sitter.github.io/) 语法解析源码，为 20 种语言抽出节点（函数、类、方法）和边（调用、导入、继承、实现）；其余语言和按文件回退走可移植引擎上的同一套抽取逻辑，得到相同的图。

2. **存储** — 一切进入本地 SQLite 数据库（`.codegraph/codegraph.db`），带 FTS5 全文搜索。

3. **解析** — 抽取之后解析引用：函数调用 → 定义、导入 → 源文件、类继承，以及框架特有的模式。

4. **自动同步** — MCP 服务器用原生 OS 文件事件监视你的项目。变化会去抖（2 秒安静窗口），只过滤源文件，并增量同步。你写代码时图保持新鲜 — 不需要配置。

---

## CLI 参考

```bash
codegraph                         # Run interactive installer
codegraph install                 # Run installer (explicit)
codegraph uninstall               # Remove CodeGraph from your agents AND the CLI (--keep-cli for configs only)
codegraph init [path]             # Initialize a project + build its graph (one step)
codegraph uninit [path]           # Remove CodeGraph from a project (--force to skip prompt)
codegraph index [path]            # Full index (--force to re-index, --quiet for less output)
codegraph sync [path]             # Incremental update
codegraph status [path]           # Show statistics
codegraph ui [path]               # Open the browser viewer for an indexed project (alias: web; --port, --no-open, --read-only)
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

沿导入依赖传递，找出被改动源文件影响到的测试文件。

```bash
codegraph affected src/utils.ts src/api.ts         # Pass files as arguments
git diff --name-only | codegraph affected --stdin   # Pipe from git diff
codegraph affected src/auth.ts --filter "e2e/*"     # Custom test file pattern
```

| 选项 | 说明 | 默认 |
|--------|-------------|---------|
| `--stdin` | 从 stdin 读文件列表 | `false` |
| `-d, --depth <n>` | 依赖遍历最大深度 | `5` |
| `-f, --filter <glob>` | 识别测试文件的自定义 glob | 自动检测 |
| `-j, --json` | 以 JSON 输出 | `false` |
| `-q, --quiet` | 只输出文件路径 | `false` |

**CI/hook 示例：**

```bash
#!/usr/bin/env bash
AFFECTED=$(git diff --name-only HEAD | codegraph affected --stdin --quiet)
if [ -n "$AFFECTED" ]; then
  npx vitest run $AFFECTED
fi
```

---

## MCP 工具

作为 MCP 服务器运行时，CodeGraph 暴露 **一个工具** — `codegraph_explore`。测到的 Agent 行为显示，一个强工具比一菜单更窄的工具更能带路 — 更少选错，而且每次会话都节省上下文：

| 工具 | 用途 |
|------|---------|
| `codegraph_explore` | 几乎任何问题一次调用就答 — “X 怎么工作”、一条流（“X 怎么到达 Y”），或扫一眼某个区域 — 返回按文件分组的相关符号逐字源码，外加它们之间的调用路径和爆炸半径摘要。带出 grep 跟不到的动态分发跳转（回调、React 重渲染、接口→实现）。在查询里点名一个文件或符号，就能读到它当前带行号的源码，形状和 Read 工具给你的一样。 |

其他工具（`codegraph_node`、`codegraph_search`、`codegraph_callers`、`codegraph_callees`、`codegraph_impact`、`codegraph_files`、`codegraph_status`）功能完整，但 **默认不列出** — 它们返回的一切已经内联出现在 `codegraph_explore` 上（它的爆炸半径一节、关系图、一个符号的正文作为它的被调用者列表）。用 `CODEGRAPH_MCP_TOOLS` 环境变量把其中任意一个重新开到 MCP 表面上（例如 `CODEGRAPH_MCP_TOOLS=explore,node,search,callers`），或使用对应的 CLI（`codegraph node` / `query` / `callers` / `callees` / `impact` / `files` / `status`）。

即便服务器自己的根没有 `.codegraph/` 索引，这些工具仍然可用：传 `projectPath` 查询任何已建索引的项目 — monorepo 里的子服务，或第二个仓库 — 都在同一次会话里。没有索引的路径会干净地指引你改用内置工具，所以不会大声失败，建不建索引仍由你决定。

---

## 作为库使用

CodeGraph 可以直接嵌入。npm 包再导出它的程序化
API，所以 `import` 和 `require` 都会在你自己的
进程里解析到 `CodeGraph` 类 — 适合嵌进应用（例如 Electron 主进程）。

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

同一入口还导出更底层的积木，给直接驱动图的调用方：
`DatabaseConnection`、`QueryBuilder`、
`getDatabasePath`、`initGrammars` / `loadGrammarsForLanguages`，以及 `FileLock`。

**嵌入要求**

- 从 npm 安装（`npm i @colbymchenry/codegraph`），这样匹配的
  按平台包 — 带着编译好的库和它的依赖 —
  会和 shim 一起被取到。
- API 跑在 **你的** 运行时上，所以需要 **Node 22.5+** 才能用内置
  `node:sqlite`（Electron 在其捆绑 Node 为 22.5+ 时也合格）。CLI 和
  MCP 服务器不受影响 — 它们跑在自包含的捆绑运行时上。
- TypeScript 类型随包装运。和任何面向 Node 的库一样，
  请保留 `@types/node`，并设 `skipLibCheck: true`（常见默认）。

---

## 配置

几乎没有 — CodeGraph **默认零配置**，开始用时没有什么要写、
也没有什么要保持同步。语言支持按文件扩展名自动识别；
没有按语言要接线的东西。唯一可选的文件是用来映射
[自定义文件扩展名](#自定义文件扩展名)。

它开箱就会跳过：

- **依赖、构建和缓存目录** — `node_modules`、`vendor`、
  `dist`、`build`、`target`、`.venv`、`Pods`、`.next`，以及每一种
  [受支持技术栈](#supported-languages) 里类似的目录 — 所以图是你的代码，不是
  第三方噪音。即使没有 `.gitignore` 也成立。
- **你 `.gitignore` 里的任何东西** — 在 git 仓库里通过 git 遵守，在
  非 git 项目里直接读 `.gitignore`（根目录和嵌套的）。
- **大于 1 MB 的文件** — 生成的 bundle、压缩过的 JS、vendored 大块。

要再排除别的，加进 `.gitignore`。要把默认排除的
目录再 **加回来**（比如你真的想给一份 vendored 依赖建索引），
加一条取反 — `!vendor/`。默认规则一律生效，所以把依赖或构建目录提交进仓库
并不会强迫它进图；`.gitignore` 取反才是显式选择加入。

不过 `.gitignore` 去不掉你已经 **提交** 的目录。对于仓库里签入的
vendored 主题或 SDK（例如 `static/` 下的 Metronic 主题），
把它列在 `codegraph.json` 的 `exclude` 下 — gitignore 风格的
模式，对照相对仓库根的路径匹配，在 index、sync 和
watch 时都会遵守：

```json
{
  "exclude": ["static/", "**/vendor/**"]
}
```

反过来，当真正的源码被有意 gitignore — 项目活在第二套
VCS（SVN、Perforce）下，`.gitignore` 掉自己的源码好让它不进 Git —
用 `include` 强迫加回来（`exclude` 的反面；`includeIgnored`
只复活嵌套的 git 仓库，不是普通源码）：

```json
{
  "include": ["Tools/", "Local/typescript/"]
}
```

CodeGraph 从磁盘发现这些文件，覆盖 `.gitignore`，在 index、
sync 和 watch 时都如此。显式的 `exclude` 仍然优先，内置跳过
（`node_modules`、`dist`、`.git`）永远不会被重新包含。

有时一个目录不该离开索引 — 你仍想在里面找到东西 —
它只是不该 *压过* 你真正的代码。`scripts/` 或
`optional-skills/` 这类树，helper 用着泛名（`usage`、`status`、
`run`），会在精确名字匹配上赢，把真正回答查询的产品代码挤掉。把这些树写在 `deprioritize` 下：

```json
{
  "deprioritize": ["optional-skills/", "scripts/"]
}
```

这是 `exclude` 在排序上的对应物：那些路径仍被索引、仍找得到 —
直接搜它们仍然有效 — 只是不再压过第一方代码。它作用于 `query` / `search` 以及 `explore` 的
排序。它 *不是* 过滤器：不像内置的 `example/`、`sample/`、
`fixture/`、`benchmark/` 和 `demo/` 处理 — 那些还会把文件从某些结果集里直接拿掉 —
`deprioritize` 永远只改排序。想让某样东西消失时，用 `exclude`。

### 自定义文件扩展名

如果你的项目给一种 [受支持
语言](#supported-languages) 用了非标准扩展名 — 比如 Lua 的 `.dota_lua`，或 PHP 的 `.tpl` —
这些文件默认会被跳过，因为这个扩展名不是 CodeGraph
认识的。用项目根目录一份可选的 **`codegraph.json`** 映射它们：

```json
{
  "extensions": {
    ".dota_lua": "lua",
    ".tpl": "php"
  }
}
```

每个值都是受支持的语言 id。映射叠在内置默认之上，冲突时以你的为准，所以你也可以改指一个内置（例如
`".h": "cpp"`）。把文件提交进去，好和团队共享这份映射。拼错的
语言或格式坏掉的文件会被警告并跳过 — 从不打断
索引 — 没有 `codegraph.json` 的项目行为和以前完全一样。
增改映射之后请重新索引（`codegraph index`）。

## 遥测

CodeGraph 收集 **匿名使用统计** — 哪些工具和命令被
用到、哪些语言被索引 — 用来指导语言和 Agent 支持
工作往哪走。**从不** 收集任何代码、路径、文件或符号名、查询或 IP
地址；使用量在本地聚成每日总计才发送，接收端点是
[本仓库里的公开代码](telemetry-worker/)，
只接受文档列出的字段。安装器会先问你；随时可以关掉：

```bash
codegraph telemetry off    # or: CODEGRAPH_TELEMETRY=0, or DO_NOT_TRACK=1
```

[`TELEMETRY.md`](TELEMETRY.md) 列出每一个字段，以及关闭开关和完整的
数据处理说明。

<a id="verified-releases"></a>

## 已验证的发布

每一份产物都由公开的
[Release workflow](.github/workflows/release.yml) 构建并发布 — 从不来自某台笔记本 — 并
带着密码学证明：

- **npm 包** 通过 [trusted publishing](https://docs.npmjs.com/trusted-publishers)
  发布
  （OIDC — 不存在可能被偷的长期 npm token），并带
  [provenance 证明](https://docs.npmjs.com/generating-provenance-statements)，
  把每一个版本连到构建它的精确 commit 和 workflow 运行。
  验证已安装的内容：

  ```bash
  npm audit signatures
  ```

- **GitHub Release bundle**（以及 `SHA256SUMS`）带着签名的
  [构建证明](https://docs.github.com/en/actions/security-for-github-actions/using-artifact-attestations)
  （SLSA v1.0 Build Level 2）。验证任何下载下来的 bundle：

  ```bash
  gh attestation verify codegraph-darwin-arm64.tar.gz -R colbymchenry/codegraph
  ```

2026 年 7 月之前发布的版本早于这条流水线，不带
证明。

<a id="supported-platforms"></a>

## 支持的平台

每一次发布都附带一份自包含构建（捆绑 Node 运行时 — 不用
编译），覆盖三种桌面操作系统，Intel/AMD（x64）和 ARM（arm64）都有：

| 平台 | 架构 | 安装 |
|----------|---------------|---------|
| Windows | x64, arm64 | PowerShell 安装器或 npm |
| macOS | x64, arm64 | shell 安装器或 npm |
| Linux | x64, arm64 | shell 安装器或 npm |

一条命令的安装方式见 [开始使用](#开始使用)。

<a id="supported-agents"></a>

## 支持的 Agent

交互式安装器会自动检测并配置下面每一个 — 接上
MCP 服务器（它会交付自己的用法指引，所以不会写说明文件）：

- **Claude Code**
- **Cursor**
- **Codex CLI**
- **opencode**
- **Hermes Agent**
- **Gemini CLI**
- **Antigravity IDE**
- **Kiro**
- **GitHub Copilot** — VS Code 里的 Copilot Chat（`copilot-vscode`）、Copilot CLI（`copilot-cli`），以及 JetBrains IDE 里的 Copilot 插件（`copilot-jetbrains`）

<a id="supported-languages"></a>

## 支持的语言

| 语言 | 扩展名 | 状态 |
|----------|-----------|--------|
| TypeScript | `.ts`, `.tsx` | 完整支持 |
| JavaScript | `.js`, `.jsx`, `.mjs` | 完整支持 |
| ArkTS (HarmonyOS) | `.ets` | 完整支持（TypeScript 有的都有，外加带 ArkUI 装饰器的 `@Component`/`@ComponentV2` struct（`@State`/`@Prop`/`@Link`/`@Local`/`@Builder`/…）、`build()` 视图树 — 父→子组件边、链式属性连到 `@Extend`/`@Styles` 函数、`.onClick(this.handler)` 事件绑定 — state→`build()` 重渲染的动态分发桥、`@ohos.events.emitter` 的 emit→订阅者对（仅静态事件 key），以及 `router.pushUrl` 字面 url → 目标页面 struct；ohpm workspace 模块通过 `oh-package.json5` 的 `file:` 依赖解析裸 `import { X } from "data"`，并遵守每个模块的 `main` 入口） |
| Python | `.py` | 完整支持 |
| Go | `.go` | 完整支持 |
| Rust | `.rs` | 完整支持 |
| Java | `.java` | 完整支持 |
| C# | `.cs` | 完整支持 |
| PHP | `.php` | 完整支持 |
| Ruby | `.rb` | 完整支持 |
| C | `.c`, `.h` | 完整支持 |
| C++ | `.cpp`, `.hpp`, `.cc` | 完整支持 |
| Objective-C | `.m`, `.mm`, `.h` | 部分支持（类、协议、方法、`@property`、`#import`、消息发送；`.mm` ObjC++ 可能解析不完整） |
| Metal | `.metal` | 完整支持（vertex/fragment/kernel 函数、struct、类型别名、调用边 — MSL 按 C++ 解析，并处理 `[[attribute]]` 注解） |
| CUDA | `.cu`, `.cuh` | 完整支持（kernel 和 device/host 函数、struct、类、通过 `<<<grid, block>>>` 启动语法的 host→kernel 调用边 — 含模板启动、函数指针启动（`auto kernel = &fn<...>`）、`dim3{...}` 配置，以及宏定义的 kernel；处理 `__global__`/`__device__`/`__launch_bounds__` 说明符；纯 `.h`/`.hpp` 头里的 CUDA 按内容识别） |
| Swift | `.swift` | 完整支持 |
| Kotlin | `.kt`, `.kts` | 完整支持 |
| Scala | `.scala`, `.sc` | 完整支持（类、trait、方法、类型别名、Scala 3 enum） |
| Dart | `.dart` | 完整支持 |
| Svelte | `.svelte` | 完整支持（script 抽取、Svelte 5 runes、SvelteKit 路由） |
| Vue | `.vue` | 完整支持（script + script-setup 抽取、Nuxt page/API/middleware 路由） |
| Astro | `.astro` | 完整支持（frontmatter + script 抽取、模板组件/调用引用、`src/pages/` 路由） |
| Liquid | `.liquid` | 完整支持 |
| Pascal / Delphi | `.pas`, `.dpr`, `.dpk`, `.lpr` | 完整支持（类、record、接口、enum、DFM/FMX 窗体文件） |
| Lua | `.lua` | 完整支持（函数、带 receiver 的方法、局部变量、`require` 导入、调用边） |
| R | `.R` `.r` | 完整支持（每一种赋值形态的函数、带方法的 S4/R5/R6 类、`library`/`require` 导入、`source()` 文件引用、调用边） |
| Luau | `.luau` | 完整支持（Lua 里有的都有，外加 `type`/`export type` 别名、带类型的签名，以及 Roblox 实例路径 `require`） |
| CFML | `.cfc`, `.cfm`, `.cfs` | 完整支持（基于标签的 `<cfcomponent>`/`<cffunction>` 和裸脚本 `component { ... }` 风格、`extends`/`implements`、嵌入的 `<cfscript>` 委托、调用边） |
| COBOL | `.cbl`, `.cob`, `.cpy` | 完整支持（program、带 PERFORM/GO TO 调用边的 section/paragraph、CALL 'literal' 跨程序调用、COPY copybook 导入 — 含独立 `.cpy` 文件 — DATA DIVISION 的 record/field/88-level、EXEC CICS LINK/XCTL 和 EXEC SQL INCLUDE 目标；fixed 和 free 格式） |
| Visual Basic .NET | `.vb` | 完整支持（类、Module、接口、structure、enum、属性、事件、`Declare` P/Invoke、`Handles`/`WithEvents`、`Inherits`/`Implements` 边、穿过 VB 调用/下标括号歧义的调用边、`As New` 实例化、插值字符串、LINQ、Unicode 标识符） |
| Erlang | `.erl`, `.hrl`, `.escript`, `.app.src`, `.app` | 完整支持（多子句/多 arity 分组的函数、`-spec` 签名、带字段的 record、`-type`/`-opaque` 别名、`-define` 宏、`-include`/`-include_lib`/`-import` 边、本地和 `mod:fn` 远程调用边、`fun name/arity` 引用、`spawn`/`apply`/`proc_lib`/`timer`/`rpc` 的 MFA 参数调用边、`gen_server:call/cast(?MODULE)` → 自己的 `handle_call`/`handle_cast` 链接、`-behaviour` 链接、基于 `-export` 的可见性） |
| Solidity | `.sol` | 完整支持（contract、library、interface、struct、enum、modifier、event、error、状态变量、`import`/`using` 指令、`emit`/`revert` 调用） |
| Terraform / OpenTofu | `.tf`, `.tfvars`, `.tofu` | 完整支持（resource、data source、module、variable、output、含 alias 的 provider、`locals`；`var.`/`local.`/`module.`/resource 引用并强制 Terraform 的按目录作用域；跨边界桥接的 module 调用 — 输入到子模块的 variable、`module.M.out` 到子模块的 output、`source` 到模块的文件；component 静态命名时的 cloudposse/atmos `remote-state` 跨组件接线；沿模块树向上解析的 `provider = aws.east` 选择；`moved`/`import`/`removed`/`check` 块引用；`.tfvars` 赋值连到它们设置的 variable） |
| Nix | `.nix` | 完整支持（带简单/解构/柯里参数的函数、`let`/attrset 绑定、`inherit`、`import ./path` 文件边 — `./dir` 经 `default.nix` 解析 — 外加 NixOS 模块 `imports = [ ./x.nix ]` 列表和 `callPackage ./pkg.nix` 文件边；调用边；模块系统 option 接线 — 像 `launchd.user.agents.x = { ... }` 这样的配置写入会连到声明 `options.launchd.user.agents` 的模块，于是 option 流可以跨模块追踪） |

## 实测跨文件覆盖率

影响分析和爆炸半径查询只和背后的依赖图一样好，所以覆盖率是测出来的，不是宣称的。**公平覆盖率** = 至少有一个 *已解析的跨文件依赖者* 的、带符号的源文件占比 — 有东西导入、调用、引用它们，或（通过框架约定）路由到它们 — 每种语言一个真实基准仓库。剩余永远是真正的静态分析边界（运行时动态分发、反射 / DI 容器、框架约定入口、vendored 第三方代码），从不靠玩弄分母来藏。

| 语言 | 基准仓库 | 覆盖率 |
|---|---|---|
| TypeScript / JavaScript | this repo | 95.8% |
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

框架路由用同样方式验证，每种框架一个典型应用：Express 100%，FastAPI 98%，Flask 100%，NestJS 96.8%，Gin 96.5%，Axum 100%，Rocket 93.8%，Vapor 100%，Laravel 92%，Rails 89.6%，React Router 100% — 以及约定/反射很重、停在诚实静态分析天花板上的那些：ASP.NET 83.9%，Spring 83.3%，Drupal 78.9%，Play 76.3%，Django 74.1%。SvelteKit、Vue/Nuxt 和 Astro 使用基于文件的路由，所以它们的页面/端点覆盖率就是上表里的 Svelte/SvelteKit（100%）、Vue/Nuxt（93.5%）和 Astro（93.0% — 两个验证仓库上每一个 `src/pages/` 文件都映射到一个 route 节点）。

## 故障排查

**“CodeGraph not initialized”** — 先在项目目录里跑 `codegraph init`。

**索引很慢** — 检查 `node_modules` 和其他大目录是否被排除。用 `--quiet` 减少输出开销。

**MCP 碰到 `database is locked`** — 当前构建不该出现：CodeGraph 捆绑自己的 Node 运行时，并在 WAL 模式下使用 Node 内置的 `node:sqlite`，并发读从不会堵在写上。如果你仍然看到：

- **你用的是旧安装（0.9 之前）。** 重装以拿到捆绑运行时 — `curl -fsSL https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.sh | sh`（macOS/Linux），`irm https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.ps1 | iex`（Windows），或 `npm i -g @colbymchenry/codegraph@latest`。
- **`codegraph status` 显示的 `Journal:` 不是 `wal`** — 这块文件系统上启用不了 WAL（网络盘和 WSL2 `/mnt` 上常见），所以读可能堵在写上。把项目（连同它的 `.codegraph/` 文件夹）挪到本地磁盘。

**MCP 服务器连不上** — Agent 自己启动服务器，所以你不用亲手拉起。确认项目已经初始化并建过索引（`codegraph status`），并且 MCP 配置里的路径是对的。如果还是连不上，再跑一次 `codegraph install` 重写配置。

**MCP 工具调用失败并报 `Transport closed`，而 `codegraph status`/`sync` 是健康的** — 几乎总是 WSL2 且项目在 Windows 盘上（`/mnt/c` 或 `/mnt/d` 路径），CodeGraph 用来跨会话共享一个后台服务器的本地 socket 在那里不可靠。CodeGraph 现在会回退成在进程内服务这次会话，而不是丢掉连接；如果仍然碰到，在 MCP 服务器的环境里设 `CODEGRAPH_NO_DAEMON=1` 以完全跳过共享服务器（每个会话跑在自己的进程里）。把项目挪到 Linux 原生文件系统（例如 `~/` 而不是 `/mnt/`）会恢复共享服务器。

**缺少符号** — MCP 服务器会在保存时自动同步（等一两秒）。需要的话手动跑 `codegraph sync`。检查该文件的语言是否受支持，以及它是不是在 `.gitignore` 或默认排除的目录里（例如 `node_modules`、`dist`）。

**在 Windows 和 WSL 之间共享一份 checkout** — 不要让两边指向同一个 `.codegraph/`：后台服务器锁和 SQLite 索引绑在写下它们的那个 OS 上，跨 WSL2/Windows 文件系统边界的 SQLite 锁不可靠。给每一边在同一棵树里各自一份索引，方法是把其中一边的 `CODEGRAPH_DIR` 设成不同的名字 — 例如 Windows 上 `CODEGRAPH_DIR=.codegraph-win`，WSL 留在默认 `.codegraph`。CodeGraph 在索引和监视时会跳过任何兄弟 `.codegraph-*` 目录，所以两边不会互相绊倒。

**非常大的仓库（数十万文件），或很大的 `.codegraph/codegraph.db-wal` 文件** — `-wal` 文件是 SQLite 的 write-ahead log：等着折进 `codegraph.db` 的写入。在构建大索引时，CodeGraph 允许它按索引体量成比例增长（软阈值 = 256 MB 和索引大小四分之一里较大的那个，上限 2 GB）再折回去，因为折得太勤才是大索引在普通磁盘上变慢的原因。静止时它会被裁到 64 MB，被杀掉的会话留下的残余会在项目下次打开时折并裁掉 — 索引本身没有大小上限。两个环境变量调节这个：`CODEGRAPH_WAL_VALVE_MB`（索引期间的软阈值）和 `CODEGRAPH_WAL_HEAL_MB`（静止大小和裁剪阈值）。`CODEGRAPH_WAL_VALVE_DEBUG=1` 把每一个决定打到 stderr。

## 许可证

MIT

---

<div align="center">

**为 AI 编程 Agent 而做 — Claude Code、Cursor、Codex CLI、opencode、Hermes Agent、Gemini CLI、Antigravity IDE、Kiro 和 GitHub Copilot**

[报告缺陷](https://github.com/colbymchenry/codegraph/issues) · [请求功能](https://github.com/colbymchenry/codegraph/issues)

</div>

