# MSE Harness 0.7.0 marketplace handover

The user authorized public marketplace distribution of their selected MSE 0.7.0.
The unified MSE task approved the boundary: one source/product version, with this
public repository serving only the Harness source export and unchanged archive.

- Unified source: `48ddd5f4e0fd7fd9901724c088958c7849ac3a54`.
- Public source/tag: `97058d6e97bc46026d2f38694a39d1ce7fc5dc34`.
- Public Release and marketplace PR, package hash and tests: see MARKETPLACE.md.
- Source changes: root src now matches unified harness-plugin/src (only relative
  core imports adapted), agent-product/src contains bundled MIT core, package/build
  scripts and tests match 0.7.0. Independent path/CI/golden-fixture changes are
  recorded in SOURCE_PROVENANCE.json. README and AGENT_INTEGRATION describe current
  installation and API limits. Distribution and trademark policies are retained.
- 238 tests, both TypeScript checks and four OS package CI jobs passed. An isolated
  actual Desktop CLI smoke passed installation, controlled lifecycle, persistence,
  restart, checks and uninstall. No real-model efficacy or full Desktop UI claim.
- Public archive is 228410 bytes and identical to unified MSE 0.7.0. Never replace
  it with a source rebuild under the same version/name.
- The unpublished 0.1.2 branch remains historical. It is not a parallel product,
  and its per-rule approval schema must not be mixed with unified 0.7.0 state.
- Live web installation last inspected at 0.6.0: the selected 0.7.0 manager upgrade
  was blocked by host_busy. Publishing a Release does not upgrade the running app.

Remaining external step: upstream must review/merge PR #4672 and rebuild the
catalog before the DSH Market search can find the entry. Do not change Desktop or
its local cache to pretend it is listed. If upstream requests runtime changes,
coordinate with the unified MSE source owner and choose a new patch release.

Update after submission: Submission gate succeeded, but the upstream site-build
check failed on missing added-dates for three unrelated wwweljf entries from #2662.
See MARKETPLACE.md and the diagnostic comment on PR #4672. The plugin/release is
unchanged; upstream must fix that shared build failure before normal review/merge.
