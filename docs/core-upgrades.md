# Continuing growth after a core upgrade

[中文](core-upgrades.zh-CN.md)

A new `core.version` does not create a new individual. With the same persona and `individualKey`, identity, factual memories, evidence and maturity remain. Growth from an older core version stays stored but is excluded from normal loading until it has been reviewed against the current core.

## Review behavior

- A compatible, supported stable trait stays `stable`; its exact value, scope and evidence are preserved.
- A compatible candidate stays `candidate`. A core upgrade does not promote it or lower the normal stability thresholds.
- A removed dimension, incompatible value, missing eligible evidence or unresolved counterevidence leaves the old item unchanged and unloaded. The result explains why it was not continued.
- Successful continuation updates the core version and revision, preserving the previous complete item under `history/`. Repeating the same review returns its durable result.

This review creates no new experience and does not increment or reset maturity. It does not rewrite factual memory prose. A different persona or individual does not inherit the previous individual's growth.

## Runtime host entry

The current host can explicitly review an idle Agent:

```js
const result = await runtime.reviewCoreUpgrade(agent, { signal })
```

The runtime uses its current core instructions and existing growth assessor. Results include `completed`, `partial`, `busy`, `cancelled`, `failed` or `no_core_upgrade`, with per-item outcomes where applicable. Normal due maintenance checks pending core reviews before ordinary reflection. A review that already recorded a refusal does not repeatedly block later reflection for the same source revision and target version.

This is a host API, not a chat command, persona-editing tool or new management CLI command. If automatic reflection is disabled, the host can invoke the entry explicitly. After a successful continuation, later context preparation can load compatible stable traits; candidates remain outside stable-personality context.

## Growth service API

A host that already owns a `PersonaGrowth` instance bound to the new core can inspect and review exact items with its current `self.evaluate` context:

```js
const pending = await growth.listCoreUpgrade(context, { pendingOnly: true })
if (pending.status === 'ok') {
  for (const item of pending.items) {
    await growth.rebaseCore({
      kind: item.kind,
      id: item.id,
      expected_revision: item.entry.revision,
      from_core_version: item.from_core_version,
    }, context)
  }
}
```

`kind` is `trait` or `proposal`; the target version comes from the service's trusted current core. `rebased` means continuation committed, `not_rebased` preserves the old item with a reason, and `current` means it already uses this core. The default operation ID is derived from the exact item revision and target version. `listCoreUpgrade` defaults to 20 items; use `truncated` to detect more work. With `pendingOnly: false`, reviewed old items may include `last_review`.

Use a version change for an actual core change and retain the full self bundle when transferring data. This is separate from upgrading an older storage API root; see [self integrity and storage upgrades](self-integrity.md). Focused continuation checks do not establish compatibility with every future core or long-term model behavior.
