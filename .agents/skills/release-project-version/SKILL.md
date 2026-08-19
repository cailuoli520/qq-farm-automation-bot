---
name: release-project-version
description: Safely prepare and publish versions of qq-farm-automation-bot. Use when the user asks to update or release a version, update CHANGELOG, create a release commit or Git tag, push a release to fork/main, or optionally rebuild Docker after publishing.
---

# 发布项目版本

在当前仓库准备并发布版本。保持流程可审计，但避免对同一发布计划重复索要确认。

## 不可变约束

- `core/package.json` 与 `web/package.json` 版本必须一致，仅允许 `YYYYMMDD`、`YYYYMMDD-beta.N`、`YYYYMMDD-rc.N`；Tag 为 `v版本`。
- 新版本必须严格高于本地及 `fork` 的所有有效 Tag，同名 Tag 不得存在。
- 只从当前 `main` 发布到 `fork/main`；`fork` 的 fetch/push URL 必须指向 `caoxicheng/qq-farm-automation-bot`。
- 业务改动与 `core/package.json`、`web/package.json`、`CHANGELOG.md` 组成的发布改动必须使用独立提交。
- 保留用户已有文件；不得 reset、checkout、stash、force push、移动或删除 Tag，也不得因发布修改 README。
- 任一校验、提交、Tag 或推送失败都立即停止，不以破坏性操作绕过。

## 发布流程

### 1. 预检与验证

读取工作区、分支、远程 URL、本地/远端 Tag、`fork/main`、两个包版本、CHANGELOG，以及从最新有效 Tag 到当前状态的提交和差异。同步 `fork` Tag 后再判断版本。

将未提交文件分为业务改动、发布文件和无关改动。无关文件不得纳入发布；范围不明确时才询问用户。

发布前至少运行：

- `npm test`、`npm run lint`（`core/`）
- `npm run lint`、`npm run build`（`web/`）
- 根目录 `git diff --check`

lint 带 `--fix`，运行前提示可能改写文件，运行后重新审计 diff。任何检查失败即停止。

### 2. 一次性发布确认

默认只请求一次发布确认。确认信息必须同时列明：

- 建议或指定的确切版本，以及 Beta、RC 或正式版类型；不得替用户选择发布类型。
- 业务提交的精确文件范围和提交信息；若业务改动已提交则说明无需业务提交。
- 发布提交固定包含的 3 个文件及 `chore(release): v版本`。
- 将创建的 annotated Tag、要推送到 `fork/main` 的提交范围，以及随后推送该唯一 Tag。
- 不使用 force push，并按仓库 `AGENTS.md` 的危险操作格式说明影响。

用户回复明确版本并确认发布后，该确认同时授权本次计划中的业务提交、发布提交、创建 Tag、推送 `main` 和推送 Tag。只要版本、文件范围、远端和操作类型没有变化，就不得在各步骤之间再次确认。

若用户只说“发布新版本”且未指定类型，把推荐版本和可选类型放在这一次确认中，例如要求回复“确认发布测试版”或“确认发布正式版”，不要先后拆成多个问题。

### 3. 连续执行

获得一次性确认后，按顺序执行：

1. 如有已确认的未提交业务改动，先只暂存这些文件并创建业务提交。
2. 同步两个包版本，在 CHANGELOG 顶部写入基于真实 diff 的 `## v版本（上海日期）` 条目。
3. 校验版本、标题和 Tag 一致，并确认发布 diff 只有 `core/package.json`、`web/package.json`、`CHANGELOG.md`。
4. 创建 `chore(release): v版本` 提交和 annotated Tag。
5. 再次确认 HEAD、工作区和 Tag 指向无误，然后依次推送 `main` 到 `fork/main`、推送唯一 Tag，并逐步核对远端 SHA。

不要因为前一步成功而放宽后续检查；失败时保留已经成功的历史并报告安全恢复方式。

## 可选 Docker 部署

发布成功后报告提交和 Tag。若用户在一次性发布确认中同时要求部署，可直接重建；否则只询问一次是否执行本地 Docker 重建。

用户同意后执行项目现有的 Docker Compose 构建启动命令，检查容器状态、健康状态、容器内版本和近期日志。部署失败不回滚已经发布的 Git 历史。
