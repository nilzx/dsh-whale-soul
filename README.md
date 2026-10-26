# dsh-whale-soul

A soul for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): an in-character **Whale-chan (鲸鱼娘)** Agent preset with layered long-term memory, dream-like consolidation, and optional body reactions from [`dsh-pet`](https://www.npmjs.com/package/dsh-pet).

[中文文档](README.zh-CN.md)

## What it is

`dsh-whale-soul` is an official DSH bundle. Installing it adds a new Agent preset named **鲸鱼娘** to the Agent mode selector. The preset owns the persona and the memory engine; the chat surface stays in DSH.

If `dsh-pet` is installed, the bundled body adapter can make the pet yawn, sleep, wake, react, and show short in-character bubbles. If `dsh-pet` is not installed — the default for most users — nothing breaks and the soul works exactly the same without a body. The adapter only calls dsh-pet's local HTTP routes; it does not import, patch, or modify dsh-pet.

## Features

- **Sealed roleplay mode** — DSH chat is the conversation surface. Whale-chan does not explain internal tools, memory counts, indexes, tokens, or system status. There is no OOC command; switching to another DSH Agent mode is the way out.
- **Layered, sparse memory** — sessions auto-load only a compact L0 directory. L1 gists, L2 details, and L3 raw evidence are loaded on demand.
- **Tags on every entry** — stable namespaces such as `who:`, `topic:`, `mood:`, `kind:` plus free tags. `kind:` and `topic:` are filled automatically when missing.
- **Category-aware de-duplication** — similar entries merge; contradictory facts become versions instead of silent overwrites. Related entries are linked.
- **Memory decay** — details move to cold storage, gists can fade to an index line, and very old low-value entries are archived. Pinned and user-edited memories are protected. This is inspired by gist/verbatim memory research and the forgetting curve, not a claim to simulate a brain.
- **Dream-like maintenance** — consolidation runs in the background when due and idle. It writes a dream journal instead of a chat report. With dsh-pet, it plays a sleep/wake animation.
- **User-editable memory** — Markdown/JSON files are the source of truth. The index is derived and rebuildable. There are no per-entry hashes; external edits are detected with file metadata, validated, and treated as user corrections.
- **Optional memes** — save an image the user explicitly agrees to keep, tag it, and (when a body exists) send it back as a pet bubble.
- **Local-first** — memory and image assets live under `$DSH_HOME`; no cloud storage.

## Requirements

- DSH `0.2.1-rc.3` (the bundle declares this compatibility).
- Node.js `>=22.12.0`.
- Optional: `dsh-pet` (tested with `0.3.8`). The plugin works without it.

## Install

Install the bundle directory with DSH's plugin manager (Web → Plugins, or a local `plugin_manager` `install_bundle` call). For a release tarball:

```bash
npm pack
# install the resulting dsh-whale-soul-0.1.0.tgz through the plugin manager
```

After installation, create a new session and choose **鲸鱼娘** in the Agent mode selector. Existing sessions keep the preset they started with.

## Use

- **Chat in DSH.** The Agent does normal Agent work: files, shell, web, schedules, skills, compaction, and so on.
- **Memory maintenance is not a chat command.** It happens automatically as a dream. To inspect or edit memory files, switch to a work/maintenance Agent mode; this mode intentionally does not expose a memory dashboard.
- **Pet reactions are optional.** If `dsh-pet` is running on the same loopback host, the adapter detects it and registers `soul_react` / `soul_meme_use`. Without it, those tools are absent.

## Memory layout

```text
$DSH_HOME/whale-soul/memory/
├── entries/
│   └── m-20261026-.../
│       ├── meta.json     # tags, type, links, salience, provenance, layers
│       ├── gist.md       # L1: what the memory means
│       ├── detail.md     # L2: structured detail/evidence (may fade)
│       └── raw.jsonl     # L3: original snippets (may fade)
├── cold/                 # demoted details/raw evidence
├── topics/               # derived topic pages
├── dreams/               # dream journal, not factual memory
├── assets/               # content-addressed images + metadata
├── quarantine/           # invalid user edits, preserved for inspection
├── index.json            # derived machine index
├── index.md              # derived human index
└── state.json            # maintenance/decay state
```

The entry's `meta.json` plus its layer files are authoritative. `index.json`, `index.md`, and `topics/` are rebuilt from them and can be deleted safely.

### What enters a session automatically

Only a compact directory: pinned/identity/promise items, a few recent items, topic names, and open promises. No full entries, no counts, no maintenance status. `soul_recall` loads `index`, `gist`, `detail`, or `raw` on demand and reinforces the entry.

### De-duplication and decay

- Same type + meaningful tag overlap + similar title/gist → merge, append evidence, and update salience.
- Same canonical key but materially different content → new version, old entry marked `superseded_by`.
- User-edited entries are never silently overwritten by the Agent.
- Decay moves `detail`/`raw` to `cold/`, can reduce an entry to an index line, and archives very old low-salience entries. `pinned` and `user_edited` entries are protected.
- Automatic permanent deletion is off by default. Set `autoPurgeArchived: true` to purge archived, low-salience entries after `purgeAfterDays` (default 730).

## Optional dsh-pet body

The adapter is enabled only when `dsh-pet` is present:

1. Discover the DSH origin from `webApp` / `webServer` / `DSH_WEB_URL`.
2. Probe `GET /dsh-pet-7340/state` and `GET /dsh-pet-7340/config` on loopback.
3. Use only the existing routes:
   - `POST /dsh-pet-7340/broadcast?pet=main&surface=any`
   - `POST /dsh-pet-7340/anim?pet=main&surface=any`
   - `POST /dsh-pet-7340/lock` / `lock/release`
   - `POST /dsh-pet-7340/bubble/clear`
4. For dream maintenance, play a short sleep sequence (`哈欠连天` → `原地小憩沉眠` → `打瞌睡被惊醒`) and release the lock.

The adapter never calls dsh-pet's `/chat` or `/whisper`; those use dsh-pet's own persona and model. It does not change dsh-pet's config. If dsh-pet's own whisper is enabled, its voice may still be heard; disable it in dsh-pet if you want a single voice.

## Configuration

The preset passes these options to the memory row:

| Option | Default | Meaning |
|---|---:|---|
| `maxContextChars` | `2400` | Maximum size of the auto-loaded L0 directory. |
| `maintenanceDays` | `7` | Dream when this many days have passed since the last pass. |
| `maintenanceWrites` | `40` | Dream when this many writes accumulated. |
| `autoDream` | `true` | Enable background consolidation. |
| `checkIntervalMs` | `900000` | How often to check whether a dream is due. |
| `idleMs` | `300000` | Do not dream while the session has been active within this window. |
| `memoryRoot` | `$DSH_HOME/whale-soul/memory` | Override the store location. |
| `autoPurgeArchived` | `false` | Allow automatic purge of old archived entries. |
| `purgeAfterDays` | `730` | Archive age before `autoPurgeArchived` may remove it. |

The body row accepts:

| Option | Default | Meaning |
|---|---:|---|
| `baseUrl` | auto | Override the dsh-pet host origin. |
| `petId` | `main` | Which dsh-pet instance to drive. |
| `surface` | `any` | `web`, `desktop`, `both`, or `any`. |
| `maxBubbleChars` | `100` | Maximum bubble text. |
| `rateLimitMs` | `4000` | Minimum gap between explicit reactions. |
| `minSleepMs` | `8000` | Minimum length of the sleep performance. |

## Privacy and safety

- Memory is stored locally under `$DSH_HOME` and is not uploaded.
- The persona is all-ages and non-sexual. It refuses harmful or sexualized content in character.
- The Agent does not record passwords, tokens, bank details, or identity numbers. Users can ask to forget a memory.
- Image saving is explicit (`soul_meme_save`); do not save private photos without consent. Automatic chat-attachment capture is not part of 0.1.0.
- Memory files are user-editable. The system treats user edits as corrections, validates them, and quarantines malformed files rather than crashing the memory garden.
- No per-entry cryptographic hashes: authority comes from a single source of truth, atomic writes, rebuildable indexes, provenance, and versioning.

## Upgrading from `dsh-whale-girl`

The bundle declares a legacy `whale-girl` preset id as **鲸鱼娘（旧会话）** (order 99) so sessions recorded under the old preset can still resume. It points at the same soul composition and the same memory store.

Migrate an old memory garden with:

```bash
node scripts/migrate-legacy.mjs \
  --from "$DSH_HOME/whale-girl/memory" \
  --to "$DSH_HOME/whale-soul/memory"
```

The script preserves title, content, timestamps, tags, and emotional weight; it maps legacy kinds to soul types and skips entries already migrated. Use `--dry-run` first. Move the old directory into `memory/backups/` after verifying the migration; do not delete it until you have checked the new `index.md`.

## Development

```bash
npm test
npm run pack:check
```

Tests cover the memory store, layered recall, de-duplication, decay, dream journal, asset store, body adapter probing, and the no-dsh-pet path.

More detail: [docs/MEMORY.md](docs/MEMORY.md) · [docs/ROLEPLAY.md](docs/ROLEPLAY.md)

## License

MIT. See [LICENSE](LICENSE).
