# Pinable Desktop CodeGraph 运行时交付

## 范围与来源

本流水线为 `PinableAgents/codegraph` 生成组件运行时，不生成 Wails 安装包，不修改 Desktop 仓库、全局环境或消费者锁文件，不发布上游 npm 包。依据维护者提供的 `desktop-hybrid-release.md`：组件二进制/压缩包不进入 Git；Desktop 根据 `pinable-desktop/internal/assets/codegraph/component-lock.json` 校验版本、平台与 SHA256；不匹配必须在 Wails 构建前失败。

提供的文档没有给出该锁文件的 JSON schema，也没有提供其当前内容。因此这里定义的是**生产者清单** `codegraph-runtime-manifest.json`，不能直接改名覆盖 Desktop 的 `component-lock.json`，也不宣称已完成 Desktop 源码侧集成验收。

根 README 与 `scripts/build-bundle.sh` 保持上游归属。新增逻辑只放在 `.pinable/runtime.json`、`scripts/pinable/runtime/` 和独立 workflow 中。原 `pinable-sync-checks.yml` 增加可复用入口和可选源码 ref，原有构建、全量 engine/UI 测试、原生 kernel 回归不变。

## 获取产物

GitHub Actions → **Pinable desktop runtimes** → **Run workflow**。

- `publish=false`（默认）：六个平台全部通过后提供 `pinable-codegraph-all-platforms` artifact，保留 30 天。PR 和维护文件合入 main 时也自动构建测试产物。
- `publish=true`：只允许在 main 发布，所有检查通过后创建 `pinable-runtime-v<package-version>-<source-sha前12位>` GitHub prerelease。该版本不设置为 latest，不改变上游 `v*` 发布，也不上传 npm。不自动跟随上游 main 发布。
- 同一源码 SHA 对应的 tag/资产不覆盖；重复发布会失败而不是替换已锁定文件。上传中断可能留下 draft；维护者核实未发布状态后清理遗留 draft 和对应 tag 再重试。已发布资产不要删改，应提交新的源码版本再发布。

正常 Release 下载形式：

```text
https://github.com/PinableAgents/codegraph/releases/download/<releaseTag>/<asset.file>
```

Actions 下载的是外层 ZIP，先解开它；内部表格列出的 `codegraph-<target>.tar.gz` / `.zip` 才是 `CODEGRAPH_COMPONENT_ARCHIVE`，不要将 Actions 外层 ZIP 交给消费者。`pinable-codegraph-manifest` artifact 单独提供 JSON 清单与 SHA256SUMS，方便只下载校验信息。

PR artifact 是候选资产，不代表已发布或已纳入 Desktop 的验证版本。消费者必须固定源码 revision 和校验和，不能用 latest 绕过现有锁文件。

## 平台与文件

| Desktop 平台 | Bundle target | 压缩包 | 单独启动器 |
|---|---|---|---|
| darwin/arm64 | darwin-arm64 | codegraph-darwin-arm64.tar.gz | codegraph_darwin_arm64 |
| darwin/amd64 | darwin-x64 | codegraph-darwin-x64.tar.gz | codegraph_darwin_amd64 |
| linux/amd64 | linux-x64 | codegraph-linux-x64.tar.gz | codegraph_linux_amd64 |
| linux/arm64 | linux-arm64 | codegraph-linux-arm64.tar.gz | codegraph_linux_arm64 |
| windows/amd64 | win32-x64 | codegraph-win32-x64.zip | codegraph_windows_amd64.exe |
| windows/arm64 | win32-arm64 | codegraph-win32-arm64.zip | codegraph_windows_arm64.exe |

压缩包保留 `codegraph-<target>/` 顶层目录及 upstream 的 `node[.exe]`、`lib/dist/`、`lib/node_modules/` 布局，必带 `lib/kernel/codegraph-kernel.node`、SQL schema、浏览器 viewer、WASM grammars、CodeGraph/Node 许可证和 `runtime.json`。不依赖用户预装 Node/npm/Rust/Go。

Unix 入口为 `bin/codegraph`；Windows 原生入口为 `bin/codegraph.exe`，并保留 `bin/codegraph.cmd` 兼容入口。单独下载的启动器需与对应 archive 配套，放在解压后的 bundle 根目录或 `bin/`；它不是包含整个应用的单文件程序。Unix 单独下载后应设置可执行权限。

Go 启动器不经过 shell，原样传递参数与标准输入输出，保留退出码。Unix 使用 exec 保留 PID/信号；Windows 在启动 Node 前把自身放入 kill-on-close Job Object，防止启动器被强制终止后遗留 Node 子进程，无法建立进程约束时直接失败。默认设置 `CODEGRAPH_TELEMETRY=0`、`DO_NOT_TRACK=1`，不覆盖显式环境值；显式启用遥测还需同时满足上游环境开关规则。

## Desktop 接入

先下载对应压缩包、原生启动器、`codegraph-runtime-manifest.json` 和 `SHA256SUMS`，核验清单来自预期 Release/源码版本，再验证文件哈希。SHA256 完整性校验不等于签名认证。维护者按消费者已有 schema 审核更新源码 revision、版本、平台、文件名和两份 SHA256；不要跳过 Desktop 的锁定校验。

单目标调试可使用文档已定义的绝对路径接口。例如 Windows amd64：

```powershell
$env:CODEGRAPH_COMPONENT_ARCHIVE = (Resolve-Path '.\runtime-downloads\codegraph-win32-x64.zip').Path
$env:CODEGRAPH_COMPONENT_LAUNCHER = (Resolve-Path '.\runtime-downloads\codegraph_windows_amd64.exe').Path
# 必须已按当前 Desktop schema 审核更新组件锁；否则以下命令应拒绝这些资产。
go run ./pinable-scripts/cmd/pinable-build verify assets
go run ./pinable-scripts/cmd/pinable-build package --platform windows
```

多目标目录可通过 `CODEGRAPH_COMPONENT_ASSET_DIR` 提供，但目录/文件映射以 Desktop 当前实现与锁文件为准。本仓库不会推断并改写它。正常源码构建仍使用 `components --targets host` 或维护者显式 `--update-lock` 的原有流程。

macOS 产物按架构分开；它们不是 Universal 2 runtime。Desktop 的 Universal 2 PKG/DMG 仍由其原有打包流程处理。本流水线不包含 Windows managed launcher 的其他组件逻辑，也不会向 macOS/Linux 引入该功能。

## 验证、供应链与发布边界

应用只构建一次，并使用 `npm ci --omit=dev --ignore-scripts` 安装锁定生产依赖。原生 kernel 从同一 Git revision 通过 `cargo build --release --locked` 在六个目标系统/架构构建。Node 固定在 `.pinable/runtime.json`（固定为 v24.21.0），下载官方发行文件并在解压前核对同一 HTTPS 官方源的 `SHASUMS256.txt`；不是 GPG 签名验证。清单记录官方包哈希与实际 Go/Rust 工具链版本，`packageLockSha256` 是 Git 中 lock blob 的 SHA256，避免 Windows CRLF 导致错误漂移。Rust stable、Go 1.26.x 和 runner 镜像可更新，因此不承诺跨不同工具链构建的字节完全一致。

每个包实际解压到含空格/中文的路径，用包内 Node 校验版本、平台、SQLite/FTS5、kernel 合约和提取；再验证真实项目首次索引/增量同步、原生启动器成功与失败退出码，以及真实 stdio MCP initialize/tools-list。缺 kernel、架构错误、缺 viewer/WASM、任一平台失败或混合源码的资产均不能组成完整交付。

所有运行时通过并且既有完整质量检查通过后才产生汇总 artifact。发布作业单独获得 contents:write，其余作业仅 contents:read，不使用 RELEASE_PAT、npm OIDC 或其他发布凭据。

运行时不附加 Pinable Developer ID、notarization 或 Authenticode 签名；官方 Node 文件可能已有上游签名，但这不等于 Pinable 整包签名。macOS/Windows 的正式分发签名由 Desktop 发布流程负责，不能把 CI smoke test 当作 Gatekeeper/SmartScreen 或 Wails 安装包验收。

## 本地维护测试

```bash
python -m unittest discover -s scripts/pinable/runtime -p 'test_*.py' -v
(cd scripts/pinable/runtime/launcher && go test ./...)
```

打包与产物目录都在已有忽略规则覆盖的 `release/` 下；源码清理、升级和推送仍由维护者控制。

### Windows 短路径监听回归

首轮六平台验收在 Windows x64/ARM64 的 MCP 阶段发现 Node 24.16.0 所带 libuv 在 `RUNNER~1` 一类 8.3 路径下触发 `fs-event.c:72` 断言，进程直接终止。运行时固定升级为包含修复的 Node 24.21.0，不关闭监听、不删除中文/空格 fixture、不放宽退出码要求。生产者禁止回退到早于 24.21.0 的版本；smoke 同时检查真实目录文件事件。

对应原始资料：libuv/libuv issue #5010；Node v24.21.0 的 `deps/uv/src/win/fs-event.c` 中 `uv__relative_path` 已将该不可恢复断言改为受控失败返回。此改动仅调整 Pinable runtime 的 Node 固定版本，不修改上游 `scripts/build-bundle.sh`。
