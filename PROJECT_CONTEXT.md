# dsh-missher-evolution Project Context

## Goal and ownership

Independent experience-rule plugin: collect bounded candidates, review, try, activate,
revoke and restore. No model training, source rewriting, memory database, external
messaging or infinite optimization loop. Canonical repository:
`https://github.com/Missher12/dsh-missher-evolution.git`.

## Verified baseline and workspace

- Baseline version 0.1.1, SHA `467a7ae3f5377090b0143e3679db710c67f2499a`.
- Original checkout: `/Users/missher/Documents/ChatGPT/dsh-missher-evolution`,
  branch `codex/plugin-distribution-policy`, initially clean; preserved.
- Maintenance checkout: `/Users/missher/Documents/ChatGPT/dsh-missher-evolution-review`,
  branch `codex/evolution-rule-review-20260906`.
- No repository-local AGENTS.md was found; session instructions apply.
- 0.1.2 is a local maintenance build, not a published release.

## Architecture and data flow

- `src/index.ts`: Cordis lifecycle, local store/Remote/maintenance and separately
  scoped optional Brain Hub provider registration.
- `adapter.ts`, `registry.ts`, `classifier.ts`: direct foreground turn observation;
  only closed categories, hashes and outcomes reach persistent capture.
- `lifecycle.ts`: Candidate -> Trial after three source sessions; explicitly approved
  Trial -> Active after three distinct attributed successful sessions outside the
  source sessions. Outcome counters are heuristics, not proof of efficacy.
- `brain-provider.ts`: sole contribution via Brain Hub v1, acceptance revalidation
  and version-bound attribution. No fallback context injection.
- `store.ts`: strict bounded schema, private atomic files, revision/lock protection,
  backups and explicit restore. State remains `$DSH_HOME/missher-evolution`.
- `remote*.ts`, `typert*.ts`, `client/`: snapshot, enabled, reviewRule, reset, restore;
  UI shows approval, scope, evidence and expiry with revision/version guards.
- `maintenance.ts`, `advisor.ts`: bounded maintenance and candidate text suggestions.
  Rewrites clear approval and Trial evidence; approved text is not rewritten.

## Compatibility

Local capture, settings Remote and maintenance start without missherBrain. A host
with the published standard services/compatible clients can manage local rules;
contribution and therefore attributed Trial evidence require Brain Hub v1.
Missing Brain Hub is explicitly shown by snapshot/UI. Dynamic service registration
and cleanup were tested with actual Cordis and mocked host services. This is not a
full original-Harness UI or Desktop native acceptance claim.

## Validation and progress

See `MAINTENANCE_REPORT.md` for the upgrade checklist, issues, tests and limitations.
104 tests pass across 15 files; Host and Client TypeScript checks pass.
Mac Intel, Node 25.6.0, local Harness CLI 0.1.1-rc.2: archive installed and removed in
an isolated DSH_HOME, with adjacent data and plugin state preserved. The same
installed archive passed simulated six-turn lifecycle/restart/contribution checks.
No real-model efficacy evaluation, Windows native execution or Desktop UI smoke.

## Safety and distribution

Never import Hermes/Feishu state, write the Desktop repository or live profile,
store raw conversations/tools/credentials, or duplicate Memory's storage purpose.
MIT and existing OFFICIAL_DISTRIBUTION.md / TRADEMARKS.md remain unchanged.
No push, tag or Release without an explicit release instruction.

## Known limits and next maintenance

- Profile-wide exact task-category scope; no project isolation promise.
- Fixed categories and preference allowlist; deterministic conflict suppression,
  not semantic conflict detection. Human review remains necessary.
- At 200 identities new families are ignored. Retired/suspended identities do not
  revive automatically; retain backups before a deliberate reset.
- Revocation affects future contributions, not context already delivered.
- Restore clears approvals, preserves enabled choice, and saves current state first.
  Historical 0.1.1 readers do not accept the added optional state fields: use a
  pre-upgrade backup for a binary downgrade, not the new state with old code.
- Maintenance creates retained backups; automatic retention/pruning is not added.
- Native smoke without --cli is explicitly an offline fixture and cannot prove install.
- Reproduce from the lockfile with pnpm install --frozen-lockfile; this run reused
  the original checkout's installed dependencies by a temporary read-only symlink.
