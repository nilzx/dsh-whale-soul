# External record review API (experimental backend)

This branch implements the owner-only backend for API **1.1.0**, record schema **2**, integrity state schema **1**, and portable transfer format **2**. It does not install a watcher, Web review page, Agent management tool, or growth/core recovery adapter. Those layers remain unimplemented and unaccepted.

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

Every method requires the store's actual `memory.manage` context, rechecked before COMMIT. Copies of a context and model-supplied permission flags do not grant access. A third trusted argument `{signal}` supports cancellation before COMMIT.

- `scan({record_ids?,cursor?,limit?,capture:false}, context)` is an observational scan. `capture:true` preserves an affected record by a recoverable directory detach and marks only that record quarantined. Normal neighbors remain readable. A fresh self-consistent directory without an anchor remains untrusted.
- `list({cursor?,limit?,include_resolved?}, context)` returns safe IDs, reasons, hashes, and status. A forged resolution file cannot hide quarantine.
- `preview({change_id,expected_observed_hash}, context)` returns bounded textual field differences, rejection reasons, verified recovery candidates, and a review digest. It redacts unsafe content and never calls a model.
- `resolve({operation_id,change_id,action,review_digest,expected_change_revision,expected_head_revision_id,expected_observed_hash,...}, context)` performs the exact approved operation. It never rebases a stale review onto a later correction.

For `action:'adopt'`, supply `fields` selected from `title`, `tags`, `gist`, and `detail`. Values are copied from the captured snapshot; arguments cannot inject replacement text. The combined patch including its field wrapper must fit 8000 UTF16 units. Identity, visibility, canonical slot, raw evidence, assets, timestamps, qualification, core, and growth fields cannot be adopted. A new revision uses `claim_kind:'quotation'` and `source:'owner_external_edit'`; it does not invent a user statement, growth evidence, or maturity event.

For `action:'restore'`, supply a `restore_revision_id` offered by preview. An intact anchored head is restored byte-for-byte with its original record/revision identity. If only an earlier anchored revision remains valid, restoration creates a new forward revision and records `restored_from`. No trusted candidate means an explicit refusal, not an invented repair.

The original detached inode remains preserved, including late writes through an already-open file. New publication uses exclusive directory/file creation and only marks the root head clean after complete hash verification. A recreated target directory is preserved and causes a conflict. COMMIT recovery is tested with real process termination; physical power failure is not claimed.

## Transfer and purge

Version-2 archives require `integrity_state` and explicit `accept_integrity_state:true` at import. Removing that field and downgrading the version cannot bypass the separate old-baseline acceptance gate. Divergent existing heads are rejected, even when the imported revision number is higher. Quarantine stays quarantine across roots. Omitted pending payloads are listed and are not advertised as restored.

The local CLI recognizes `--accept-integrity-state` and `--accept-legacy-baseline`, and its shadow snapshot includes the new record heads. The external-review API itself is not yet exposed as CLI subcommands or HTTP routes. Managed purge can target an unreadable quarantined record using the trusted scope/revision anchor, preserves siblings/shared references, and removes its managed forensic copies. Root purge tombstones remain without plaintext.

## Remaining integration

The persona retrieval resolver does not yet authorize the new owner-edit evidence. This backend can query adopted records through the neutral API, but must not be advertised as a completed persona/Web journey. Watcher scheduling, owner UI/authentication, asynchronous disposal, growth/core anchors, trusted backup selection, full multi-space in-place upgrade, and actual old-service quiescence testing remain separate work. Automatic maintenance and user-correction rules for protected external revisions must be integrated before release.

中文摘要：这是独立所有者后端，默认先预览。优先把旧库导入独立新根；原地建立基线需要所有者确实停写，参数本身不证明已停。未接watcher、Web界面、人格证据加载及成长/核心恢复，不能据组件通过关闭完整RF验收。
