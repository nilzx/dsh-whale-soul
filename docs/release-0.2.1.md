# 0.2.1 automatic memory repair

[中文](release-0.2.1.zh-CN.md)

Status: preparation; not yet published. npm latest remains 0.2.0.

One focused Electron test with a synthetically damaged memory record passed. After an initial authentication failure, automatic retry completed repair. Original text and record, revision and identity references were preserved, and current-format validation passed. Broader corruption patterns and long-term behavior remain separate validation scopes.

Memory data problems are handled by an independent repair Agent. This covers existing-data corruption as well as upgrades: the repair target is the current memory specification, rather than a separate migration plan for each version.

- Healthy memory loads normally. When startup or a memory operation detects a data error, the host preserves the source and starts a repair job using the configured model.
- The repair Agent can inspect memory files and backups, read the current data specification, submit a normalized snapshot and receive validation errors. It cannot modify plugin files or execute shell commands.
- The host rebuilds indexes, integrity metadata and references. Records, revisions, sources, identities, personality growth, maturity and removal state are preserved where recoverable.
- Invalid results are returned to the Agent for correction. Temporary provider failures or unfinished work resume automatically; users are not asked to edit files or run migration commands.
- Only a validated result replaces the active directory. The original data remains in a rollback backup; completed-job temporary files and obsolete active-layout files are cleaned up. Restarting a job does not create another backup.
- Original fragments that cannot be recovered are preserved separately. Missing facts are never invented. Repair reports, retry state and diagnostics stay outside memory prose.

A fast local converter remains available for ordinary V1 data and does not need a model call. Other old layouts and damaged data use the same current-spec repair entrance. The [local management tools](management.md) remain optional owner controls, rather than a required step in normal upgrades.
