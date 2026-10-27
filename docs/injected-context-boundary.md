# Final boundary for plugin-injected context

The main-request guard covers four host-owned sections: `whale-soul:memory`, `whale-soul:owner-reviewed-memory`, `whale-soul:growth`, and `whale-soul:memory-operation`. A combined owner section also contains ordinary facts, so an owner-only read lease is insufficient. Save receipts contain selected excerpts and require the same protection. Every issued section is bound to the complete memory/growth fingerprint, including actual source revocation, purge state, provider/context/session authority, self head and loaded files. Operation sections additionally bind the current message/operation epoch and exact current status text.

`PersonaRuntime.assertInjectedContextCurrent(agent, request)` accepts only the official branded, frozen main envelope. It binds the exact message/section references and rechecks them at final dispatch and stream iteration. JSON copies, user strings and selector/reflector requests do not mint section authority. The earlier `assertMemoryRequestCurrent` method remains a compatibility alias for trusted host callers.

An expired, revoked, purged, changed or unrecognized retained plugin snapshot fails closed before `adapter.stream`. This includes native facts, stable growth and old save receipts. Original user/assistant/tool conversation is separate and is not erased by the guard. Guard-only callers without the surface bindings may require a new Session after legitimate memory changes; they must not claim continuing-session usability.

## Managed active-surface cleanup

`createInjectedSurfaceController` is a host-only authority over one actual Session. It requires the official `isAgentLoopRequest`, `createUserMessage`, and `joinContextSections` functions plus a synchronous live identity/provider/fence check. It registers only exact deep-frozen request/message/section references that the runtime already authorized and that are still the same active public Session event. A name or text match, copied envelope, model argument or arbitrary event ID cannot register cleanup authority.

`bind(request, bindings)` records the complete known plugin contribution. `clean({signal})` plans bounded replacements and rechecks authorization before each synchronous public append. Each replacement targets one exact surface event through `Session.append('user/message', ..., {surfaceOp:{op:'replace',startSeq,endSeq},sourceEventSeqs:[originalSeq]})`. It removes only invalid known plugin sections and renders all retained third-party sections with the official renderer. Original events stay byte-for-byte in the audit history; existing user, assistant, tool and system messages are not edited. Repeated cleanup is idempotent. Cancellation, disposal, identity change, copied references, invalid replacement bindings, or a whole-plan budget overflow cause no new append.

Unknown plugin-labelled snapshots are preserved and rejected rather than automatically attributed or removed. A process restart, registry budget, unknown history or unrecoverable proof can therefore still require a fresh Session. This is a bounded active-projection cleanup, not deletion of stored conversation or evidence history. The final main guard remains active after cleanup, including changes between prepare and actual adapter entry.

Production `apply()` imports the official functions directly. Factory callers of `installPersonaPlugin` must include `createUserMessage` and `joinContextSections` in addition to the main-request brand binding. Direct `PersonaRuntime` callers may omit the surface functions and retain guard-only behavior, explicitly without its continuing-session guarantee.

The regression baseline uses actual rc.3 Session, AgentLoop, Scope and LLM dispatch, with a deterministic local adapter and no real model. Native revoke/purge, revoked native data inside a combined owner section, and a growth-head change after prepare all reproduced old adapter-entry failures. A full-preset zero-memory-budget case separately proves that old selected excerpts can leak through operation sections alone. Keep these failing counterexamples and the original continuous-main2 assertion when integrating the fix.

A verified newly admitted image-only message starts a new text-operation epoch with an ignored/empty text result. It cannot reuse a prior message's saved excerpt. This does not persist the image, grant retention consent, create evidence or increment maturity; image handling remains in its separate authority.

The replacement-budget unit fixture uses an explicitly host-marked component envelope over two actual Session objects; it is not a second successful AgentLoop turn. Continuing-chat acceptance is proved separately by actual official main dispatch and full-preset tests, with the final guard enabled throughout.

中文摘要：最终门阀覆盖本插件注入的普通记忆、人工引用、成长及保存回执，核验完整来源和当前消息。宿主只替换此前真实核验过的活动surface条目，移除失效的本插件内容、保留其他上下文和所有原始历史；未知来源不清而拒绝。具备官方构造绑定时可恢复同会话连续聊天；无绑定、重启或未知旧历史仍可能需要新会话，不宣称彻底删除原聊天内容。
