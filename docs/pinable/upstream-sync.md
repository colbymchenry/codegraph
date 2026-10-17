# Pinable fork：上游同步与冲突治理

## 文档与代码归属

`README.md` 由上游维护，必须与 `.pinable/upstream.json` 记录的提交逐字节一致。Pinable 的 UI / 工作区说明放在根目录 `FORK.md`，维护工具放在 `scripts/pinable/`，维护文档放在 `docs/pinable/`，CI 使用独立的 `pinable-sync-checks.yml`，不修改上游 Release 工作流。

共享核心仍接受正常的三方合并。不要给源码、README、package-lock 或整个目录配置 `merge=ours`，也不要使用全局 `-X ours` / `-X theirs`。这会隐藏需要人工判断的变更。后续新增 fork 能力优先放在独立模块，通过小型调用点接入共享核心；本次不为降低行级冲突而大规模重构核心。

## 标准流程

先提交或移走本地改动，再从最新主分支创建同步分支（把日期替换为实际日期）：

```bash
git switch main
git pull --ff-only origin main
git switch -c sync/upstream-YYYY-MM-DD
node scripts/pinable/sync-upstream.mjs
```

脚本只允许在 `sync/` 分支上运行，拒绝浅克隆、脏工作区（包括未跟踪文件）、进行中的 Git 操作和错误的 upstream remote。首次运行会配置 upstream；已有 remote 不匹配时不会擅自覆盖。默认拉取上游 main；`--no-fetch` 仅使用你已核对的本地 `upstream/main`，主要用于离线复核与测试。

脚本保留真实的 merge 父提交，使用 `--no-ff --no-commit`，不会自动提交、推送、stash、reset 或选择冲突一侧。干净合并后会更新并暂存 `.pinable/upstream.json`。上游历史被重写或出现不相关历史时会停止，不会强行合并。

遇到冲突时，审阅 `git status`，按语义合并双方代码并逐个暂存：

```bash
git add path/to/resolved-file
node scripts/pinable/sync-upstream.mjs --finish
```

`--finish` 会验证待合并提交确实属于已获取的上游分支、无未解决冲突、无未暂存的跟踪文件改动，且暂存的 README 等于上游，然后更新版本记录。**不要把尚未合并的上游 SHA 手工写入 manifest 来绕过检查。** 取消本次操作用 `git merge --abort`。

验证并提交：

```bash
node --test scripts/pinable/sync-upstream.test.mjs
npm ci
npm run build
npm run build:lib
npm test
git diff --cached --check
git diff --cached
git commit
node scripts/pinable/sync-upstream.mjs --check
git push --set-upstream origin HEAD
```

随后创建到 main 的 PR，检查 CI 后使用 **Create a merge commit** 合入。同步 PR **不得 squash 或 rebase**，否则上游提交没有成为 main 的祖先，下次同步仍可能重新处理同一批变更。`--check` 在 CI 验证记录的上游提交是真实祖先，并检查 README 的归属；它不是源码语义验证的替代品。

## 冲突复用的边界

脚本在当前克隆启用 `rerere.enabled=true`，并明确设置 `rerere.autoupdate=false`。Git 可以复用之前记录的同形冲突解法，但不会把复用结果自动暂存；必须检查后 `git add`。该记录位于当前克隆的 Git 元数据中，不随仓库推送，也不会自动共享给其他开发者或 GitHub 的临时 runner。错误的记录应通过 `git rerere forget <path>` 清除后重新处理。

这能减少重复劳动，不能保证未来永远没有冲突。双方修改同一核心接口、数据库语义或 UI 协议时，仍需语义判断和回归测试。不要把 rr-cache、凭据或本地 Git 配置提交到仓库。

## 本次同步基线（2026-09-20）

- fork 原 main：`c0d16cbe3ccc7ec89e65ef06b996cf72f132f102`。
- 共同祖先：`3ed73bc127323e63153bf6ec8354afa82ce36aaf`。
- 上游目标：`ba3c21e50d9129d2f5f3843ec3728868ae6d47a1`，22 个上游提交；保留 fork 的 19 个独立提交。
- 实际文本冲突：上游删除 README 的浏览器 UI 段落，fork 在该段落中增加多项目工作台文档。将 fork 说明迁至 `FORK.md`，README 恢复上游原始 blob，不删除 UI 源码。
- `src/index.ts` 的 Git 索引状态更新与 fork 工作区接口、`src/db/queries.ts` 的原子边替换与 fork 工作台查询均保留，三方合并无文本冲突。
- 维护工具的 14 项独立 Git fixture 测试覆盖连续两次同步、真实 merge 祖先、幂等性、README 归属、冲突停止与 rerere 复用、脏工作区、浅克隆、分支/remote 防护。源码构建和全量回归的实际状态以 PR 的 CI 结果为准。

## CI

`Pinable sync checks` 只使用读取仓库内容的权限，不发布包，不持有 Release 凭据。PR 验证合并结果；main 的 push 也执行验证。包括维护工具测试、祖先/README 检查、应用和 UI 组件包构建、全量 Vitest，以及单独的 Rust kernel 构建和针对性原生回归。日志作为 Actions artifact 保留，用于区分代码失败与 runner 环境失败。
