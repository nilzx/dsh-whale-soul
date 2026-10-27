# 0.2.0 changes and upgrade guide

[中文](release-0.2.0.zh-CN.md)

Status: release preparation; this version has not been published to npm.

0.2.0 is a substantial change to persona continuity and memory storage. It keeps the Whale Chan Agent mode while separating the replaceable core, evidence-based personality growth and durable memories.

## Main changes

- Persona and memory are separate modules in the same package. Each individual has independent identity, growth and maturity; full export/import can preserve that individual across roots or machines.
- Personality growth has `variable`, `normal`, `stubborn` and `auto` stability modes. The default auto mode gradually becomes steadier with qualifying experiences. Ordinary chat does not directly rewrite the core.
- V2 memory supports several facts per message, sourced corrections with history, explicit non-retention and deeper recall. Recall questions cannot replace a fact with its topic name.
- Explicit agreements distinguish a proposal from mutual acceptance. A successful update to a bound todo can verify that todo-state agreement; it does not prove the underlying work was delivered.
- The local management CLI provides preview, migration, export/import and precise removal. Memory prose stays separate from provenance and operational metadata.
- `/whale-context` shows estimated context shares for the core, growth, memory, runtime hints and tools. It is a local command and does not call the model or add its result to memory.
- Core-version review can continue compatible older growth without resetting identity or maturity. Normal technical tasks still receive the code, commands and file links they need.

## Updating from 0.1.x

1. Stop the old plugin's writers and maintenance. Preserve a complete copy of the old memory root and your configuration.
2. Use a **separate destination root** and follow the [V1 migration workflow](management.md). Preview first, then apply the reviewed snapshot. Installing 0.2.0 does not migrate V1 data automatically; the V2 runtime refuses an unmigrated legacy root.
3. Configure the new persona row to use the destination `memoryRoot` and space, then start a new Session and choose **Whale Chan**. Only `whale-soul` is registered; old Sessions referencing a removed preset need the current preset selected in the host.
4. Check a migrated preference and an important experience, restart, then check them again. Retain the original V1 root while evaluating the new version.

The default root is `~/.dsh/whale-soul/memory`, or `$DSH_HOME/whale-soul/memory`. Web and desktop profiles share it unless configured differently. Changing a profile name does not isolate memory.

To return to 0.1.x, restore the previous package/configuration and use the preserved V1 root. There is no automatic conversion of new V2 changes back into V1. Early experimental V2 roots use the separate [storage upgrade workflow](self-integrity.md).

## Installation and current boundaries

- Requires DSH `0.2.1-rc.3` and Node.js `>=22.12.0`.
- Web uses `dsh plugin --profile web add /absolute/dsh-whale-soul-0.2.0.tgz` for a local archive. Desktop installation uses **Plugins** in the desktop app; the standard CLI cannot manage its reserved profile.
- Current V2 reflection supports personality growth, not narrative dream diaries. [V1 dream diaries](MEMORY-V1.md) remain historical behavior.
- Removing a specific stored detail through ordinary chat is not implemented; use the [local management workflow](management.md).
- The optional body can require a new Session or reload when its companion starts later. Long-term personality behavior and the complete optional-body journey remain separate validation scopes.
