# Public distribution and marketplace

Version: MSE Harness 0.7.0. Upstream source commit:
`48ddd5f4e0fd7fd9901724c088958c7849ac3a54`.
The public source is the repository commit associated with tag v0.7.0;
SOURCE_PROVENANCE.json records the limited source export and path adaptations.

Release URL: https://github.com/Missher12/dsh-missher-evolution/releases/tag/v0.7.0
Pinned archive: https://github.com/Missher12/dsh-missher-evolution/releases/download/v0.7.0/dsh-missher-evolution-0.7.0.tgz

Archive size: 228410 bytes. SHA-256:
`339702ea314c20d464fb27511d897f13aac6e2001681275da5ac9b5b9298412a`.
This archive is byte-identical to the unified release; a local source rebuild is
validation output and must not replace the original archive under the same name.
The Agent guide, distribution and trademark policies are separate release assets.

Validation on 2026-09-08: 238 tests in 17 files passed; both TypeScript checks
passed. Actual installed Desktop CLI and Electron installed and removed the
original archive in an isolated DSH_HOME. Controlled lifecycle checks covered
persistence, restart, optional-Brain/native contribution, and fail/pass file checks;
adjacent data and state survived uninstall. No real-model efficacy or Desktop UI
acceptance is claimed. The previous live web upgrade was blocked by host_busy.

Registry submission: one file, data/plugins/Missher12__dsh-missher-evolution.yml,
category workflow, pointing at the pinned public tarball. The submission describes
scoped workflow rules and correction reminders, without claiming per-rule approval
or measured model improvement. Upstream review and catalog rebuild are required
before the plugin appears in DSH Market. Do not modify Desktop or its market cache
to simulate publication. The PR link and current status will be appended after submission.

## Published/submitted on 2026-09-08

- Public source/tag commit: `97058d6e97bc46026d2f38694a39d1ce7fc5dc34`.
- Four-platform package CI passed: https://github.com/Missher12/dsh-missher-evolution/actions/runs/34242121130
- Release v0.7.0 is public; all eight initial assets were anonymously downloaded
  and matched local bytes. The additional anonymous-checks.json records those results.
- Marketplace PR: https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/4672
  Submitted as one YAML entry; awaiting upstream review/merge and catalog rebuild.
- Only the Harness distribution and necessary MIT core source were exported.
  The unified MSE repository's visibility and other host adapters were unchanged.
- The unified MSE task confirmed one source authority, one product version and two
  distribution endpoints with different access. It owns future export automation;
  this public repository must not independently evolve the rule algorithm.

The first public-source CI run failed because type checking preceded generation
of lib declarations. The next commit corrected CI ordering; no runtime changes or
archive replacement were made. The tagged commit is the passing source revision.
