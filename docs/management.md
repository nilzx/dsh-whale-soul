# Local owner management

[中文](management.zh-CN.md)

Run `node /absolute/plugin/src/manage.js help`. Every data command requires an explicit absolute `--root` and a `--space`; the CLI never chooses the real default memory directory. It is a standalone owner process, not an Agent tool or a way for a model to obtain management permissions.

Replace `/absolute/plugin` in the examples with the installed or unpacked package directory containing `package.json` and `src/manage.js`. This does not require a global npm installation. Use the persona's actual `memoryRoot` and `memorySpaceId`; their defaults are `~/.dsh/whale-soul/memory` (or `$DSH_HOME/whale-soul/memory`) and `owner`. Expand the root to an absolute path for these commands.

The CLI trusts a local process that can access this root outside the persona's isolation as the owner management entry. It cannot distinguish a human from other processes running as the same OS user. It runs with the caller's filesystem permissions: no `sudo`, user switching, core edits, fabricated evidence or arbitrary historical rewrites. `--apply` selects an action; it cannot remove the persona process's kernel boundary. A copied CLI run by a persona tool remains restricted. No management tool is registered in ordinary Whale Chan chat. This boundary does not claim that every standard/third-party Agent or the entire OS is isolated; standard mode's lack of automatic private-memory loading is a separate layer from filesystem access.

## Preview first

Import, migration and purge default to preview. `status` is always read-only; `export --out FILE` directly writes the explicitly selected local file without `--apply`. Both status and export read through a shadow copy so they do not initialize or repair the original store. A preview copies only the selected managed space, the two known administration ledgers, and root `exports`/`backups` into a private temporary directory, then calls the same public APIs there. Copy hashes and the original source snapshot are checked; the temporary copy is removed afterwards. Import, purge and migration destination checks run against this copy.

Stop writers before management. Busy locks, pending recovery journals, unsupported administration registries, symlinks, invalid data, changing snapshots or preview limits produce an error. The CLI does not claim these conditions were repaired. Preview copies are limited to 20,000 files, 128 MiB per file and 256 MiB total. There is no automatic repair or external archive-registration command.

Use `--apply` only on the concrete command you want to execute. Import, migration and purge accept `--operation-id ID` for explicit idempotent retries. If an applying command fails after commit, `writes_applied: null` means completion is unknown; inspect the store before retrying. Errors contain codes, not private exception text.

## Commands

```sh
node /absolute/plugin/src/manage.js status --root /absolute/memory --space owner
node /absolute/plugin/src/manage.js export --root /absolute/memory --space owner --out /absolute/export.json
# Export creates this explicit file. Existing output files are never overwritten.
```

Status reports IDs and counts, without memory bodies. Export writes the explicit file and reports a validated archive summary. `--opaque-policy omit` excludes opaque material, while `--opaque-policy include-reviewed` explicitly includes reviewed opaque material. Neither policy semantically redacts all historical content.

```sh
node /absolute/plugin/src/manage.js import --root /absolute/new-memory --space owner \
  --archive /absolute/export.json --identity-mode preserve --accept-purge-state --accept-persona-state \
  --accept-integrity-state --accept-self-integrity
```

Current full transfer-v3 imports preserve identities. The example explicitly accepts purge, persona, record-integrity and self-integrity states; each flag is required when its corresponding state is present. A legacy transfer-v1 archive additionally requires `--accept-legacy-baseline`; that flag does not replace an old-root upgrade. Maturity rollback remains refused unless an owner additionally supplies `--allow-maturity-reset` and the public API permits the exact reset. Add `--apply` only after reviewing the preview. A new destination root is not created by preview.

```sh
node /absolute/plugin/src/manage.js migrate-v1 --root /absolute/v2-memory --space owner \
  --source /absolute/stopped-v1-memory --source-quiescent \
  --subject owner --persona whale-chan --agent-identity agent-from-status --opaque-policy preserve-local
```

Stop v1 maintenance/watchers first. `--source-quiescent` is the owner's declaration; the API also checks the source snapshot again before import. Preview returns `source_snapshot`. Apply the same command with `--snapshot HASH --apply`; missing or changed snapshots are refused. Identity arguments assign unattributed legacy records; existing attribution is preserved by the migration API. Legacy records never become invented user quotes or automatic growth evidence. Use `--opaque-policy omit` instead to omit opaque files.

The V2 runtime refuses an unmanifested legacy root with `LEGACY_MIGRATION_REQUIRED`; it does not create an empty replacement space there. Select a separate empty destination. If unattributed legacy records should belong to a particular continuing persona, first initialize that persona in the new destination, stop its writer, and obtain its real identity from `status`; then use that identity in the migration command. Supplying an arbitrary identity does not connect data to the persona anchor. Existing legacy attribution is preserved rather than reassigned by these flags.

A directory containing both legacy markers and a V2 root manifest is refused as `MIXED_MEMORY_ROOT`. Preserve it and stop all writers. Do not delete its manifest or point `migrate-v1` directly at the mixed directory; automatic extraction and mixed-root recovery are not provided by this CLI.

## Upgrade an early V2 root

Use a separate destination for an API 1.1/1.2 root:

```sh
node /absolute/plugin/src/manage.js upgrade-self --root /absolute/new-memory --space owner \
  --source /absolute/stopped-old-v2-memory --source-quiescent \
  --legacy-self-policy preserve-opaque
```

Review the preview, then add `--snapshot HASH --apply` to the same command. Trusted 1.2 growth retains its anchors; unanchored 1.1 growth is preserved only as historical material. API 1.0 first needs the [record-baseline API](external-review-api.md), then this step; the CLI does not yet chain baseline establishment automatically. See [self integrity and upgrades](self-integrity.md).

```sh
node /absolute/plugin/src/manage.js purge --root /absolute/memory --space owner \
  --record RECORD_ID@EXPECTED_REVISION
```

Repeat `--record` for additional exact targets. Preview reports the precise scope; apply uses the same expected revisions. There is no whole-space wildcard. If legacy narratives make the public API require a broader scope, review and explicitly add `--include-legacy-narratives`. Unrelated records remain intact.

For an approved item that has never entered a current or historical record, use a separate scope:

```sh
node /absolute/plugin/src/manage.js purge --root /absolute/memory --space owner --pending-item ITEM_EVIDENCE_ID
```

This scope is mutually exclusive with `--record` and `--include-legacy-narratives`. It has the same shadow preview and explicit `--apply` behavior. The backend checks the item binding and every current/historical record reference; `ITEM_HAS_RECORDS` refuses without falling back to record deletion. Purging such an item removes its payload and managed copies while preserving the event's content-free qualification and sibling items. Status shows only item IDs and durable outcomes; `approved_unverified` does not mean pending, because a record may already exist. The backend must establish that absence before clearing it.

Root `exports` and `backups` are managed copies and participate in purge. Copies exported elsewhere are unmanaged and cannot be deleted by this CLI. A stale archive cannot override the target root's purge ledger; a fresh machine must first receive the current purge-bearing archive/state. No global claim is made about external copies or an empty destination with no purge history. Export files may be placed outside the root or under root `exports`/`backups`, never inside live record/ledger directories.

Exit status is `0` for success/preview, `1` for a refusal/error, and `2` when opaque content needs an explicit policy. Preview `status: committed` describes the simulated API result; `mode: preview` and `writes_applied: false` mean no changes were applied to the original root. Export separately reports `file_written`: when the explicit output is inside root `exports`/`backups`, that managed copy is intentionally added and `source_unchanged` is false, while live memory data remains untouched.
