# Protected fact corrections

The persona runtime can accept a new user statement about an owner-reviewed
fact without granting administrative access. This extension only supports an
active or explicitly selected cold, private, long-term `fact`, `preference`, or
`episode` in the same memory space, persona, individual and subject. Shared
records, agreements, assets, identity records and unverified sources remain
outside this path.

The new statement must be an admitted batch item already committed by the
trusted persona state service. Its offered target, revision, type, key, exact
quote, and proposal hash are checked again at the write boundary. A selector's
verdict is insufficient on its own. The live Session fence, ordinary read and
write context, cancellation signal, retention gates, and complete root record
integrity must remain valid through the final PREPARE authorization.

## Host API

```js
import { createProtectedCorrectionAuthority } from 'dsh-whale-soul/memory'

const authority = createProtectedCorrectionAuthority({
  store,
  resolveAdmittedItem: id => personaState.resolveEvidence(id),
  checkBoundary: ({ item, context }) => verifyCurrentSession(item, context),
})
const permit = await authority.authorize({
  evidence_id: item.evidence_id,
  proposal_hash: hashApprovedProposal(item.memory_proposal),
  args: exactApprovedRevisionRequest,
  // For an admitted correction bound to a cold target, add restore_cold: true.
}, context, { signal })

await store.reviseMemory(exactApprovedRevisionRequest, context, {
  protectedCorrectionPermit: permit,
})
```

Both injected callbacks are trusted, synchronous host services. The evidence
resolver must re-read the committed item binding and payload hash; it must not
return a model-supplied object. The boundary callback must verify the actual
live Session, ownership, original admitted input, and provider lifetime.
`PersonaRuntime` supplies these checks for the bundled file provider.

The permit is an opaque, single-use object. Serialization, copying, concurrent
reuse, another context object, another store, or passing a similarly named
field in model arguments cannot grant access. It is not a model tool or an
administrative capability. Receipts and operation hashes do not contain it.

The resulting revision uses the new real `user_statement`. Owner-maintained
title, tags, pinned status, and protection remain intact; the previous owner
quotation and all historical bytes remain historical evidence. An admitted cold
correction restores the active head and publishes the new revision in one
transaction; it does not replace historical bodies. Ordinary `include_cold`
recall remains read-only. A later user
correction requires a fresh admitted item and permit. A stale offered revision
conflicts instead of rebasing over newer information. Source-chain verification
checks at most 16 existing protected revisions and fails closed when that bound is
exhausted; an owner may explicitly review a fresh baseline.

## Recovery and limits

An uncommitted permit is not persisted. A committed transaction uses the
existing durable journal and receipt recovery. Pending protected items defer
while there is no live confirmed original Session; native pending items keep
their existing recovery behavior. A source approved before a later turn
cancellation can remain an outbox item. Cancellation prevents that invocation
from committing a fact; it is not a permanent revocation of a previously
committed source. Explicit source revocation or managed purge has separate
semantics.

The recovery source lookup examines at most 16,384 public Session events. A
larger historical Session without a current trusted inbox admission fails
closed instead of accepting an unverified source.

The host proves source, scope, integrity, offered target, and CAS. Semantic
equivalence between the new statement and the offered fact still depends on
the bounded selector and requires real-model verification. This component does
not claim shared-record support, human authentication beyond the local owner
boundary, or a completed end-to-end RF acceptance journey.

## 中文说明

真实用户可在当前已确认会话中更正已经人工核验的私有长期事实。每次更正都需要
新的获准来源和原版本匹配；不会取得管理权限。人工标题、标签、置顶与保护
状态保留，原人工引用留在历史中，不变成用户原话或成长依据。

明确更正可绑定冷藏条目，在一次提交中恢复并修订，旧正文保持；普通冷藏召回仍只读。
当前不支持共享、约定、图片或核心身份的窄更正。取消会阻止本次提交，
但不会自动永久撤销此前已经提交的来源；永久撤销和清除沿各自受管入口处理。
测试夹具中的模型只用于验证调用时序，不能替代真实模型的语义验收。
