# External record review API (experimental backend)

This branch implements an owner-only backend and opt-in watcher/Web review host adapter for API **1.1.0**, record schema **2**, integrity state schema **1**, and portable transfer format **2**. Nothing is installed into a persona automatically. There is no Agent management tool or growth/core recovery adapter.

The trust boundary is a local owner process outside the persona's restricted tools. It is not human authentication against every process running as the same OS user. Root metadata contains only identifiers and hashes; raw records and quarantined content remain private to the memory root. An owner who rewrites both root anchors and all source copies is outside the guarantee.

## Upgrade safely

Prefer a **new absolute destination root**. Export the old 1.0 library with its original owner tooling, retain source snapshots before and after export/import, and explicitly accept that old archive as a baseline in the new store. `MemoryTransfer.importSpace()` requires `identity_mode:'preserve'`, the existing purge/persona acceptance flags where applicable, and `accept_legacy_baseline:true` for a version-1 archive. A running old process remains confined to its old path. Reopening the new 1.1 root with the old reader is rejected before writing.

In-place baseline establishment is an explicit exception for an owner who has stopped the old writers. `source_quiescent:true` is an **owner declaration**, not proof that another process has stopped. An old process initialized before the upgrade cannot be remotely revoked by new JavaScript. A later old-process write is rejected as an external change by the new anchors; the new backend does not silently trust it.

```js
import { MemoryStoreV2, MemoryExternalChanges } from 'dsh-whale-soul/memory'

const store = new MemoryStoreV2({
  root: '/absolute/synthetic-or-owner-selected/memory',
  memory_space_id: 'owner',
})
const context = store.issueContext({
  agent_identity_id: 'local-owner', persona_id: 'local-owner', subject_id: 'local-owner',
  capabilities: ['memory.manage'],
})
const review = new MemoryExternalChanges({ store })
const preview = await review.establishBaseline({ source_quiescent: true }, context)
// Review the source snapshot and counts. Application never happens by default.
const applied = await review.establishBaseline({
  operation_id: 'owner-baseline-001', source_quiescent: true, dry_run: false,
  expected_snapshot: preview.source_snapshot,
}, context)
// Check the structured result before initializing the upgraded store.
await store.initialize()
```

The in-place helper currently supports a single-space 1.0 root. A multi-space source is explicitly refused; use isolated exports/imports per space. Missing, malformed, unsupported, or unanchored data is not repaired by recomputing its own `integrity.json`. Historical operation receipts are not rewritten.

## Scan, review, resolve

Every method requires the store's actual `memory.manage` context, rechecked before COMMIT. Copies of a context and model-supplied permission flags do not grant access. A third trusted argument `{signal, authorize?}` supports cancellation before COMMIT. The optional synchronous host authorizer may only restrict an already authorized context; it never grants management permission.

- `scan({record_ids?,cursor?,limit?,capture:false}, context)` is an observational scan. `capture:true` preserves an affected record by a recoverable directory detach and marks only that record quarantined. Normal neighbors remain readable. A fresh self-consistent directory without an anchor remains untrusted.
- `list({cursor?,limit?,include_resolved?}, context)` returns safe IDs, reasons, hashes, and status. A forged resolution file cannot hide quarantine.
- `preview({change_id,expected_observed_hash}, context)` returns bounded textual field differences, rejection reasons, verified recovery candidates, and a review digest. It redacts unsafe content and never calls a model.
- `resolve({operation_id,change_id,action,review_digest,expected_change_revision,expected_head_revision_id,expected_observed_hash,...}, context)` performs the exact approved operation. It never rebases a stale review onto a later correction.

For `action:'adopt'`, supply `fields` selected from `title`, `tags`, `gist`, and `detail`. Values are copied from the captured snapshot; arguments cannot inject replacement text. The combined patch including its field wrapper must fit 8000 UTF16 units. Identity, visibility, canonical slot, raw evidence, assets, timestamps, qualification, core, and growth fields cannot be adopted. A new revision uses `claim_kind:'quotation'` and `source:'owner_external_edit'`; it does not invent a user statement, growth evidence, or maturity event.

For `action:'restore'`, supply a `restore_revision_id` offered by preview. An intact anchored head is restored byte-for-byte with its original record/revision identity. If only an earlier anchored revision remains valid, restoration creates a new forward revision and records `restored_from`. No trusted candidate means an explicit refusal, not an invented repair.

The original detached inode remains preserved, including late writes through an already-open file. New publication uses exclusive directory/file creation and only marks the root head clean after complete hash verification. A recreated target directory is preserved and causes a conflict. COMMIT recovery is tested with real process termination; physical power failure is not claimed.

## Transfer and purge

Version-2 archives require `integrity_state` and explicit `accept_integrity_state:true` at import. Removing that field and downgrading the version cannot bypass the separate old-baseline acceptance gate. Divergent existing heads are rejected, even when the imported revision number is higher. Quarantine stays quarantine across roots. Omitted pending payloads are listed and are not advertised as restored.

The local CLI recognizes `--accept-integrity-state` and `--accept-legacy-baseline`, and its shadow snapshot includes the new record heads. External review is not yet exposed as CLI subcommands. Managed purge can target an unreadable quarantined record using the trusted scope/revision anchor, preserves siblings/shared references, and removes its managed forensic copies. Root purge tombstones remain without plaintext.

## Optional host watcher and owner Web review

`MemoryExternalWatcher` uses native recursive `fs.watch` on the configured store's `records` and `quarantine` directories. It immediately schedules bounded managed scans; it does not trust modification times. A native error closes watch handles and exposes `mode:'degraded_polling'`, with bounded polling and a visible reason. A forced unsupported-backend test is marked `simulatedFallback:true` and is not evidence for a second OS. `status()` reports scan counts, incomplete pages, unavailable items, and cleanup completion. `dispose()` aborts new work, closes handles/timers and waits for the active scan. A completed cleanup marker means no later capture is started by this watcher.

Install the owner interface explicitly from a trusted host plugin:

```js
import { MemoryExternalChanges, installExternalReview } from 'dsh-whale-soul/memory'

const external = new MemoryExternalChanges({ store })
const ownerReview = await installExternalReview(hostContext, {
  service: external,
  // Obtain a fresh actual owner context for each operation.
  contextFactory: () => store.issueContext({
    agent_identity_id: 'local-owner', persona_id: 'local-owner', subject_id: 'local-owner',
    capabilities: ['memory.manage'],
  }),
})
// Add ownerReview.route.prefix to the host's owner navigation if desired.
// The host must already provide official webServer and connection services.
```

The interface follows late/replaced official services through Cordis injection. Its route prefix is derived from a fixed canonical root and space; no HTTP/model argument selects a filesystem path. It calls the actual connection admission service and requires a browser-owner cookie through public `authorizeIndex`. An API/operator cookie cannot mint a browser management CSRF lease. Every POST requires the exact official WebServer origin, a page-bound CSRF lease, bounded JSON, and a live peer signal. A preview creates a one-use, expiring nonce bound to the page, peer, observed bytes, root head and exact allowed fields/recovery revisions. Requests never supply replacement values, paths or elevated capabilities. Stale previews must be reviewed again.

The public route methods are GET `/` and `/state`, and POST `/scan`, `/preview`, `/resolve`, below `ownerReview.route.prefix`. Default request bounds are 16 KiB, 10 seconds and 32 simultaneous handlers; configurable bounds remain finite. Disconnect, timeout, unload and service replacement revoke in-flight authorization before COMMIT. Manual `/scan` schedules the independent standing owner monitor; disconnecting that HTTP request does not revoke the host's separately authorized background watcher.

The Chinese page displays before/after values as plain text, its verified restore choices, and selected adoption fields. It uses a nonce CSP, no inline event attributes or untrusted HTML insertion. The page explicitly states that it covers **records only** and that persona automatic loading of owner-edited quotation evidence is not integrated. Routes, one-use previews, CSRF leases, requests and watch resources are released on disposal; duplicate installation for the same context/root/space is rejected.

## Remaining integration

The persona retrieval resolver does not yet authorize the new owner-edit evidence. This backend can query adopted records through the neutral API, but must not be advertised as a completed persona chat journey. Growth/core anchors, trusted backup selection, full multi-space in-place upgrade, actual old-service quiescence testing, and physical-cold watcher integration remain separate work. Automatic maintenance and user-correction rules for protected external revisions must be integrated before release. Native watch evidence is currently macOS only; unsupported-platform fallback is simulated and disclosed. HTTP/Cordis component evidence is separate from a browser-rendered owner-page check.

中文摘要：独立所有者可显式安装自动监测和中文审核页，先核验差异，再按指定字段采纳或恢复可信原件。接口沿官方本地Web所有者认证，普通聊天不获得管理能力。当前仅覆盖records，未接人格证据加载、成长/核心恢复或冷数据监听；不能据这些组件通过关闭完整RF验收。优先把旧库导入独立新根；原地建立基线需要所有者确实停写，参数本身不证明已停。
