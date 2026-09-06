# Missher Evolution for DeepSeek Harness

`dsh-missher-evolution` is a prebuilt Cordis bundle for DeepSeek Harness Desktop
`>=0.1.8 <0.2.0`. It collects bounded workflow categories, fixed preferences, closed outcomes,
counters, hashes, and Chinese rule candidates for human review. It does not
train model weights or rewrite Harness, the plugin, or user projects.

Version `0.1.2` contributes approved Trial/Active rules through the Desktop
Brain Hub. The Hub remains the only component that appends recall context, so
MSE cannot create a second hidden prompt-injection path.

The same JavaScript tarball runs on macOS Intel, macOS Apple Silicon, and Windows
x64. There is no install-time build, native binary, external daemon, Python
runtime, messaging connector, or remote analytics service.

## Official distribution and branding / 官方分发与品牌

Source code remains available under [MIT](LICENSE). Re-uploading official plugin archives, checksums, or other Release assets under Missher identity, or using Missher branding to imply an unofficial build is official, requires prior written confirmation from `Missher12`. See [OFFICIAL_DISTRIBUTION.md](OFFICIAL_DISTRIBUTION.md) and [TRADEMARKS.md](TRADEMARKS.md).

源码继续使用 [MIT](LICENSE)。以 Missher 官方身份二传插件压缩包、校验文件或其他 Release 资产，或者使用 Missher 品牌让非官方构建看起来像官方版本，必须事先取得 `Missher12` 的书面确认。详见 [OFFICIAL_DISTRIBUTION.md](OFFICIAL_DISTRIBUTION.md) 和 [TRADEMARKS.md](TRADEMARKS.md)。

## Install

If an Agent is installing this plugin on a fresh computer, read
[AGENT_INTEGRATION.md](AGENT_INTEGRATION.md) first. It is the operational contract
for package verification, Profile installation, optional Brain Hub capability,
review, rollback, privacy, and the evidence required before claiming that the
plugin is connected.

Build and verify a local release tarball from this directory:

```text
pnpm install --frozen-lockfile
pnpm run build
pnpm pack --pack-destination ./dist
node scripts/verify-package.mjs ./dist/dsh-missher-evolution-0.1.2.tgz
```

Install that tarball into the Harness profile that should use it:

```text
dsh plugin --profile <profile> add <absolute-path-to>/dsh-missher-evolution-0.1.2.tgz
```

Harness activates the bundle for that profile. Open Harness Settings and select
“Missher Evolution” to inspect status, enable or disable learning, review rules,
or start a protected reset.

## Verify

Inspect the composed profile without starting an agent:

```text
dsh --profile <profile> --dump-config
```

The output should contain one `dsh-missher-evolution` bundle layer and one
enabled `missher-evolution` Host entry. `node scripts/verify-package.mjs <tgz>`
prints fixed JSON containing `ok`, file count, byte count, and SHA-256.

Runtime verification should use the Settings snapshot: maintenance runs after
startup and three matching independent source sessions promote a Candidate to Trial.
Only explicitly approved rules can contribute. Three successful attributed Trial
contributions from distinct sessions outside the source sessions promote it to Active.
A completed turn is an observation, not proof of correctness or causal improvement.
Missing assistant results are partial; observed tool errors prevent positive evidence. A later
matching direct user task contributes a `learned-rule` item to the Brain Hub;
the one visible recall message keeps the `missher-brain` source identity.

## Data

Each Harness home owns an independent local directory:

```text
$DSH_HOME/missher-evolution/
```

It contains schema-validated state, a bounded closed-event audit, a short-lived
cross-process lock, and validated backups. Durable data never contains raw user
messages, assistant responses, thinking, tool arguments, tool results, absolute
paths, URLs, email addresses, credentials, or provider/model route names.

The state is not shared with any other agent host. Model review uses only rule
metadata and the most recent in-memory foreground route, and is skipped when no
route exists. Store, classifier, lock, or advisor failures are fail-open and do
not reject a normal Harness step.

## Review and revoke

Every new and legacy rule starts unapproved unless an exact instruction hash was
explicitly approved in this version. Settings shows category, task scope, rule text,
source/trial session counts, failures, corrections and expiry. Approve or revoke one
rule using its current revision and version; stale requests fail. Revoking approval
stops future selection without deleting its evidence. It cannot retract context that
was already delivered to a running task. Reapproval is available for unexpired
Candidate/Trial/Active rules; suspended and retired rules cannot bypass negative evidence.
Prepared batches recheck approval, version, expiry, enabled state and cancellation
before accepting, and completion evidence is bound to the accepted rule version.

## Reset

In Settings, choose Reset and complete both confirmations. The Remote requires
the exact current state revision and the literal confirmation `RESET`; stale or
malformed requests are rejected. Reset clears learned rules and counters while
preserving the current enabled preference.

## Backup

A reset creates and validates a backup before replacing state. Scheduled
maintenance also creates a backup before applying expiry, retirement, or a
bounded advisor rewrite. The Settings response identifies the reset backup;
backup contents remain local under `$DSH_HOME/missher-evolution/backups/`.

Settings can restore the most recent backup by typing `RESTORE` in the confirmation
field. Restore checks the current revision, validates the backup, backs up the current
state, preserves the enabled choice and clears all restored approvals. Remote `restore`
also accepts an explicit validated local backup ID; paths are rejected. Corrupt-state
backup recovery likewise clears approval.

Do not edit or copy a live state directory between profiles. Stop Harness before
performing any explicit offline backup or restore operation.

## Uninstall

Remove the plugin from one profile with:

```text
dsh plugin --profile <profile> remove dsh-missher-evolution
```

Uninstall removes the profile dependency and bundle layer. It intentionally
preserves `$DSH_HOME/missher-evolution` so uninstall cannot erase learned data
or unrelated profile/session content. Delete that directory separately only
after Harness is stopped and any desired backup is verified.

## Limitations

- The supported Harness range is `>=0.1.8 <0.2.0` (dsh runtime
  `>=0.1.0-rc.5 <0.2.0`). Verified additionally on DeepSeek Harness Desktop
  `0.2.2` (dsh runtime `0.1.0-rc.8`); the bundle ships the `./client` and
  `./package.json` exports that the 0.2.x client-modules/typert loaders
  require, and resolves its mounted Remote namespace through the Remote
  service instead of the inject-gated `ctx.remote.<namespace>` property.
- Version `0.1.2` starts local capture, settings and maintenance without `missherBrain`.
  Contribution still requires the host-provided Brain Hub protocol v1. The provider
  registers when the service becomes available and disposes with its service scope.
  No private injection listener or Desktop modification is included.
- Historical version ranges above are not a current full UI compatibility certification.
  The local CLI install test and Cordis fixtures do not certify every original Harness UI.
- Scope is the current DSH_HOME/profile state and exact task category, not a project
  boundary. `projectKey` is not persisted or used to promise project isolation.
  General rules do not automatically apply to other task categories.
- At most one workflow, one guardrail and one rule per preference type are selected
  per task category. This deterministic conflict policy is not semantic contradiction detection.
- The 200-rule limit includes retired identities: new families stop being added at
  capacity. Retired/suspended families do not silently revive; export or reset with
  a verified backup for a fresh collection period.
- Model advisor text changes clear approval and Trial success evidence. Advisor output
  is a proposal requiring human review, not verified learning. Approved rules are not rewritten.
- This maintenance build has local macOS Intel CLI and simulated lifecycle evidence;
  no Windows native run, real model learning evaluation or Desktop UI acceptance was performed.
- Only direct foreground user turns are learned; subagents, internal work,
  plugin messages, scheduled work, and tool continuations are filtered.
- The first release recognizes a closed preference allowlist and does not copy
  arbitrary correction text into durable rules.
- It improves future instructions and workflow reuse; it does not fine-tune or
  replace the underlying DeepSeek model.
- It does not import or synchronize state from another agent host.
- No process continues after Harness exits.

## Development

```text
pnpm test
pnpm exec tsc -p tsconfig.json --noEmit
pnpm exec tsc -p tsconfig.client.json --noEmit
```
