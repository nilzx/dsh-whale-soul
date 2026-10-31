# Remember a selected conversation

[中文](session-memory.zh-CN.md)

Available since version 0.3.0.

In a Whale Chan session, invoke `/whale-remember-session` and identify the source conversation with a DSH session reference or session ID. Say “the current conversation” to process the session you are in.

Examples:

```text
/whale-remember-session From session <session-id>, remember only the photo backup procedure and its constraints.
/whale-remember-session Review session <session-id> and retain what will be useful in future conversations.
/whale-remember-session Summarize the useful memories from the current conversation.
```

When you name a topic, extraction is restricted to that topic. Without a topic, the Agent selects durable facts and preferences, continuing plans, important experiences and reusable conclusions. Routine commands, greetings and execution logs are usually skipped. If there is nothing worth retaining, the operation can finish without creating a memory.

The default detail mode is automatic. Simple preferences and broad conclusions receive concise summaries. Procedures, decision rationale and significant experiences can retain selected original user excerpts and essential conditions. You can explicitly ask for summaries or detailed retention. The summary layer remains short; detail is loaded through normal recall when needed.

The tool reads the conversation through DSH's session service and uses the user's own statements as factual evidence. It does not import system instructions, tool logs or reasoning. Assistant-only suggestions and general knowledge do not supply additional steps or decisions. Broad approval of a procedure does not fill in details the user never stated or specifically confirmed. Long conversations are processed in small chunks; the service resolves source references to the original text instead of asking the model to copy quotations. Related fragments are grouped before saving, and existing memories are compared together to avoid saving a recombination of already-covered content. Importing does not overwrite existing records.

Sources retain the actual session, message and time in normal V2 evidence metadata. Detailed prose is composed directly from the selected user excerpts; first-person wording belongs to the source user. Memory prose contains the actual content rather than a transcript wrapper or extraction receipt. Names and preferred forms of address are retained as identity information and prioritized in the current user's small memory context. Importing does not change persona traits or maturity.

This workflow has been checked against a fixed 14-round Web conversation, including focused extraction, automatic selection, repeat import and recall in a new session.

Sessions in the current workspace can be selected by ID. To select a conversation from another workspace, include its exact ID or DSH session reference in your request. Ambiguous targets should be clarified before extraction. The host must provide its `sessionQuery` and `skills` services; unavailable history or a model error is reported without claiming that memories were saved.

The final reply reports saved items, already-saved items and any failures. The operation uses your current model route for extraction; long conversations can require multiple model calls. It does not require copying a transcript or editing memory files yourself.
