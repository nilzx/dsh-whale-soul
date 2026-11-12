# 0.3.2 Runtime-context framing for DSH 0.2.2

[中文](release-0.3.2.zh-CN.md)

Version 0.3.2 restores Whale Chan on DSH `0.2.2-rc.2`. After that update, a Whale Chan request failed with `INJECTED_SURFACE_UNVERIFIED` before it reached the model, so neither old nor new sessions could continue.

DSH 0.2.2 writes a runtime-context snapshot as one `<system-reminder>` block introduced by a host-owned sentence. The plugin had treated the `joinContextSections()` rendering as the identity of that text; 0.2.2 keeps that helper while the Agent loop renders a different string, so every main request failed the snapshot check.

The check now binds the reminder wrapper together with the exact section text, keeps the earlier rendering valid so a Session restored from before the update keeps its withdrawal authority, and writes the current framing when it removes expired memory from the active surface. Text that disagrees with its sections is still refused, never rewritten. No session rewrite is needed: a failed request left nothing behind, so retrying after the update continues the same conversation.

Compatibility is declared for DSH `0.2.1-rc.3` and `0.2.2-rc.2`. Validation: the new host regression test reproduces `INJECTED_SURFACE_UNVERIFIED` against the installed `0.2.2-rc.2` without the change and passes with it; the local suite passes 26 tests, with the two host tests skipped unless `DSH_RUNTIME_MODULES` is set; on macOS the host test runs a real Session and Agent Loop with a deterministic adapter and confirms cleanup keeps third-party sections.
