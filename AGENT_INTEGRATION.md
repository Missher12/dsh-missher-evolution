# MSE 0.7.0：新电脑 Agent 接入

适用包：`dsh-missher-evolution@0.7.0`。权威公开分发仓库：
https://github.com/Missher12/dsh-missher-evolution 。本版是用户选定的统一 MSE
Harness 适配器，不是本仓库历史的 0.1.2 人工审核实验分支。

## 身份和边界

- Bundle：`missher-evolution`；Remote：`missherEvolution`；设置页：Missher Evolution。
- 数据目录：`$DSH_HOME/missher-evolution`，同一个 DSH_HOME 的不同 Profile 不隔离此目录。
- 运行需要兼容的 Harness 服务和 Node >=22.19.0（可由 Desktop 内置），不要求另装 SDK、Python、Hermes 或飞书。
- 管理有界经验规则，不保存原始聊天、凭据或无关工具输出，不训练权重、不自动改源码。
- 0.7.0 在启动时选择 Brain Hub 或原生生命周期召回，不能再由 Agent 建第二条注入通道。
- Remote 支持 snapshot、setEnabled、reset；不支持历史 0.1.2 的 reviewRule、restore。
  规则可查看，但没有逐条人工批准开关；不要声称已提供人工审核晋升。

## 安装

1. 核实用户实际使用的 DSH_HOME、Profile、宿主版本和 CLI 路径。Desktop 使用它内置的
   CLI 和运行时；不能用 PATH 中另一个 CLI 的结果代替 Desktop 验收。
2. 检查已有安装版本。0.6.0 可通过同系列 MSE 管理器升级；若发现 0.1.2 审核版或
   无法识别的数据格式，停止覆盖，先准备明确的数据迁移或新的 DSH_HOME。
3. 已有安装应先退出目标宿主，备份同一时点的包、Profile 配置和规则目录。
   已安装 MSE 管理器时可用 `mse update --host harness --profile <profile> --tag v0.7.0`
   生成计划，核对后加 `--apply --maintenance-window` 执行。host_busy 必须停止，不删锁绕过。
   此管理器仍使用统一 MSE 的原发布源，不是公开商店安装的前置依赖。
4. 新电脑可以直接从本仓库的公开 Release 下载 tgz 和校验文件，核对 SHA-256 后安装：

```text
dsh plugin --profile <profile> add <absolute-path>/dsh-missher-evolution-0.7.0.tgz
dsh --profile <profile> --dump-config
```

确认配置包含一个 `dsh-missher-evolution` Bundle 和启用的 `missher-evolution` Host。
商店搜索依赖上游收录；公开 Release 或本地安装本身不等于上架。

## 激活验收

重启目标宿主，打开设置页并实际读取状态，确认无加载错误、版本正确。
配置解析、磁盘安装、设置页激活、规则实际贡献必须分别报告。
不要为了证明接入把测试规则写进用户的真实规则库。

Candidate、Trial、Active 证据是有界启发式和小样本处理/对照观察，不能证明长期效果。
离线方法评测不会授予 Active 或回填真实成功。包内 check-cli 只进行受限文件检查；
仅存在工具描述不等于当前任务已实际调用它。

## 停用、回滚和卸载

设置页关闭学习可停止后续工作。需要二进制回滚时退出宿主，并恢复同一份升级前备份的
包、配置、数据；不能仅降级包而保留不兼容的新状态。0.7.0 没有 restore Remote。

```text
dsh plugin --profile <profile> remove dsh-missher-evolution
dsh --profile <profile> --dump-config
```

核对 Bundle 已移除、相邻插件仍存在；数据保留不代表卸载失败。删除规则数据需要另行授权。
不要接入其他宿主的状态，也不要让 Memory 重复保存这份规则库。
