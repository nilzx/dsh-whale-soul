# Memory design

Whale-chan's memory is a file-backed, layered memory garden. It is designed to be **inspectable, editable, and rebuildable**, not to be an immutable database.

## Source of truth

- `entries/<id>/meta.json` and the layer files are the source of truth.
- `index.json`, `index.md`, and `topics/` are derived; delete them and the next scan rebuilds them.
- There are no per-entry hashes. Legitimate user edits would invalidate hashes and add key-management ceremony without preventing the real risks: stale indexes, partial writes, and silent model overwrites.
- Authority comes from one writer for the Agent, atomic writes, schema validation, provenance, versioning, and a rebuildable index.

## Layers

| Layer | File | Loaded when | Purpose |
|---|---|---|---|
| L0 | index / L0 context | every session | title, tags, type, salience, one-line gist |
| L1 | `gist.md` | retrieval / `soul_recall` | what the memory means |
| L2 | `detail.md` | explicit `depth=detail` | structured detail, context, quotes |
| L3 | `raw.jsonl` | explicit `depth=raw` | original snippets, cold evidence |

The split is inspired by fuzzy-trace theory: the gist outlives the verbatim details. It is an engineering analogy, not a claim to simulate a brain.

## Entry schema

Each `meta.json` includes:

- `id`, `schema_version`, `type`, `title`, `summary`
- `tags`, `entities`, `links`
- `emotional_weight`, `salience` (emotional/identity/recurrence/novelty/unresolved)
- `confidence`, `source`, `user_edited`, `pinned`
- `created_at`, `updated_at`, `last_access`, `access_count`
- `valid_from`, `valid_to`, `supersedes`, `superseded_by`
- `layers`, `assets`, `canonical_key`
- `status` and optional `archived_at`

Tags are namespaced (`who:master`, `topic:food/rice`, `mood:warm`, `kind:preference`). A missing `kind:` or `topic:` is filled automatically.

## Writes and de-duplication

`soul_remember` builds a candidate and looks for a matching active entry:

1. same canonical key, or
2. same type + meaningful tag overlap + similar title/gist.

If the match is safe, the candidate merges: tags are unioned, evidence is appended to `detail`/`raw`, salience is recomputed, and links are kept. If the canonical key matches but the content is materially different, a new version is created and the old entry is marked `superseded_by`. A user-edited entry is never silently overwritten; the new candidate is stored as a related entry.

This is intentionally conservative. Uncertain matches should become links or separate entries, not silent merges.

## Decay and dreams

`retrievability` uses a type-specific half-life and is reinforced by access count and salience. The actual pass runs only when maintenance is due and the session has been idle:

- `detail` moves to `cold/` first.
- `raw` moves to `cold/` next.
- A gist can be compressed to an index line.
- Very old low-salience entries are archived.
- `pinned` and `user_edited` entries are protected.
- Permanent deletion is opt-in (`autoPurgeArchived`).

The pass writes `dreams/YYYY-MM-DD.md` and emits internal dream events for the optional body adapter. It never writes a chat status report.

## User edits

- The user may edit any entry file.
- On load, files are scanned; `mtime` and parsing are enough to detect external edits.
- Valid edits are treated as `source: user`, marked `user_edited`, and indexed.
- Invalid entries are moved to `quarantine/` and preserved.
- The Agent must not silently overwrite a user-edited entry. Correcting a fact should create a version or a related entry.

## Assets

Images live in `assets/` under their SHA-256 content hash, with a JSON sidecar describing tags, source, description, and usage. `soul_meme_save` is explicit: `recent_image: true` reads the latest image attachment of the current session through `ctx.attachments`; a local path or URL is also accepted. The body adapter can serve an asset through the local `/whale-soul-assets/` route and pass its URL to dsh-pet's `broadcast` route. Nothing is captured automatically.

## Migrating a legacy store

`scripts/migrate-legacy.mjs` maps `dsh-whale-girl` blocks into this schema. It preserves content, timestamps, tags, and emotional weight, maps legacy kinds (`player` → `identity`, `moment` → `episode`, and so on), and skips duplicate canonical keys. Keep the old directory in `backups/` until the new `index.md` has been verified.

## Privacy

Local only. No cloud upload. Sensitive credentials are excluded by persona policy. Images should be saved only with the user's consent.
