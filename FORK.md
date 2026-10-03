# Pinable CodeGraph fork

本仓库在 `colbymchenry/codegraph` 基础上保留 Pinable 的浏览器 UI、多项目工作区、G6 图谱工作台、中文界面与主题等定制。根目录 `README.md` 与已同步的上游版本保持一致；**本 fork 的使用说明请以本文件及 `ui/README.md` 为补充**。上游删除 README 的 UI 介绍不代表本 fork 删除了 UI 功能。

已同步版本记录在 [.pinable/upstream.json](.pinable/upstream.json)。维护者请阅读 [上游同步流程](docs/pinable/upstream-sync.md)。

## 从本 fork 源码运行浏览器 UI

在本仓库中使用 Node 22.5+（低于 25）：

自上游 1.6.1 同步起，浏览器 UI 入口需要显式设置 `CODEGRAPH_UI=1`；`ui`、`web` 和多项目工作区均适用。macOS/Linux 使用 `export CODEGRAPH_UI=1`，PowerShell 使用 `$env:CODEGRAPH_UI = '1'`。未设置时上游入口会提示浏览器 UI 尚未发布，后端索引与 MCP 不受影响。现有 G6 工作台没有删除。

```bash
npm ci
npm run build
node dist/bin/codegraph.js ui /path/to/indexed-project
```

需要先为目标项目建立索引。已经使用本 fork 构建并安装 CLI 时，也可使用 `codegraph ui`；`codegraph web` 是同一命令的别名。直接安装上游 npm 包不等于安装本 fork。

默认地址为 `http://127.0.0.1:4747`。支持 `--port <n>`、`--no-open`、`--read-only`，以及 `CODEGRAPH_BROWSER=none`。浏览器 UI 可阅读调用者、源码、被调用者、影响范围、执行链路、模块架构、Screens/Steps 图谱和保存的 trail；可通过搜索、文件视图与符号详情继续下钻。它读取已有索引，不会因为打开 UI 就重新建立索引。

## 多项目分析工作台

以下内容从 fork 的 README 迁移，避免再次与上游删除或改写相同段落发生冲突。

将已经建立索引的项目写入 JSON 配置，然后启动同一个本地服务：

```json
{
  "name": "MMO 工作区",
  "projects": [
    { "id": "server", "name": "游戏服务端", "path": "./server" },
    { "id": "client", "name": "游戏客户端", "path": "./client" }
  ]
}
```

```bash
codegraph ui --workspace ./workspace.json
# 或直接使用本 fork 的构建产物：
node dist/bin/codegraph.js ui --workspace ./workspace.json
```

`path` 可指向项目根目录，也可直接指向包含索引数据库的 `.codegraph` 目录（或 `CODEGRAPH_DIR` 指定的当前索引目录）；后者会规范化为所属项目根目录，确保源码路径正确。相对路径以配置文件所在目录为基准。项目 ID 和规范化后的项目目录必须唯一，根目录和对应索引目录不能重复挂载。缺失的项目目录或索引会显示为不可用，不影响其他项目启动；权限等其他路径错误仍会报告。项目列表在 UI 中只读。未指定工作区时仍支持原来的单项目启动方式。

工作区概览按需读取统计；统一搜索支持 `kind:function`、`lang:typescript`、`path:src/game` 等过滤语法，结果保留项目身份。项目间相同名称或内部 ID 的符号互不合并，执行链路始终限定在当前项目。新地址形如 `#/p/server/map`；旧地址指向第一个项目。

架构视图从目录开始下钻，提供关系权重、测试过滤、一跳聚焦与循环定位。可拖动节点整理链路，或用 Alt + 方向键微调；手动位置按项目和分析范围保留，可一键恢复自动布局。播放流向时，动画沿调用／依赖方指向目标（最多同时播放 200 条当前关系）；这是静态关系示意，不代表运行时数据。SVG 和图片导出保留手动位置及方向箭头。连线可切换曲线和直线；选择节点并开启“只看聚焦”后，可用“紧凑排列”将局部节点排近并自动适应视野。密集区域可结合节点拖动与最小关系权重过滤。图谱上限为 400 个分析节点、2,000 条关系，超限时使用目录分页缩小范围。文件级循环通过显式操作按需加载，限定 400 个文件、2,000 对文件关系；超出此范围需继续下钻。符号详情可分页浏览全部上下游，每页 50 条。索引更新使旧游标失效时可重新加载。

查询在两个独立 Worker 中执行，默认含排队时间的 3 秒预算；超时显示恢复入口。相同版本的聚合请求合并，结果缓存最多 64MB。布局运行于浏览器 Worker，项目切换取消旧请求并保留各项目轻量阅读上下文。

规模数据生成、复测命令与实测结果见 [工作台验收记录](docs/plans/2026-09-06-analysis-workbench.md)。这些指标是测试结果，不代表所有真实项目的性能保证。

## 开发与验证

```bash
npm run build
npm run build:lib
npm test
node --test scripts/pinable/sync-upstream.test.mjs
node scripts/pinable/sync-upstream.mjs --check
```

`build:lib` 单独构建 UI 组件包，不会发布 npm 包。本次同步不改变包名、版本、发布凭据、已有 Release 工作流或主分支保护规则。
