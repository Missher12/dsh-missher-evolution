# Missher Evolution for DeepSeek Harness

`dsh-missher-evolution` is a prebuilt Cordis bundle for DeepSeek Harness Desktop
`>=0.3.8`, using native lifecycle hooks or the optional Brain Hub service. Version 0.7.0 retains current eventAt-based session logs and evidence-bound registered methods, and belongs to the unified MSE release. It learns only bounded workflow categories, fixed preferences,
closed outcomes, counters, hashes, and verified Chinese instructions. It does not
train model weights or rewrite Harness, the plugin, or user projects.

It is the first production reference adapter for `@missher/evolution-sdk`. Cordis lifecycle events
are translated by the Harness adapter, while selection, Capture, attribution, persistence, and
maintenance run through the host-neutral SDK. The SDK is bundled into this plugin's generated Host
code, so Harness users do not install or configure a second package.

The same JavaScript tarball runs on macOS Intel, macOS Apple Silicon, and Windows
x64. There is no install-time build, native binary, external daemon, Python
runtime, messaging connector, or remote analytics service.

## Install

Public distribution: [v0.7.0](https://github.com/Missher12/dsh-missher-evolution/releases/tag/v0.7.0).
The release tarball is byte-identical to the unified MSE 0.7.0 Harness artifact.
See [AGENT_INTEGRATION.md](AGENT_INTEGRATION.md) before installing on a new computer.
Marketplace submission is separate from release publication; a release alone does
not make this plugin searchable in DSH Market.

Install the prebuilt public archive after verifying the release checksum:

```text
dsh plugin --profile <profile> add https://github.com/Missher12/dsh-missher-evolution/releases/download/v0.7.0/dsh-missher-evolution-0.7.0.tgz
```

Close the target host before changing an existing installation, and preserve a
matched backup of the plugin, Profile configuration and `$DSH_HOME/missher-evolution`.
Do not overwrite the experimental 0.1.2 review branch's data: its approval schema
is incompatible with this unified release. Different Profiles in the same DSH_HOME
still share evolution state; a separate Profile alone does not isolate that data.

Build and verify a local release tarball from this directory:

```text
pnpm install --frozen-lockfile
pnpm run build
pnpm pack --pack-destination ./dist
node scripts/verify-package.mjs ./dist/dsh-missher-evolution-0.7.0.tgz
```

Install that tarball into the Harness profile that should use it:

```text
dsh plugin --profile <profile> add <absolute-path-to>/dsh-missher-evolution-0.7.0.tgz
```

Harness activates the bundle for that profile. Open Harness Settings and select
“Missher Evolution” to inspect status, enable or disable learning, review rules,
or start a protected reset.

Here “review” means inspect rules. Version 0.7.0 does not expose per-rule
`reviewRule` approval/revocation or a `restore` Remote; do not promise those APIs.

## Verify

Inspect the composed profile without starting an agent:

```text
dsh --profile <profile> --dump-config
```

The output should contain one `dsh-missher-evolution` bundle layer and one
enabled `missher-evolution` Host entry. `node scripts/verify-package.mjs <tgz>`
prints fixed JSON containing `ok`, file count, byte count, and SHA-256.

Runtime verification should use the Settings snapshot. Recall has one owner: when `missherBrain`
exists it offers scoped handles; otherwise native `agent/pre-step` uses `session.header.cwd` and
credits only its context message actually appended to the session. Rejected/canceled context is not
an injection. `eventAt` is scanned within a bounded tail, with legacy event arrays still supported.
Candidate evidence can create a Trial, but Active promotion additionally
requires three supported treatment successes, two supported control observations, no treatment
contradiction, and at least 0.15 observed uplift. These minimum samples do not establish statistical
significance. Instruction rewrites start a new evidence epoch, and partial acceptance cannot be used
to evaluate the trial. The Settings snapshot distinguishes recorded tasks from causal evidence.

## Registered Methods

Accepted source-date and unknown-value checks can now retain bounded failure/repair
case metadata. Maintenance proposes a compatible registered method using the existing
AI budget or a clearly identified deterministic fallback. A separate fixed held-out
evaluator tests failures, correct outputs and non-applicable inputs before the method
can enrich an eligible local rule. These offline results never award Active status,
real-task successes or measured model uplift.

After a trusted first failed file check, an existing next `agent/pre-step` continuation
can receive one fixed repair hint. It remains within the user's original authority,
does not itself write files, and requires a fresh native check. Read-only requests,
Stop, closed turns, changed evidence, removed rules or exhausted budgets suppress the
hint. There is no strict final-delivery blocker and no automatic final-turn restart.
The Brain path also supports this bounded continuation without duplicating rule recall.

Portable templates use the SDK's explicit local operator interface. Only registered
method IDs transfer; target scope, validation and reputation never come from the
source host. Each target needs its own relevant evidence and local evaluation.

## Data

Each Harness home owns an independent local directory:

```text
$DSH_HOME/missher-evolution/
```

It contains schema-validated state, a bounded closed-event audit, a short-lived
cross-process lock, and validated backups. Durable data never contains raw user
messages, assistant responses, thinking, tool arguments, tool results, absolute
paths, URLs, email addresses, credentials, or provider/model route names.
Project identity is represented only by a SHA-256 scope hash; controlled semantic
identifiers drive recall and duplicate consolidation.

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

- The baseline is DeepSeek Harness Desktop `>=0.3.8`; `missherBrain` is optional.
  Compatibility is established by actual tests, not version comparison alone. Its packaged dsh
  interfaces remain within the declared `>=0.1.0-rc.5 <0.2.0` peer range.
- Only direct foreground user turns are learned; subagents, internal work,
  plugin messages, scheduled work, and tool continuations are filtered.
- The plugin recognizes closed preference and experience allowlists and does not copy
  arbitrary correction text into durable rules.
- It improves future instructions and workflow reuse; it does not fine-tune or
  replace the underlying DeepSeek model.
- It does not import or synchronize state from another agent host.
- No process continues after Harness exits.
- Native smoke uses the real profile CLI plus controlled adapter events. It is not a measurement
  of autonomous model task improvement or a claim that every future host API is compatible.

## Development

```text
pnpm test
pnpm exec tsc -p tsconfig.json --noEmit
pnpm exec tsc -p tsconfig.client.json --noEmit
```

## Official distribution

Source remains MIT. Existing [official distribution policy](OFFICIAL_DISTRIBUTION.md)
and [trademark policy](TRADEMARKS.md) continue to apply. Public availability does
not grant third parties permission to present mirrors as Missher-endorsed releases.
The public source export contains the Harness adapter and its bundled MIT TypeScript
core, with provenance in [SOURCE_PROVENANCE.json](SOURCE_PROVENANCE.json). It does
not contain other host adapters or any live learning state.
