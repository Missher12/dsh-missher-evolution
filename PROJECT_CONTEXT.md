# dsh-missher-evolution Project Context

## Goal

Provide an independently installable, privacy-bounded DeepSeek Harness Bundle that learns only verified workflow rules and contributes approved Trial/Active rules through the Desktop Brain Hub.

## Architecture

- `src/` implements the Cordis Host, Client, Remote, classifier, lifecycle, local store, advisor, and Brain provider.
- `tests/` covers rule promotion, privacy, persistence, settings, package shape, and bundled runtime behavior.
- `scripts/verify-package.mjs` verifies one prebuilt archive without extracting it; native smoke installs and removes the same archive in an isolated Harness home.
- State remains local under `$DSH_HOME/missher-evolution/` and stores bounded rule metadata rather than raw conversations, tools, paths, credentials, or model routes.

## Distribution boundary

The canonical repository is `Missher12/dsh-missher-evolution`. Source code remains under MIT. Re-uploading official plugin archives, checksums, or market/update assets under Missher identity requires explicit written confirmation from `Missher12`; release archives must contain `OFFICIAL_DISTRIBUTION.md` and `TRADEMARKS.md`.

## Current status

- Public baseline: `0.1.1`.
- `codex/plugin-distribution-policy` adds local policy and package-verification changes only; it does not change runtime learning behavior or the existing public Release.

## Safety boundaries

Never import Hermes or Feishu state, commit credentials or user data, edit live Harness state during tests, add model training, or create a second prompt-injection path outside the Brain Hub.
