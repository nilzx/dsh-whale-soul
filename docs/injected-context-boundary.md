# Final boundary for plugin-injected context

The main-request guard covers all three host-owned sections: `whale-soul:memory`, `whale-soul:owner-reviewed-memory`, and `whale-soul:growth`. A combined owner section also contains ordinary facts, so an owner-only read lease is insufficient. Every issued section is bound to the complete memory/growth fingerprint, including actual source revocation, purge state, provider/context/session authority, self head and loaded files.

`PersonaRuntime.assertInjectedContextCurrent(agent, request)` accepts only the official branded, frozen main envelope. It binds the exact message/section references and rechecks them at final dispatch and stream iteration. JSON copies, user strings and selector/reflector requests do not mint section authority. The earlier `assertMemoryRequestCurrent` method remains a compatibility alias for trusted host callers.

An expired, revoked, purged, changed or unrecognized retained plugin snapshot fails closed before `adapter.stream`. This includes native facts and stable growth. Original user/assistant/tool conversation is separate and is not erased by the guard. This stage performs no Session-surface cleanup. Adding a new fact changes the old complete fingerprint, so ordinary continuing chat can also be blocked and require a new Session. It therefore proves a safety boundary, not complete continuing-session usability; the surface stage is required before claiming the regular multi-turn journey works.

The regression baseline uses actual rc.3 Session, AgentLoop, Scope and LLM dispatch, with a deterministic local adapter and no real model. Native revoke/purge, revoked native data inside a combined owner section, and a growth-head change after prepare all reproduced old adapter-entry failures. Keep those failing counterexamples when integrating the fix.

中文摘要：最终门阀覆盖本插件注入的普通记忆、人工引用和成长内容，核验完整来源，不能让一条有效人工引用代替整段组合内容的授权。旧快照失效会在模型入口拒绝；原始聊天历史不受此门阀清除。受管surface净化与持续会话可用性将在后续独立块实现。
