# 0.2.2 linked memory directories

[中文](release-0.2.2.zh-CN.md)

Release: `0.2.2`.

This patch fixes a startup hang in 0.2.1 when the configured memory root is a symbolic link to a directory. Old memory could enter a repair loop while the conversation waited for memory to become ready.

The plugin now resolves the physical target before migration or repair. The configured link stays in place, and migration, repair staging, locks and backups use the target directory. Different root paths that resolve to the same directory share one repair job within the host process.

Update the plugin in DSH and restart if prompted, then open a new Whale Chan session. An existing link to a valid memory directory can remain as configured. Ordinary V1 memory converts automatically; other detected data errors use the existing [current-spec repair Agent](release-0.2.1.md). No manual memory edit is required for this fix.

Validation covered linked V1 conversion, linked damaged-data repair, the minimum Node.js 22.12 runtime and DSH rc.3 integration. In an actual Electron desktop check, the original link was retained, all 14 source files matched the rollback backup, the existing record's summary and detail were unchanged, and a new conversation completed successfully. These checks cover this linked-root fix; they do not guarantee lossless recovery of every form of damaged data.
