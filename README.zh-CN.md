<div align="center">

# CodeGraph

### 用语义化代码图谱增强 Claude Code

**工具调用减少 94% · 探索提速 77% · 100% 本地运行**

[![npm version](https://img.shields.io/npm/v/@colbymchenry/codegraph.svg)](https://www.npmjs.com/package/@colbymchenry/codegraph)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org/)

[![Windows](https://img.shields.io/badge/Windows-supported-blue.svg)](#)
[![macOS](https://img.shields.io/badge/macOS-supported-blue.svg)](#)
[![Linux](https://img.shields.io/badge/Linux-supported-blue.svg)](#)

[English](./README.md) · **简体中文**

<br />

### 快速上手

```bash
npx @colbymchenry/codegraph
```

<sub>交互式安装器会自动配置 Claude Code</sub>

#### 在项目中初始化

```bash
cd your-project
codegraph init -i
```

![1_C_VYnhpys0UHrOuOgpgoyw](https://github.com/user-attachments/assets/f168182f-4d9a-44e0-94d7-08d018cc8a3a)

</div>

---

## 为什么需要 CodeGraph？

Claude Code 在探索一个代码库时,会派出 **Explore agent** 去用 grep、glob 和 Read 扫描文件 —— 每一次工具调用都在消耗 token。

**CodeGraph 为这些 agent 提供一份预先建好的知识图谱** —— 符号关系、调用链、代码结构一应俱全。Agent 直接查询图谱,不再需要逐文件翻找。

### 基准测试结果

我们在 6 个真实代码库上对比了 Claude Code 的 Explore agent **启用** 与 **未启用** CodeGraph 的差异:

> **平均: 工具调用减少 92% · 速度提升 71%**

| 代码库 | 启用 CG | 未启用 CG | 提升幅度 |
|----------|---------|------------|-------------|
| **VS Code** · TypeScript | 3 次调用, 17 秒 | 52 次调用, 1 分 37 秒 | **减少 94% · 加快 82%** |
| **Excalidraw** · TypeScript | 3 次调用, 29 秒 | 47 次调用, 1 分 45 秒 | **减少 94% · 加快 72%** |
| **Claude Code** · Python + Rust | 3 次调用, 39 秒 | 40 次调用, 1 分 8 秒 | **减少 93% · 加快 43%** |
| **Claude Code** · Java | 1 次调用, 19 秒 | 26 次调用, 1 分 22 秒 | **减少 96% · 加快 77%** |
| **Alamofire** · Swift | 3 次调用, 22 秒 | 32 次调用, 1 分 39 秒 | **减少 91% · 加快 78%** |
| **Swift Compiler** · Swift/C++ | 6 次调用, 35 秒 | 37 次调用, 2 分 8 秒 | **减少 84% · 加快 73%** |

<details>
<summary><strong>完整基准测试详情</strong></summary>

所有测试都使用 Claude Opus 4.6(1M 上下文)和 Claude Code v2.1.91。每次测试派出单个 Explore agent,问同一个问题。

**使用的查询:**
| 代码库 | 查询内容 |
|----------|-------|
| VS Code | "扩展宿主进程是如何与主进程通信的?" |
| Excalidraw | "协作编辑和实时同步是怎么工作的?" |
| Claude Code (Python+Rust) | "工具执行从头到尾是怎么走的?" |
| Claude Code (Java) | "工具执行从头到尾是怎么走的?" |
| Alamofire | "追踪一次请求从 Session.request() 一直到 URLSession 层的完整流程" |
| Swift Compiler | "Swift 编译器是怎么处理错误诊断的?" |

**启用 CodeGraph —— agent 用 `codegraph_explore` 一把搞定:**
| 代码库 | 索引文件数 | 节点数 | 工具调用 | Token 数 | 用时 | 文件读取 |
|----------|--------------|-------|-----------|--------|------|------------|
| VS Code (TypeScript) | 4,002 | 59,377 | 3 | 56.6k | 17 秒 | 0 |
| Excalidraw (TypeScript) | 626 | 9,859 | 3 | 57.1k | 29 秒 | 0 |
| Claude Code (Python+Rust) | 115 | 3,080 | 3 | 67.1k | 39 秒 | 0 |
| Claude Code (Java) | — | — | 1 | 40.8k | 19 秒 | 0 |
| Alamofire (Swift) | 102 | 2,624 | 3 | 57.3k | 22 秒 | 0 |
| Swift Compiler (Swift/C++) | 25,874 | 272,898 | 6 | 77.4k | 35 秒 | 0 |

**未启用 CodeGraph —— agent 大量调用 grep、find、ls 和 Read:**
| 代码库 | 工具调用 | Token 数 | 用时 | 文件读取 |
|----------|-----------|--------|------|------------|
| VS Code (TypeScript) | 52 | 89.4k | 1 分 37 秒 | ~15 |
| Excalidraw (TypeScript) | 47 | 77.9k | 1 分 45 秒 | ~20 |
| Claude Code (Python+Rust) | 40 | 69.3k | 1 分 8 秒 | ~15 |
| Claude Code (Java) | 26 | 73.3k | 1 分 22 秒 | ~15 |
| Alamofire (Swift) | 32 | 52.4k | 1 分 39 秒 | ~10 |
| Swift Compiler (Swift/C++) | 37 | 99.1k | 2 分 8 秒 | ~20 |

**关键观察:**
- 启用 CodeGraph 时,agent **完全没有回退到读文件** —— 它完全信任 codegraph_explore 的结果
- 未启用 CodeGraph 时,agent 把大量时间花在前期发现(find、ls、grep)上,真正开始读相关代码前已经消耗了不少 token
- Java 代码库**只用了 1 次 codegraph_explore 调用**就回答完整个问题
- 跨语言查询(Python+Rust)无缝衔接 —— CodeGraph 的图谱遍历能跨语言找到引用关系
- Swift 基准测试(Alamofire)追踪到了从 `Session.request()` 到 `URLSession.dataTask()` 的**9 步调用链** —— CodeGraph 在深度 3 的图谱遍历下一次调用就拿到了完整链路
- **Swift Compiler** 基准测试是规模最大的代码库(**25,874 个文件,272,898 个节点**) —— CodeGraph 在 4 分钟内完成索引,agent 用 **6 次 explore 调用、零次文件读取**在 35 秒内回答了一个跨多个模块的复杂问题

</details>

---

## 核心特性

| | |
|---|---|
| **智能上下文构建** | 一次工具调用即返回入口点、相关符号和代码片段 —— 不再需要昂贵的探索 agent |
| **全文搜索** | 基于 FTS5,瞬间在整个代码库中按名字找到代码 |
| **影响分析** | 修改任何符号前,先看清它的调用方、被调用方以及完整的影响范围 |
| **永远最新** | 文件监听基于原生 OS 事件(FSEvents / inotify / ReadDirectoryChangesW),带防抖自动同步 —— 你边写代码图谱边更新,无需任何配置 |
| **19+ 种语言** | TypeScript、JavaScript、Python、Go、Rust、Java、C#、PHP、Ruby、C、C++、Swift、Kotlin、Dart、Svelte、Liquid、Pascal/Delphi |
| **识别 Web 框架路由** | 自动识别主流框架的路由文件,把 URL 模式和它们的处理函数关联起来(目前支持 13 种框架) |
| **100% 本地运行** | 数据不离开你的机器。无需 API key、不依赖外部服务,仅使用 SQLite 数据库 |

---

## 识别 Web 框架路由

CodeGraph 会识别 Web 框架的路由文件,生成 `route` 节点,并通过 `references` 边连接到对应的处理类或函数。这样查询某个 view / controller 的调用方时,绑定它的 URL 模式也会一并浮现。

| 框架 | 识别的写法 |
|---|---|
| **Django** | `urls.py` 中的 `path()`、`re_path()`、`url()`、`include()`(支持 CBV `.as_view()` 和点号路径) |
| **Flask** | `@app.route('/path', methods=[...])`、蓝图路由 |
| **FastAPI** | `@app.get(...)`、`@router.post(...)`,涵盖所有标准方法 |
| **Express** | `app.get(...)`、`router.post(...)`,包括中间件链 |
| **Laravel** | `Route::get()`、`Route::resource()`、`Controller@action`、元组语法 |
| **Rails** | `get '/x', to: 'users#index'`、`=>` 哈希箭头语法 |
| **Spring** | 方法上的 `@GetMapping`、`@PostMapping`、`@RequestMapping` |
| **Gin / chi / gorilla / mux** | `r.GET(...)`、`router.HandleFunc(...)` |
| **Axum / actix / Rocket** | `.route("/x", get(handler))` |
| **ASP.NET** | action 方法上的 `[HttpGet("/x")]` 特性 |
| **Vapor** | `app.get("x", use: handler)` |
| **React Router** / **SvelteKit** | 路由组件节点 |

---

## 快速开始

### 1. 运行安装器

```bash
npx @colbymchenry/codegraph
```

安装器会:
- 询问是否将 `codegraph` 全局安装(MCP server 需要全局命令)
- 在 `~/.claude.json` 中配置 MCP server
- 为 CodeGraph 工具设置自动允许权限
- 向 `~/.claude/CLAUDE.md` 添加全局指引
- 可选: 在当前项目中初始化

### 2. 重启 Claude Code

重启 Claude Code 让 MCP server 加载。

### 3. 初始化你的项目

```bash
cd your-project
codegraph init -i
```

完成。只要项目里有 `.codegraph/` 目录,Claude Code 就会自动使用 CodeGraph 工具。

<details>
<summary><strong>手动安装(可选)</strong></summary>

**全局安装:**
```bash
npm install -g @colbymchenry/codegraph
```

**在 `~/.claude.json` 中添加:**
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

**在 `~/.claude/settings.json` 中添加(可选,用于自动允许):**
```json
{
  "permissions": {
    "allow": [
      "mcp__codegraph__codegraph_search",
      "mcp__codegraph__codegraph_context",
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
<summary><strong>全局指引参考</strong></summary>

安装器会自动把下面的内容追加到 `~/.claude/CLAUDE.md`:

```markdown
## CodeGraph

CodeGraph 为代码库构建语义化知识图谱,让代码探索更快、更聪明。

### 如果项目中存在 `.codegraph/`

**永远不要在主会话里直接调用 `codegraph_explore` 或 `codegraph_context`。** 这两个工具返回的源码量很大,会迅速吃掉主会话的上下文。任何探索类问题(例如 "X 是怎么实现的?"、"讲讲 Y 系统"、"Z 在哪里?")都应该派出 Explore agent 来处理。

**派出 Explore agent 时**,在 prompt 中加入以下提示:

> 本项目已初始化 CodeGraph(`.codegraph/` 存在)。请把 `codegraph_explore` 作为首选工具 —— 它一次调用就能从所有相关文件中返回完整的源码片段。
>
> **规则:**
> 1. 严格遵循 `codegraph_explore` 工具描述里的调用预算 —— 它会根据项目规模自动调整。
> 2. 不要重复读取 codegraph_explore 已经返回过源码的文件,这些片段已经完整、可信。
> 3. 仅当需要更多细节、或 codegraph 未返回任何结果时,才回退到 grep / glob / read 来查看 "Additional relevant files" 下的文件。

**主会话只能直接使用这些轻量工具**(用于编辑前的精确查找,不用于探索):

| 工具 | 适用场景 |
|------|---------|
| `codegraph_search` | 按名字查找符号 |
| `codegraph_callers` / `codegraph_callees` | 追踪调用关系 |
| `codegraph_impact` | 编辑前检查影响范围 |
| `codegraph_node` | 获取单个符号的详细信息 |

### 如果 `.codegraph/` 不存在

会话开始时,询问用户是否要初始化 CodeGraph:

"看起来这个项目还没有初始化 CodeGraph。要不要我跑一下 `codegraph init -i`,帮你建一份代码知识图谱?"
```

</details>

---

## 工作原理

```
┌─────────────────────────────────────────────────────────────────┐
│                        Claude Code                               │
│                                                                  │
│  "实现用户认证"                                                   │
│           │                                                      │
│           ▼                                                      │
│  ┌─────────────────┐      ┌─────────────────┐                   │
│  │  Explore Agent  │ ──── │  Explore Agent  │                   │
│  └────────┬────────┘      └────────┬────────┘                   │
│           │                        │                             │
└───────────┼────────────────────────┼─────────────────────────────┘
            │                        │
            ▼                        ▼
┌───────────────────────────────────────────────────────────────────┐
│                     CodeGraph MCP Server                          │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐               │
│  │   Search    │  │   Callers   │  │   Context   │               │
│  │  "auth"     │  │  "login()"  │  │  for task   │               │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘               │
│         │                │                │                       │
│         └────────────────┼────────────────┘                       │
│                          ▼                                        │
│              ┌───────────────────────┐                            │
│              │   SQLite 图谱数据库    │                            │
│              │   • 387 个符号        │                            │
│              │   • 1,204 条边        │                            │
│              │   • 即时查询          │                            │
│              └───────────────────────┘                            │
└───────────────────────────────────────────────────────────────────┘
```

1. **抽取** —— [tree-sitter](https://tree-sitter.github.io/) 把源码解析成 AST。语言特定的查询从中抽出节点(函数、类、方法)和边(调用、导入、继承、实现)。

2. **存储** —— 所有数据进入本地 SQLite 数据库(`.codegraph/codegraph.db`),并由 FTS5 提供全文检索。

3. **解析** —— 抽取完成后再统一解析引用: 函数调用 → 定义、导入 → 源文件、类继承,以及框架特定的模式。

4. **自动同步** —— MCP server 用原生 OS 文件事件监听项目。变更会经过 2 秒静默窗口防抖、按源码文件过滤后做增量同步。图谱随代码自动保持新鲜 —— 无需任何配置。

---

## CLI 参考

```bash
codegraph                         # 运行交互式安装器
codegraph install                 # 运行安装器(显式)
codegraph init [path]             # 在项目中初始化(加 --index 顺便建索引)
codegraph uninit [path]           # 从项目中移除 CodeGraph(--force 跳过确认)
codegraph index [path]            # 全量索引(--force 强制重建,--quiet 减少输出)
codegraph sync [path]             # 增量更新
codegraph status [path]           # 显示统计信息
codegraph query <search>          # 搜索符号(--kind、--limit、--json)
codegraph files [path]            # 显示文件结构(--format、--filter、--max-depth、--json)
codegraph context <task>          # 为 AI 任务构建上下文(--format、--max-nodes)
codegraph affected [files...]     # 找出被改动影响的测试文件(见下文)
codegraph serve --mcp             # 启动 MCP server
```

### `codegraph affected`

通过传递依赖追踪 import 关系,找出哪些测试文件受到改动的影响。

```bash
codegraph affected src/utils.ts src/api.ts         # 直接传文件路径
git diff --name-only | codegraph affected --stdin   # 从 git diff 接收输入
codegraph affected src/auth.ts --filter "e2e/*"     # 自定义测试文件匹配模式
```

| 参数 | 说明 | 默认值 |
|--------|-------------|---------|
| `--stdin` | 从 stdin 读取文件列表 | `false` |
| `-d, --depth <n>` | 依赖遍历的最大深度 | `5` |
| `-f, --filter <glob>` | 自定义测试文件匹配 glob | 自动识别 |
| `-j, --json` | 以 JSON 形式输出 | `false` |
| `-q, --quiet` | 只输出文件路径 | `false` |

**CI / git hook 示例:**

```bash
#!/usr/bin/env bash
AFFECTED=$(git diff --name-only HEAD | codegraph affected --stdin --quiet)
if [ -n "$AFFECTED" ]; then
  npx vitest run $AFFECTED
fi
```

---

## MCP 工具

当 CodeGraph 以 MCP server 方式运行时,会向 Claude Code 暴露下列工具:

| 工具 | 用途 |
|------|---------|
| `codegraph_search` | 按名字在代码库中查找符号 |
| `codegraph_context` | 为某项任务构建相关代码上下文 |
| `codegraph_callers` | 查找谁在调用某个函数 |
| `codegraph_callees` | 查找某个函数调用了谁 |
| `codegraph_impact` | 分析修改某个符号会影响哪些代码 |
| `codegraph_node` | 获取某个符号的详情(可选附带源码) |
| `codegraph_files` | 获取已索引的文件结构(比扫描文件系统更快) |
| `codegraph_status` | 查看索引健康状态和统计 |

---

## 作为库使用

```typescript
import CodeGraph from '@colbymchenry/codegraph';

const cg = await CodeGraph.init('/path/to/project');
// 或者: const cg = await CodeGraph.open('/path/to/project');

await cg.indexAll({
  onProgress: (p) => console.log(`${p.phase}: ${p.current}/${p.total}`)
});

const results = cg.searchNodes('UserService');
const callers = cg.getCallers(results[0].node.id);
const context = await cg.buildContext('fix login bug', { maxNodes: 20, includeCode: true, format: 'markdown' });
const impact = cg.getImpactRadius(results[0].node.id, 2);

cg.watch();   // 文件变更时自动同步
cg.unwatch(); // 停止监听
cg.close();
```

---

## 配置

`.codegraph/config.json` 控制索引行为:

```json
{
  "version": 1,
  "languages": ["typescript", "javascript"],
  "exclude": ["node_modules/**", "dist/**", "build/**", "*.min.js"],
  "frameworks": [],
  "maxFileSize": 1048576,
  "extractDocstrings": true,
  "trackCallSites": true
}
```

| 选项 | 说明 | 默认值 |
|--------|-------------|---------|
| `languages` | 要索引的语言(为空则自动检测) | `[]` |
| `exclude` | 要忽略的 glob 模式 | `["node_modules/**", ...]` |
| `frameworks` | 框架提示,提高解析准确度 | `[]` |
| `maxFileSize` | 跳过比该值大的文件(字节) | `1048576`(1MB) |
| `extractDocstrings` | 是否抽取文档注释 | `true` |
| `trackCallSites` | 是否记录调用位置 | `true` |

## 支持的语言

| 语言 | 后缀 | 状态 |
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
| Swift | `.swift` | 完全支持 |
| Kotlin | `.kt`、`.kts` | 完全支持 |
| Scala | `.scala`、`.sc` | 完全支持(类、trait、方法、类型别名、Scala 3 enum) |
| Dart | `.dart` | 完全支持 |
| Svelte | `.svelte` | 完全支持(script 抽取、Svelte 5 runes、SvelteKit 路由) |
| Vue | `.vue` | 完全支持(script 与 script-setup 抽取、Nuxt page / API / middleware 路由) |
| Liquid | `.liquid` | 完全支持 |
| Pascal / Delphi | `.pas`、`.dpr`、`.dpk`、`.lpr` | 完全支持(类、record、interface、enum、DFM/FMX 表单文件) |

## 常见问题

**"CodeGraph not initialized"** —— 先在项目目录里运行 `codegraph init`。

**索引慢** —— 检查 `node_modules` 等大目录是否已被排除。用 `--quiet` 减少输出开销。

**索引慢 / MCP 报 `database is locked` / 走到了 WASM 回退** —— `codegraph` 自带 WASM 版 SQLite 作为回退,适用于无法安装 `better-sqlite3`(原生模块,声明为 `optionalDependencies`)的环境。回退版本比原生版本慢 5~10 倍,且其日志模式下写入会阻塞读取,因此索引期间 MCP 查询也可能撞上 `database is locked`。运行 `codegraph status`,看 `Backend:` 那一行:

- `Backend: native` —— 你走在快速路径上,无需处理。
- `Backend: wasm` —— 你走的是慢速回退。常见原因: 缺少 C 编译工具链、当前 Node 版本没有预编译二进制、或安装后 Node 版本变了。修复方法:

  ```bash
  # macOS
  xcode-select --install                                  # 安装 C 编译器

  # Linux (Debian / Ubuntu)
  sudo apt install build-essential python3 make

  # Linux (RHEL / Fedora)
  sudo yum groupinstall "Development Tools"

  # 任何平台都可以重新构建:
  npm rebuild better-sqlite3

  # 或者直接强制安装为硬依赖:
  npm install better-sqlite3 --save
  ```

  修复后,`codegraph status` 应该会显示 `Backend: native`。

**MCP server 连不上** —— 确认项目已初始化并完成索引,核对 MCP 配置里的路径,确认 `codegraph serve --mcp` 在命令行能正常启动。

**符号缺失** —— MCP server 在保存时会自动同步(等几秒)。必要时手动运行 `codegraph sync`。同时检查文件语言是否受支持,以及是否被配置中的排除规则过滤掉。

## 许可证

MIT

---

<div align="center">

**为 Claude Code 社区而生**

[报告问题](https://github.com/colbymchenry/codegraph/issues) · [提交特性请求](https://github.com/colbymchenry/codegraph/issues)

</div>
