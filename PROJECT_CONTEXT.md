# Project Context

## 当前任务：MSE 0.7.0 公开插件分发与商店收录

2026-09-08 用户明确选择升级当前 MSE 到 0.7.0，随后授权“上”DSH 商店。
仅公开 Harness 插件及构建所需的 MIT TypeScript core，不改变整个统一仓库的可见性，
不修改 Desktop 或其他宿主，不改变学习算法，不导出用户状态。

- 公开插件仓库：Missher12/dsh-missher-evolution（public）。
- 统一源仓库：Missher12/missher-evolution-system（核验时 private）。
- 统一源版本 0.7.0，SHA `48ddd5f4e0fd7fd9901724c088958c7849ac3a54`。
- 工作树：dsh-missher-evolution-market；分支 codex/evolution-market-070。
- 基于原本会话独立工作树 `3f48efd940d821e2b96adaf7fa518d6fa2a89a93`，保留该
  codex/evolution-rule-review-20260906 分支，不覆盖其历史审核实现。

## 架构与文件

`src/` 为统一 MSE 的 Harness adapter；`agent-product/src/` 为其 MIT core 源码快照。
核心由构建器打入 lib，不要求安装另一个 SDK。公开根目录移动导致相对导入路径机械调整，
不修改运行逻辑。SOURCE_PROVENANCE.json 记录源和公开文件哈希、允许的调整及原始提交。
测试使用固定脱敏夹具；独立仓库不运行另一个宿主的 Python 对照实现。

`AGENT_INTEGRATION.md` 记录新电脑安装、激活与回滚边界。
README 和原官方分发/商标政策保留；官方 0.7.0 tgz 原样发布，并单独提供政策和接入文档，
避免重打包造成同版本不同内容。公开源码本地重建仅用于校验，不替换原始发布资产。

## 版本与依赖限制

0.7.0 与未发布的 0.1.2 审核版同名但 schema/API 不兼容。用户已选择统一 0.7.0；
不能将旧 MAINTENANCE_REPORT 的 104 测试和人工批准能力作为当前版本保证。
0.7.0 提供 snapshot/setEnabled/reset，不提供 reviewRule/restore；启动时使用 Brain Hub
或已有原生生命周期召回。此分发任务不新增任何注入路线，也不保证人工逐条批准后晋升。
共享数据目录是 DSH_HOME 级别，单独 Profile 不足以隔离状态。

商店来自 https://awesome-dsh-plugin.com/plugins.json 。需向其源码仓库提交单条 YAML，
其中 tarball 指向公开 GitHub Release 的固定标签资产；公开发布不等于商店已收录。
截至本轮开始商店没有本插件条目。本机 web 安装仍为 0.6.0，上次升级被 host_busy 阻止。

## 验证与交付

当前发布验证、最终公开 SHA、安装包 SHA-256、收录 PR 和状态记录于 MARKETPLACE.md。
必须区分源码回归、隔离 CLI 安装/卸载、Desktop UI 与真实模型效果；禁止以离线测试冒称学习效果。
继续维护统一源代码，再以有版本、有哈希的导出更新本仓库，避免两条独立算法实现分叉。
