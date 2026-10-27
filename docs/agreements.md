# Explicit conversational agreements

[中文](agreements.zh-CN.md)

The bridge handles a narrow set of explicit future-agreement phrases in Chinese and English. It connects real user messages, the Agent’s acceptance action and supported delivery results to the existing agreement store. Ordinary promises, requests to save a fact and one-off task instructions are not automatically upgraded into mutual agreements.

## Proposal and acceptance

1. The user explicitly proposes terms, for example: “Let’s agree: next time we discuss a plan, start with the conclusion and then explain the reasons.” This creates `proposed`, with neither side’s acceptance implied.
2. The Agent decides whether the terms fit its persona and capabilities. It may accept with `soul_agreement_accept`, using the offered record ID and current revision. This is only the Agent’s acceptance.
3. The user separately confirms, for example: “I accept this agreement.” Both recorded acceptances are required for `open`. They may happen in either order after the proposal.

The acceptance tool takes only the existing target and revision:

```json
{"record_id":"offered-record-id","expected_revision":1}
```

Use the actual current values from the proposal. A changed version needs a fresh view; an ambiguous confirmation stays unresolved. A normal “okay” in assistant prose is not the Agent’s recorded acceptance. Replies should describe the committed state: a proposal is not yet “agreed.”

Only open, unexpired agreements count as current agreement memory. Pending proposals are presented separately to the current conversation, with their status. Proposals and acceptances provide no growth or maturity qualification.

## Cancellation, deadlines and completion

An explicit user cancellation such as “Cancel this agreement” closes the identified current agreement. If several targets remain possible, the bridge asks for clearer terms instead of choosing one. A recognized deadline closes the acceptance/current-memory window; expiry is not fulfillment.

The bridge does not infer delivery from an ordinary tool success, an assistant saying “done,” or an idle session. Unknown free-text delivery remains open. It does not schedule background work merely because terms mention a future time.

## Todo-state delivery adapter

The first delivery adapter verifies a state update, not arbitrary work behind a todo. Start with an existing unfinished todo, then explicitly propose, for example: “Let's agree: next time mark todo "Organize reading notes" as completed.” After both sides accept, the real successful `todo_write` result must change that exact continuous target from `pending` or `in_progress` to `completed` in its original Session. The agreement then becomes `fulfilled`.

The host binds this optional metadata when the proposal names the unique unfinished target:

```json
{"kind":"todo","session_id":"original-session","content":"Organize reading notes","origin_seq":12}
```

The fields come from the real Session snapshot; the model does not submit a fulfillment flag. A failed tool result, another item, another Session, removal and re-addition of the item, or a text claim cannot satisfy this binding. Saying only “finish todo X” does not prove the underlying work and does not acquire this state-only binding. Late verified state delivery may close an expired agreement as fulfilled while preserving the expired revision in history.

Agreement state changes, target bindings and provenance stay in metadata; memory prose contains the terms, not operation receipts or diagnostics. Broad natural-language coverage and other artifact-specific delivery adapters remain separate extensions. Focused checks do not imply every model or Web lifecycle has been covered.
