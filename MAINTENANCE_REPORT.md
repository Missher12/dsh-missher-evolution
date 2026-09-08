> Historical report for the unpublished 0.1.2 review branch. It does not describe the selected MSE 0.7.0 release; see PROJECT_CONTEXT.md and MARKETPLACE.md.

# 经验规则插件 0.1.2 本地维护报告

## 兼容性结论

基线为 0.1.1 / `467a7ae3f5377090b0143e3679db710c67f2499a`，独立 remote
与预期一致，原工作树干净。本轮只修改独立插件的隔离工作树。

| 功能 | 原 0.1.1 缺少 Brain Hub | 本地 0.1.2 缺少 Brain Hub | 有 Brain Hub v1 |
|---|---|---|---|
| Host 启动、采集、持久化、维护、Remote 管理 | 强依赖阻塞 | 可用，Cordis 夹具已验证 | 可用 |
| 设置页 | Host Remote 不可用 | 需兼容标准 Client/Remote/Settings 服务 | 同左 |
| 规则贡献、归因 Trial 成功 | 不可用 | 不可用，无旁路 | 走唯一 Hub provider |

最小解耦已实现：仅将 provider 注册移动至 `ctx.inject(['missherBrain'], ...)`
子作用域。没有修改 Desktop，没有第二条上下文注入通道。原版 Harness 完整 UI
尚未实机验收；标准服务的存在不等于每个前端版本均兼容。

## 升级清单与问题处置

1. 基础实现：错误拦截、独立证据、过期/退役身份、容量上限、精确类别作用域。
2. 功能完善：逐条批准/撤销、证据/失效时间展示、版本绑定、备份恢复与宿主状态。
3. 测试优化：旧状态迁移、生命周期回放、异步撤销、包校验、隔离 CLI 安装/卸载。

问题：没有逐条审核接口，却描述为 approved。
原因：只有 snapshot/setEnabled/reset，自动晋升直接进入候选贡献集合。
影响：未审核规则可能进入上下文。
推荐方案：本轮加入 instructionHash 对应的批准状态及 revision/version 保护；新旧
未批准规则不可贡献，逐条撤销保留证据。改写和恢复都清除批准状态。

问题：completed 可在无助手结果时计为成功，工具错误可能消失，同一会话可重复晋升。
原因：把结束原因当作验证结果，Trial 成功缺少独立会话约束。
影响：错误经验和重复证据可能推动 Active。
推荐方案：无结果为 partial，工具错误阻止正向证据；三次 Trial 成功必须来自独立
且不同于来源的会话，归因绑定已接受的规则版本。纠正和失败导致暂停。

问题：退休身份可重建出相同 ID，超过 200 条后不能通过存储校验，过期规则可被刷新。
原因：匹配排除 retired，容量逻辑只改变状态，不减少存储条数。
影响：后续捕获事务失败或过期经验复活。
推荐方案：保留退休身份，不自动复活；容量满时停止增加新类别；来源观察不延长
Trial/Active 有效期，只由合格归因成功刷新。

问题：规则工作流类别被排序后写成先后执行顺序，通用规则可跨任务适用。
原因：把分类投影当作顺序证据，默认跨任务扩大范围。
影响：生成未被验证的顺序或互相竞争的指导。
推荐方案：文本明确这些是观察类别，顺序由当前任务决定；限制精确任务类别，
同类别只贡献一个工作流/防护及每种偏好一个规则。仍需人工判断语义冲突。

问题：撤销与异步批次、备份恢复之间有旧状态窗口。
原因：prepare 后未重查，备份带旧批准状态。
影响：撤销后仍可能接受旧规则或恢复批准。
推荐方案：accept 重查版本、内容、批准、开关、失效与取消；归因核对版本；
恢复验证 revision、先备份当前状态并清除批准，损坏状态恢复也清除批准。

问题：未提供 CLI 时 smoke 曾把手工目录标记计作安装成功。
原因：离线夹具与真实安装共用成功字段。
影响：夸大安装证据。
推荐方案：明确输出 offline-runtime-fixture / cli-install-with-runtime-fixture，
离线模式 profileInstall=false；本轮实际传入 CLI 验证。

## 修改文件

- 核心：`src/index.ts`、`adapter.ts`、`registry.ts`、`lifecycle.ts`、`types.ts`、
  `brain-provider.ts`、`maintenance.ts`、`store.ts`。
- 审核与 UI：`src/remote.ts`、`remote-contract.ts`、`typert.remote-client.ts`、
  `src/client/index.ts`、`EvolutionSection.tsx`、`locales.ts`。
- 回归：`tests/review-safety.spec.ts` 及 adapter、brain-provider、bundle-integration、
  evolution-section.client、lifecycle、manifest、remote 测试。
- 打包与文档：`package.json`、两项 scripts、`.github/workflows/verify.yml`、
  `README.md`、`PROJECT_CONTEXT.md`、本报告。分发政策及 LICENSE 未变。

## 可复现证据

- `pnpm test`：15 文件 / 104 测试全部通过，含实际 Cordis + 模拟宿主事件、
  隔离临时目录下持久化/重启/恢复、jsdom 审核按钮与修订参数。
- `pnpm exec tsc -p tsconfig.json --noEmit` 与 client 配置：通过。
- `pnpm pack --pack-destination ./dist` 和 `node scripts/verify-package.mjs <tgz>`：通过。
- `node scripts/native-smoke.mjs --archive <tgz> --cli <local-dsh-bin.js>`：
  Mac Intel / Node 25.6.0 / Harness CLI 0.1.1-rc.2，真实隔离 DSH_HOME 安装、
  dump-config、卸载；profileInstall、uninstall、adjacentDataPreserved、statePreserved
  均 true。包内模拟 6 次任务、审核晋升、重启、provider 贡献均 true。
- 包：`dist/dsh-missher-evolution-0.1.2.tgz`；随包 `.sha256` 为本地校验文件。
- 没有推送、tag、Release 或修改真实用户配置档案。

这些证据不证明实际学习效果；没有执行 Windows 原生验收、真实模型质量对照或
Desktop 图形界面原生验收。当前依赖是已安装锁文件依赖；未做新的依赖升级。

## 后续边界

旧版 0.1.1 的严格 schema 不读取新增字段，回退旧二进制需使用升级前备份。
档案内规则按任务类型共享，不承诺项目隔离。恢复不能撤回已发送到运行任务的上下文。
模型建议只产生待审核文本，不负责证明规则正确；固定分类和结束信号仍是启发式。
保留备份不自动删除；达到容量后应先审核、备份，再由用户决定是否重置收集周期。
