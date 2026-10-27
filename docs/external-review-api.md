# External record review API (experimental backend)

The current backend uses memory API **1.3.0**, record schema **2**, record-integrity state schema **1**, and full portable transfer format **3**. This module provides owner record review and an opt-in watcher/Web host adapter. It does not install a management tool into ordinary persona chat or edit the persona core. Self-state recovery is a separate [owner API](self-integrity.md).

The trust boundary is a local owner process outside the persona's restricted tools. It is not human authentication against every process running as the same OS user. Root metadata contains only identifiers and hashes; raw records and quarantined content remain private to the memory root. An owner who rewrites both root anchors and all source copies is outside the guarantee.

## Upgrade safely

Prefer a **new absolute destination root**. Export the old 1.0 library with its original owner tooling, retain source snapshots before and after export/import, and explicitly accept that old archive as a baseline in the new store. `MemoryTransfer.importSpace()` requires `identity_mode:'preserve'`, the existing purge/persona acceptance flags where applicable, and `accept_legacy_baseline:true` for a version-1 archive. Current transfer-v3 archives also require `accept_integrity_state:true` and `accept_self_integrity:true`, with the corresponding CLI flags shown in [management](management.md). A running old process remains confined to its old path. Older readers must not write the current API1.3 destination.

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
// Check the structured result. This creates an intermediate API 1.1 root.
// Stop using this store here; continue with upgrade-self into a separate destination.
```

The in-place helper supports a single-space API 1.0 root and deliberately stops at API 1.1; it does not produce a directly usable API 1.3 root. Continue with the separate-root [self upgrade](self-integrity.md) before starting the current runtime. A multi-space source is explicitly refused; use isolated exports/imports per space. Missing, malformed, unsupported, or unanchored data is not repaired by recomputing its own `integrity.json`. Historical operation receipts are not rewritten.

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

Current full version-3 archives carry both `integrity_state` and `self_integrity_state`; imports explicitly accept them with `accept_integrity_state:true` and `accept_self_integrity:true`, plus applicable purge/persona acceptance. Version-2 archives carry record integrity without self integrity, and version-1 archives require explicit legacy-baseline acceptance. These older archive versions are compatibility inputs, not substitutes for a complete current backup. Removing fields and downgrading the version cannot bypass the separate old-baseline acceptance gate. Divergent existing heads are rejected, even when the imported revision number is higher. Quarantine stays quarantine across roots. Omitted pending payloads are listed and are not advertised as restored.

The local CLI recognizes `--accept-integrity-state`, `--accept-self-integrity` and `--accept-legacy-baseline`; its shadow snapshot includes record and self heads. External review is not yet exposed as CLI subcommands. Managed purge can target an unreadable quarantined record using the trusted scope/revision anchor, preserves siblings/shared references, and removes its managed forensic copies. Root purge tombstones remain without plaintext.

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

The Chinese page displays before/after values as plain text, its verified restore choices, and selected adoption fields. It uses a nonce CSP, no inline event attributes or untrusted HTML insertion. The standalone B1 owner profile explicitly states that it covers **records only** and does not contain a chat Agent. Routes, one-use previews, CSRF leases, requests and watch resources are released on disposal; duplicate installation for the same context/root/space is rejected. A future combined owner/persona UI must describe its actual read integration rather than reusing that standalone profile's chat limitation blindly.

## Integration and limits

The [owner quotation read adapter](external-read-authority.md) provides bounded root-anchored persona reads and a final main-request lease check. [Injected-context handling](injected-context-boundary.md) and [protected fact correction](protected-fact-correction.md) have their own runtime contracts; their implementation is not a general grant to overwrite owner-reviewed text. [Self integrity and upgrades](self-integrity.md) covers growth-state anchors and recovery separately. Core text remains versioned source.

This record-review module does not implement full multi-space in-place upgrade or physical-cold watcher coverage. Native watch evidence is currently macOS only; unsupported-platform fallback is simulated and disclosed. HTTP/Cordis checks, browser owner review and actual model journeys are separate evidence layers; none alone closes full release acceptance.

中文摘要：当前为记忆API1.3、record schema 2、完整transfer v3。所有者可显式安装监测和中文审核页，核验差异后采纳指定字段或恢复可信原件；普通聊天不获得管理能力。完整导入需明确接受record与self完整性状态，另有适用的人格和清除状态。早期API1.0的record基线只产生1.1中间根，还需独立目标根的self升级。人格读取、受保护事实纠错与成长恢复分别见对应文档；多空间原地升级、冷藏目录监听与完整跨平台/发布验收仍未完成。
