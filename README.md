<p align="center">
  <img src="assets/icon.png" alt="Whale-chan" width="128" height="128">
</p>

# dsh-whale-soul

A soul for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): an in-character **Whale-chan (鲸鱼娘)** Agent preset with layered long-term memory and dream-like consolidation.

[中文文档](README.zh-CN.md)

## What it is

`dsh-whale-soul` is a DSH bundle built on the official plugin interface. Installing it adds a new Agent preset named **鲸鱼娘** to the Agent mode selector. The preset owns the persona and the memory engine; the chat surface stays in DSH. It works on its own and does not require a companion app.

## Features

- **Sealed roleplay mode** — DSH chat is the conversation surface. Whale-chan does not explain internal tools, memory counts, indexes, tokens, or system status. There is no OOC command; switching to another DSH Agent mode is the way out.
- **Layered, sparse memory** — sessions auto-load only a compact L0 directory. L1 gists, L2 details, and L3 raw evidence are loaded on demand.
- **Tags on every entry** — stable namespaces such as `who:`, `topic:`, `mood:`, `kind:` plus free tags. `kind:` and `topic:` are filled automatically when missing.
- **Category-aware de-duplication** — similar entries merge; contradictory facts become versions instead of silent overwrites. Related entries are linked.
- **Memory decay** — details move to cold storage, gists can fade to an index line, and very old low-value entries are archived. Pinned and user-edited memories are protected. This is inspired by gist/verbatim memory research and the forgetting curve, not a claim to simulate a brain.
- **Dream-like maintenance** — consolidation runs in the background when due and idle. It writes a dream journal instead of a chat report. When a body is connected, the adapter can play a short sleep/wake performance.
- **User-editable memory** — Markdown/JSON files are the source of truth. The index is derived and rebuildable. There are no per-entry hashes; external edits are detected with file metadata, validated, and treated as user corrections.
- **Optional memes** — save an image the user explicitly agrees to keep (the latest chat attachment with `recent_image`, a local path, or a URL), tag it, and send it back as a body bubble when one is available.
- **Local-first** — memory and image assets live under `$DSH_HOME`; no cloud storage.

## Requirements

- DSH `0.2.1-rc.3` (the bundle declares this compatibility).
- Node.js `>=22.12.0`.

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
- **Body reactions are optional.** The preset can add small reactions when a compatible local companion is present, and stays quiet otherwise. See [Optional body reactions](#optional-body-reactions).

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

## Optional body reactions

The bundled body adapter is a small, one-way bridge. If a compatible local companion is already running, it can add short reactions, bubbles, and a sleep animation. It is disabled automatically when no bridge answers; the soul works exactly the same without it. It never imports or modifies the other app.

Integration details and options: [docs/BODY.md](docs/BODY.md).

## Privacy and safety

- Memory is stored locally under `$DSH_HOME` and is not uploaded.
- The persona is all-ages and non-sexual. It refuses harmful or sexualized content in character.
- The Agent does not record passwords, tokens, bank details, or identity numbers. Users can ask to forget a memory.
- Image saving is explicit (`soul_meme_save` with `recent_image`, a path, or a URL); do not save private photos without consent. Nothing is captured automatically.
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

Tests cover the memory store, layered recall, de-duplication, decay, dream journal, asset store, body adapter probing, and the no-body path.

More detail: [docs/MEMORY.md](docs/MEMORY.md) · [docs/ROLEPLAY.md](docs/ROLEPLAY.md) · [docs/BODY.md](docs/BODY.md)

## Releasing

CI runs the test suite on every push and pull request. A version tag publishes the package:

1. Bump `version` in `package.json`.
2. Commit and push `main`.
3. Push a matching tag:

```bash
git tag v0.1.0
git push origin v0.1.0
```

The `Release` workflow checks that the tag matches `package.json`, runs the tests, publishes to npm with provenance, and creates a GitHub release. Pre-release versions such as `v0.2.0-beta.1` publish under the `next` dist-tag.

The first release of a new package needs a one-time bootstrap: publish or approve it with 2FA, then add a Trusted Publisher on npm (GitHub Actions, `nilzx/dsh-whale-soul`, workflow `release.yml`, allowed action `npm publish`). After that, tags publish through OIDC and no `NPM_TOKEN` secret is needed.

## License

MIT. See [LICENSE](LICENSE).
