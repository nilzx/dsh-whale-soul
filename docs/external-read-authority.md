# Owner-reviewed quotation reads

This optional file-provider extension connects approved external **record** edits to persona reads. It grants no management, interaction, maturity, or growth authority. Self/core integrity and protected user corrections remain separate work.

`createExternalReadAuthority({store,maxRecords:10})` prepares a synchronous, immutable lease from an actual `memory.read` context. Discovery first uses a bounded neutral authorized/retention-filtered catalog, before the persona rejects unknown evidence. It never accepts a model-selected filesystem root or falls back to `memory.manage`.

```js
const authority = createExternalReadAuthority({ store })
const lease = await authority.prepare({ query: 'colour', limit: 8 }, context, {
  signal,
  authorize: () => hostAgentAndProviderStillCurrent(),
})
lease.evidenceAllowed(evidenceId, context, frozenMeta) // synchronous boolean
lease.recordAllowed(authorizedRecord, context)        // synchronous boolean
lease.isCurrent()                                    // synchronous boolean
```

Each lease verifies a clean root head, current bundle hashes, original scope, visibility, active time, purge generation, and retention. Only an anchored `owner_external_edit` quotation with its exact patch hash, deterministic evidence ID and committed revision is approved. An `owner_restore` quotation must trace to that real adopted revision. Restoring native user evidence does not grant an exception to its original revocation policy. Historical quotations are deliberately not promoted by a current lease. Unknown sidecars, copied contexts, JSON-cloned leases and self-reported flags cannot acquire authority.

The runtime composes these leases with its existing native/image evidence policies for automatic context, recall and offered correction slots. The same total 2400 UTF16 context budget remains in force. Loaded rows identify their source as `owner_reviewed_quotation`. Reading or owner review does not update the current-message save receipt or persona maturity.

## Final main-request boundary

Approved owner data uses the distinct host context name `whale-soul:owner-reviewed-memory`; the combined memory context occupies either that section or the ordinary memory section, never two independent 2400-unit budgets. The host's actual `isAgentLoopRequest` function distinguishes official main envelopes from read-only selector/reflector calls. `installPersonaPlugin` factory callers must supply this public rc.3 binding; production `apply()` imports it directly.

The dispatcher checks the deep-frozen branded envelope and binds each exact request/section reference to the issued read lease. It checks again before iterator entry and each streamed result. A newly prepared cache cannot silently rebind an already checked old request. User text containing the section name is ordinary user data; it cannot mint a host runtime snapshot.

Official rc.3 retains older runtime-context snapshots in the Session. The [injected-context boundary](injected-context-boundary.md) now covers the complete native/owner/growth/operation view. With the official surface bindings, known invalid plugin sections are removed from the active projection through public single-event replacement; original Session history remains intact. Unknown snapshots, process restart or a bounded registry can still require a new Session. This is not complete transcript deletion or a protected user-correction journey.

The live provider identity is also checked through a trusted host callback; disposal or replacement cannot keep old cached owner reads active. No error body needs to contain file paths, credentials, record contents or provider secrets.

中文摘要：所有者审核后的事实按“人工审核引用”读取，仍受身份、时间、清除、不记和敏感边界约束，不能变成人格成长依据。具备官方绑定时，宿主可移除活动上下文中已核验但失效的本插件快照，保留原始会话历史；重启后无法证明归属或存在未知旧快照时，仍可能需要新会话。受保护事实的真实用户更正由[独立更正路径](protected-fact-correction.md)处理，不由引文读取权限授予。
