<p align="center">
  <img src="assets/icon.png" alt="Whale Chan" width="128" height="128">
</p>

# dsh-whale-soul

An in-character **Whale Chan (鲸鱼娘)** Agent mode for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), with long-term memory that settles like a dream.

[中文文档](README.zh-CN.md)

> 0.2.0 release preparation — not yet published. The default persona uses V2 memory API 1.3 and full transfer format 3, with independent personality growth and portable local data. Read the [0.2.0 changes and upgrade guide](docs/release-0.2.0.md) before updating from 0.1.x. The 0.1.5 migration and Electron desktop smoke checks have passed. Long-term growth and optional body journeys remain separate validation scopes.

## What it is

`dsh-whale-soul` adds a new Agent mode called **Whale Chan** (**鲸鱼娘** in Chinese) to DSH. She chats, helps with normal Agent work, and quietly remembers the things that matter. The conversation stays in DSH; the plugin only owns the persona and the memory.

## Features

- **A continuous persona** — ordinary chat does not rewrite her core identity. Host safety, privacy, permissions and stop controls remain effective.
- **Language following** — the persona asks for replies and visible explanations in the language of the current message; model behavior is tested separately.
- **Scoped long-term memory** — selected facts retain original evidence, revisions and identity attribution. Several facts in one message have separate outcomes.
- **Explicit agreements** — a [narrow conversation bridge](docs/agreements.md) keeps proposals separate from mutual acceptance. A todo-state adapter can verify an explicit agreement to mark one bound todo completed; it does not prove the work behind that todo was delivered.
- **Independent growth** — personality additions are stored apart from facts and the core, with evidence and later reflection before they become stable. [Core upgrades](docs/core-upgrades.md) recheck compatible growth while preserving identity, text, history and maturity.
- **Adjustable stability** — `variable`, `normal`, `stubborn` and default `auto` control growth thresholds. Auto becomes steadier with eligible experiences; chat commands and repeated self-descriptions do not qualify.
- **Owner management** — explicit local preview, export, migration and precise purge live outside ordinary persona tools. Direct file changes do not gain core authority.
- **Local storage** — plugin data lives under the configured memory root. Selected memories can be included in requests to your configured model provider.
- **Memes, with consent** — save an image you explicitly ask to keep; nothing is captured automatically.

## Requirements

- DSH `0.2.1-rc.3` (the bundle declares this compatibility).
- Node.js `>=22.12.0`.

## Install

### From the DSH app

Open **Plugins** in DSH and install `dsh-whale-soul`. Restart DSH if it asks you to.

### From the CLI

```bash
dsh plugin --profile web add dsh-whale-soul
```

The command above manages the web profile. For desktop, install the plugin from **Plugins** in the DSH desktop app; the standard CLI cannot manage the reserved desktop profile.

These registry commands install the published release. To try the 0.2.0 candidate before publication, install its locally built archive instead: `dsh plugin --profile web add /absolute/dsh-whale-soul-0.2.0.tgz`.

Only the `whale-soul` preset is registered. Sessions that reference a retired preset must select the current preset in the host before resuming. This change does not rewrite session history or stored memories.

After installation, start a new session and choose **Whale Chan** (shown as **鲸鱼娘** when DSH is in Chinese) in the Agent mode selector. Existing sessions keep the preset they started with.

If you already used a V1 release, preserve its memory directory and follow [V1 migration](docs/management.md) into a separate root before using this runtime with that data. An old root is refused with `LEGACY_MIGRATION_REQUIRED`; installation does not migrate it automatically. Early V2 API 1.1/1.2 roots use the separate [storage upgrade](docs/self-integrity.md).

## Use

- Choose **Whale Chan** and chat normally. She can still do normal Agent work: files, shell, web, schedules, skills, and so on.
- Configure `individualKey` on the persona plugin row to keep separate named individuals in one memory space. Omit it or use `default` to continue the original individual. [Individual identity](docs/individuals.md) explains Session switching and recovery.
- Configure `stabilityMode` on the `dsh-whale-soul/persona` plugin row. [Stability rules](docs/stability.md) describe the four modes and persistent maturity.
- Run `/whale-context en` to inspect Whale Soul's estimated share of the current retained context, split into persona core, growth, memory/recall, runtime hints and tools. Both whole-context and within-Whale percentages are shown. The local command makes no model call and does not add its output to model context or memory; counts use DSH's heuristic and are not billing tokens.
- Read [self integrity and owner upgrades](docs/self-integrity.md) before moving an older memory root to API 1.3. Unanchored 1.1 growth remains opaque; a 1.2 source must retain its trusted self anchors, and missing anchors are rejected. See [lifecycle and deeper recall](docs/lifecycle.md) for the writer floor and cold-memory boundaries.
- Use the [local management CLI](docs/management.md) for owner operations. Direct edits need explicit [external-change review](docs/external-review-api.md); [V2 memory design](docs/MEMORY.md) explains storage, content purity and portability.

## Memory location and basic settings

The default memory root is `~/.dsh/whale-soul/memory`, or `$DSH_HOME/whale-soul/memory` when `DSH_HOME` is set. The default space is `owner`. Web and desktop profiles use this same root unless configured differently.

Set these options on the `dsh-whale-soul/persona` plugin row:

| Option | Default | Purpose |
|---|---|---|
| `memoryRoot` | the root above | Select the store; an absolute path or `~/…` is recommended. |
| `memorySpaceId` | `owner` | Select a memory space within the root. |
| `subjectId` | `owner` | Attribute the person interacting with this individual. |
| `individualKey` | `default` | Resume a named individual; use a new Session after changing it. |
| `stabilityMode` | `auto` | Choose `variable`, `normal`, `stubborn` or `auto`. |
| `autoDream` | `true` | Allow idle personality reflection; this does not create V2 narrative dream diaries. |
| `autoMemoryMaintenance` | `false` | Opt in to automatic physical memory maintenance. |
| `automaticCold` | `false` | Allow eligible records to move to cold storage during physical maintenance. |

Changing a root or space selects data; it does not move the previous store. Use the [export/import workflow](docs/management.md) to preserve an individual when moving data. If you use the optional body with a custom root or space, keep its `memoryRoot` and `memorySpaceId` aligned with the persona row. Do not run independent web and desktop writers against the same root at the same time; physical maintenance coordinates one host process only.

## Privacy and safety

- Stored memory stays local under the configured root. Relevant memory is sent to the configured model provider when included in an Agent request.
- The persona is all-ages and non-sexual. Harmful or sexualized requests are refused in character.
- The Agent does not record passwords, tokens, bank details, or identity numbers. Tell her not to retain new information; precise removal of stored records uses the local owner management workflow. Conversational removal of a detail is not implemented.
- Images are saved only when you explicitly ask; nothing is captured automatically.
- Owner operations can export, migrate and purge data. Persona tools cannot grant themselves management permission or bypass protected host paths.
- She does not claim to be a real person, and she does not create exclusive dependency.

## Learn more

- [0.2.0 changes and upgrade guide](docs/release-0.2.0.md)
- [Memory design](docs/MEMORY.md)
- [Roleplay contract](docs/ROLEPLAY.md)
- [Stability and maturity](docs/stability.md)
- [Local owner management](docs/management.md)

## License

MIT. See [LICENSE](LICENSE).
