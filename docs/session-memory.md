# Remember a selected conversation

[中文](session-memory.zh-CN.md)

Development feature: this skill is included in the source preview and will ship in the next release after 0.2.3.

In a Whale Chan session, invoke `/whale-remember-session` and identify the source conversation with a DSH session reference or session ID. Say “the current conversation” to process the session you are in.

Examples:

```text
/whale-remember-session From session <session-id>, remember only the photo backup procedure and its constraints.
/whale-remember-session Review session <session-id> and retain what will be useful in future conversations.
/whale-remember-session Summarize the useful memories from the current conversation.
```

When you name a topic, extraction is restricted to that topic. Without a topic, the Agent selects durable facts and preferences, continuing plans, important experiences and reusable conclusions. Routine commands, greetings and execution logs are usually skipped. If there is nothing worth retaining, the operation can finish without creating a memory.

The default detail mode is automatic. Simple preferences and broad conclusions receive concise summaries. Procedures, decision rationale and significant experiences can retain useful detail and essential conditions. You can explicitly ask for summaries or detailed retention. The summary layer remains short; detail is loaded through normal recall when needed.

The tool reads user and assistant text through DSH's session service. It does not import system instructions, tool logs or reasoning. Long conversations are processed in chunks. Before saving, candidate prose is reconciled against verified source excerpts: overlapping memories are merged, unsupported details are removed, and assistant suggestions stay distinct from adopted user plans. Existing memories are supplied as context for avoiding redundant or outdated facts; importing does not overwrite them.

Sources retain the actual session, message and time in normal V2 evidence metadata. Assistant-derived conclusions retain a different attribution from user statements. Memory prose contains the actual content rather than a transcript wrapper or extraction receipt. Repeating the same selection reuses an existing matching memory. Importing does not change persona traits or maturity.

Sessions in the current workspace can be selected by ID. To select a conversation from another workspace, include its exact ID or DSH session reference in your request. Ambiguous targets should be clarified before extraction. The host must provide its `sessionQuery` and `skills` services; unavailable history or a model error is reported without claiming that memories were saved.

The final reply reports saved items, already-saved items and any failures. The operation uses your current model route for extraction; long conversations can require multiple model calls. It does not require copying a transcript or editing memory files yourself.
