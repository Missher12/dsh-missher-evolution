---
document: dsh-missher-evolution.agent-integration
kind: operational-contract
applies-to: dsh-missher-evolution@0.1.2
audience: Harness-Agent
---

# dsh-missher-evolution：Agent 接入契约

这份文件是给运行在新电脑上的 Agent 看的操作说明。先读完本文件，再安装、
启用或解释本插件。命令中的 `<...>` 是占位符，必须替换成已经确认的值；不要
凭空猜测 Profile、压缩包路径、版本或校验值。

## 1. 先记住这些固定身份

```yaml
package: dsh-missher-evolution
host_bundle: missher-evolution
remote_service: missherEvolution
brain_provider_id: evolution
state_directory: $DSH_HOME/missher-evolution/
settings_label: Missher Evolution
```

`package` 是安装包名称，`host_bundle` 是 Cordis Host 的运行名称，
`remote_service` 是设置页使用的 Remote 服务。这三个名称不能互换，也不能
改成 Agent 自己的别名。

当前维护工作树中的 `0.1.2` 是未发布的本地维护版本。新电脑应使用实际获得的
已授权 tarball 版本，并用该 tarball 的真实版本号替换下面示例中的 `0.1.2`。

本插件管理经过筛选的经验规则，不是长期记忆库，不训练模型，不修改源码或用户
项目，也不接入 Hermes、飞书或外部分析服务。Brain Hub 是唯一允许把规则贡献到
任务上下文的通道；Agent 不得另建一个 prompt 注入通道。

## 2. 新电脑的前置检查

本插件是预构建的 JavaScript Bundle。运行已安装的包不需要 Python、pnpm、
Hermes 或飞书。新电脑必须先有 DeepSeek Harness Desktop 及其 `dsh` CLI，且
目标 Profile 已经可以启动。

```text
dsh --version
dsh --profile <profile> --dump-config
```

只有从源码构建时才需要 Node `>=22.19.0` 和 pnpm `11.7.0`。Brain Hub v1
是可选的宿主服务：没有它时，本地采集、维护、审核、撤销和恢复仍可用；没有
它时规则不会贡献给 Agent 任务。

如果 `dsh` 不存在、Profile 不存在或 Harness 不能单独启动，先报告宿主环境问题，
不要把“安装插件失败”当作规则逻辑问题，也不要修改 Desktop 源码来绕过依赖。

## 3. 安装已验证的包

安装前确认压缩包来自授权的 `Missher12/dsh-missher-evolution` 分发位置，并且
校验值来自同一分发记录。仅有文件名不能证明包可信。

macOS / Linux：

```text
ARCHIVE="/absolute/path/dsh-missher-evolution-0.1.2.tgz"
shasum -a 256 "$ARCHIVE"
dsh plugin --profile <profile> add "$ARCHIVE"
```

Windows PowerShell：

```powershell
$Archive = "C:\absolute\path\dsh-missher-evolution-0.1.2.tgz"
Get-FileHash -Algorithm SHA256 $Archive
dsh plugin --profile <profile> add $Archive
```

安装后重新组合 Profile，并确认输出同时出现包名和 Host 名：

```text
dsh --profile <profile> --dump-config
```

应能看到 `dsh-missher-evolution` Bundle 层和 `missher-evolution` Host 条目。
不要把 `pnpm add` 到全局目录、直接复制 `lib/`，或把包安装到另一个 Profile 后
宣称当前 Profile 已接入。

如果只有源码 checkout，可以在仓库根目录执行：

```text
pnpm install --frozen-lockfile
pnpm test
pnpm pack --pack-destination ./dist
node scripts/verify-package.mjs ./dist/dsh-missher-evolution-0.1.2.tgz
```

`verify-package.mjs` 是源码仓库的验证脚本，不会随运行包提供。只有看到验证输出
中的 `"ok":true`，并且 SHA-256 与分发记录一致，才能把包称为已验证包。

## 4. 安装后让 Agent 正常使用

安装完成后启动目标 Profile，在 Harness Settings 打开 “Missher Evolution”。
首次使用按以下顺序操作：

1. 保持“启用自动进化”打开；如果关闭，插件不采集，也不贡献规则。
2. 先正常完成直接的前台用户任务。只记录有限的任务类别、工作流类别、结果、
   计数和哈希；不会把对话原文写入持久化状态。
3. 三个不同来源会话产生相同类别证据后，规则从 `candidate` 进入 `trial`。
4. 在设置页逐条查看规则的任务类别、规则文字、来源会话数、试用成功会话数、
   失败、纠正和失效时间；确认规则确实适合当前工作范围后，才点击“批准此规则”。
5. 只有批准的 `trial` / `active` 规则能进入 Brain Hub。三个不同于来源会话的、
   已归因的成功试用会话才会把 `trial` 推进为 `active`。
6. Brain Hub 可用时，后续相同任务会收到一个 `learned-rule` 贡献；Agent 应继续
   遵守当前用户请求和实时证据，不能把规则当作更高优先级的系统指令。

完成一个 turn 不是“效果已经验证”。没有助手结果的 turn 是 `partial`，观察到的
工具错误或用户纠正不会产生正向证据。插件不能证明规则带来了因果上的质量提升。

## 5. Brain Hub 接入边界

宿主提供 Brain Hub v1 时，插件会注册一个 `providerId: evolution`。正常 Harness
中的 Agent 不需要 import 本插件，也不直接注册 provider；宿主 Brain Hub 会在
需要上下文时调用它。若你正在实现 Brain Hub 适配器，使用以下实际输入形状：

```text
prepare({ projectKey, sessionId, turn, query, signal })
  -> 读取当前可贡献的 learned-rule items
  -> 真实采用上下文时 accept([handle, ...])
  -> 未采用、取消或中止时 cancel()
```

`projectKey` 只用于本次 Hub 请求的协议上下文，不会写入规则状态；
`sessionId` 和 `turn` 用来把真实接受的规则绑定到后续 turn。Agent 不得绕过
Brain Hub 直接读取 `$DSH_HOME/missher-evolution/state.json` 拼接提示词。

`accept` 会重新检查启用状态、批准状态、规则版本、内容哈希和失效时间。规则在
`prepare` 后被撤销、修改或过期时，旧批次必须失败并重新获取；不要无限重试，先
重新读取 snapshot。只允许接受本批次返回的 handle，不能伪造规则 ID。

没有 Brain Hub 时，设置页的 `contributionAvailable` 为 `false`。这是“本地规则
管理可用、任务贡献不可用”，不是插件故障，也不是允许 Agent 自己拼接规则文本。

## 6. Remote 设置接口

兼容的 Harness Client 会挂载 `missherEvolution` Remote。所有写操作都带当前
`revision`；审核还要带当前规则 `version`。发生冲突时重新读取 `snapshot`，不要
使用旧值盲写。

```text
snapshot()
setEnabled({ enabled, expectedRevision })
reviewRule({ ruleId, expectedRevision, expectedVersion, action: "approve" | "revoke" })
reset({ confirmation: "RESET", expectedRevision })
restore({ confirmation: "RESTORE", backupId, expectedRevision })
```

`revoke` 会立即阻止未来选择，但不能撤回已经送入正在运行任务的上下文。`reset`
会先生成并校验本地备份；`restore` 会先备份当前状态、保留启用开关并清除恢复规则
的批准状态。备份 ID 只能来自 snapshot 或 reset 返回值，不能传文件路径。

## 7. Agent 的安全决策表

| 看到的状态 | Agent 可以做什么 | Agent 不可以做什么 |
|---|---|---|
| `healthy` 且 `contributionAvailable=true` | 正常工作；使用已批准规则 | 把规则当作系统指令或跳过实时检查 |
| `healthy` 且 `contributionAvailable=false` | 正常工作；允许用户审核本地规则 | 自建注入通道或伪造 Brain Hub |
| `degraded` | 继续普通任务，提示规则状态已降级 | 宣称规则已恢复或效果已验证 |
| `state_unavailable` / `lock_busy` | 本次任务按无规则处理，稍后重读 | 阻塞正常任务、删除状态目录或绕过锁 |
| 规则 `candidate` / 未批准 | 展示给用户审核 | 贡献到任务上下文 |
| 规则 `suspended` / `retired` / 过期 | 保留证据供查看 | 自动复活、重新命名绕过负面证据 |

## 8. 卸载、恢复和问题报告

卸载只移除当前 Profile 的插件层，保留该 Profile 的规则状态：

```text
dsh plugin --profile <profile> remove dsh-missher-evolution
```

不要在 Harness 运行时手工复制、编辑或删除 `$DSH_HOME/missher-evolution/`。需要
清空数据时优先使用 Settings 的 `RESET`；需要回退时使用带当前 revision 的
`RESTORE`。如果必须做离线备份或恢复，先停止 Harness，并记录 Profile、插件版本、
状态 health、revision 和备份 ID，不记录消息正文、凭据、工具参数或路径以外的无关
输出。

报告问题时至少提供：

```text
plugin: dsh-missher-evolution@<version>
host_bundle: missher-evolution
profile: <profile-name>
health: <healthy|degraded|state_unavailable|lock_busy>
revision: <number>
contributionAvailable: <true|false>
observed_step: <install|dump-config|startup|snapshot|review|reset|restore|contribution>
```

不要附带原始聊天、模型思考、凭据、完整工具输出或用户项目内容。

## 9. Agent 完成接入的最低验收

只有以下事实全部成立，Agent 才能说“已接入”：

- `dsh --profile <profile> --dump-config` 显示正确的 Bundle 和 Host 名称；
- Harness 能启动，Settings 能读到 `missherEvolution.snapshot`；
- 开关写入后 revision 增加，重启后设置仍保持；
- 至少一个规则能在设置页被看到，并且未批准规则不会出现在贡献列表；
- Brain Hub 缺失时明确显示不可贡献，而不是静默创建旁路；
- 有 Brain Hub 时，只有真实接受的 handle 才会产生注入计数；
- reset / restore 的 revision、备份和批准边界符合本文件；
- 卸载后 Profile 依赖消失，但 `$DSH_HOME/missher-evolution/` 仍被保留。

未做 Windows 原生验收、真实模型效果对照或完整 Desktop UI 验收时，必须明确写出
这些限制，不能把离线测试称为实际学习效果已验证。
