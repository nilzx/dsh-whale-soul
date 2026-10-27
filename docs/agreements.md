# Explicit conversational agreements

[中文](agreements.zh-CN.md)

The first bridge handles a narrow set of explicit future-agreement phrases in Chinese and English. It connects real user messages and the Agent’s acceptance action to the existing agreement store. Ordinary promises, requests to save a fact and one-off task instructions are not automatically upgraded into mutual agreements.

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

This first implementation covers proposal, separate acceptances, clear cancellation and deadlines. Matching a concrete delivery result, broad natural-language coverage and actual model/Web acceptance remain unfinished. Agreement state changes and provenance stay in metadata; memory prose contains the terms, not operation receipts or diagnostics.
