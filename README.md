# Missher Evolution for DeepSeek Harness

`dsh-missher-evolution` is a prebuilt Cordis bundle for DeepSeek Harness Desktop
`>=0.1.8 <0.2.0`. It learns only bounded workflow categories, fixed preferences,
closed outcomes, counters, hashes, and verified Chinese instructions. It does not
train model weights or rewrite Harness, the plugin, or user projects.

Version `0.1.1` contributes approved Trial/Active rules through the Desktop
Brain Hub. The Hub remains the only component that appends recall context, so
MSE cannot create a second hidden prompt-injection path.

The same JavaScript tarball runs on macOS Intel, macOS Apple Silicon, and Windows
x64. There is no install-time build, native binary, external daemon, Python
runtime, messaging connector, or remote analytics service.

## Official distribution and branding / 官方分发与品牌

Source code remains available under [MIT](LICENSE). Re-uploading official plugin archives, checksums, or other Release assets under Missher identity, or using Missher branding to imply an unofficial build is official, requires prior written confirmation from `Missher12`. See [OFFICIAL_DISTRIBUTION.md](OFFICIAL_DISTRIBUTION.md) and [TRADEMARKS.md](TRADEMARKS.md).

源码继续使用 [MIT](LICENSE)。以 Missher 官方身份二传插件压缩包、校验文件或其他 Release 资产，或者使用 Missher 品牌让非官方构建看起来像官方版本，必须事先取得 `Missher12` 的书面确认。详见 [OFFICIAL_DISTRIBUTION.md](OFFICIAL_DISTRIBUTION.md) 和 [TRADEMARKS.md](TRADEMARKS.md)。

## Install

Build and verify a local release tarball from this directory:

```text
pnpm install --frozen-lockfile
pnpm run build
pnpm pack --pack-destination ./dist
node scripts/verify-package.mjs ./dist/dsh-missher-evolution-0.1.1.tgz
```

Install that tarball into the Harness profile that should use it:

```text
dsh plugin --profile <profile> add <absolute-path-to>/dsh-missher-evolution-0.1.1.tgz
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
startup, three matching independent sessions promote a Candidate to Trial, and
three successful attributed Trial contributions promote it to Active. A later
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
- Version `0.1.1` requires the host-provided `missherBrain` service shipped by
  DeepSeek Harness Desktop `0.3.8`; it intentionally does not fall back to a
  private injection listener when that service is absent.
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
