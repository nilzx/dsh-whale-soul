# V2 memory design

[中文](MEMORY.zh-CN.md) · [Historical V1 design](MEMORY-V1.md)

The refactor separates a replaceable persona from a durable memory provider. Facts, personal experiences and personality growth have distinct storage and loading rules. Ordinary conversation can supply new evidence and corrections; it cannot rewrite the core or turn an instruction to act differently into a stable trait.

## Versions and modules

| Contract | Current version |
|---|---|
| Neutral memory API / writer floor | 1.3.0 |
| Storage / record schema | 2 / 2 |
| Full portable transfer archive | 3 |
| Host memory-provider protocol | 1.0.0 |

`dsh-whale-soul/memory` exports the neutral store and owner APIs. The host-level `memory-provider` supplies that store to `persona`; removing the persona does not delete the data. Both modules remain in one package. See [provider composition](memory-provider.md).

The core is versioned source text. Each continuing individual has its own evidence, growth proposals, stable traits and maturity. `individualKey` selects an individual within a memory space; changing the displayed preset name is not an identity change. See [individuals](individuals.md).

## Storage and content

Under the configured `memoryRoot`, a selected space uses:

| Location | Contents |
|---|---|
| `spaces/<space>/records/<record_id>/` | Current fact/episode bundle and anchored `revisions/` |
| `spaces/<space>/cold/records/<record_id>/` | Complete physically cold bundles, including revision history |
| `spaces/<space>/self/<agent_identity_id>/` | Original evidence, proposals, stable traits and growth history |
| `.administration/` | Root identity, record/self integrity, purge and lifecycle authority |

A record bundle contains `meta.json`, `gist.md`, `detail.md`, `evidence.jsonl` and `integrity.json`. Gist and detail express the memory itself. Provenance, attribution, timing, validity and revision metadata remain separate; original evidence is retained as evidence. Save commands, permission text, test markers, raw management patches and maintenance diagnostics do not belong in memory prose. Scope such as “this week” or “occasionally” remains part of the meaning.

Indexes are projections, not substitutes for record history or root anchors. Recomputing a file hash after a direct edit does not make that edit trusted.

## Selection and correction

Before the main reply, the runtime selects durable facts, important experiences and continuing plans from actual user messages. It can keep several distinct facts from one message, with an outcome for each. Chatter, one-off task directions, quoted fiction and explicit non-retention requests do not become lasting facts merely because the model sees them. Sensitive credentials are excluded.

A save instruction is control information: “remember that I prefer white tea” retains the preference, not a second memory about the request to save it. The reply may confirm only the excerpts that actually committed. Ambiguous matches stay unresolved rather than silently replacing an unrelated record.

A question asking what the Agent remembers supplies no new preference value. It must not replace a known fact with a topic such as “my favorite tea”. Separately asserted facts in the same message can still be selected; quoted questions inside a real experience do not make that experience a recall request.

Corrections target a specific record/revision and preserve earlier versions and sources. An explicit natural correction can locate a cold fact and commit its restoration plus revision together; the admitted target and revision must still match. Protected title, tags, pinned and protection metadata remain intact, and the earlier body stays in history. Owner-reviewed text stays attributed as a quotation; it does not become an invented user statement or growth event. Direct external edits use the separate [review workflow](external-review-api.md), not automatic adoption by modification time.

## Explicit agreements

The [conversation bridge](agreements.md) recognizes explicit Chinese/English future-agreement proposals. A proposal stays `proposed`; an independent user confirmation and the Agent’s actual `soul_agreement_accept` action are both required for `open`. An explicit agreement to mark an existing unfinished todo completed can bind its exact content and original Session. The matching continuous todo's successful state-update result can then mark that state-delivery agreement `fulfilled`. It does not prove a note, code change or other underlying work was delivered. Clear cancellation and deadlines are handled separately. Storage instructions do not become agreements, and these events do not qualify as growth or maturity. Arbitrary free-text delivery and broad semantic coverage remain outside this narrow adapter.

## Recall and lifecycle

Bounded automatic context loads selected current memories. `soul_recall` supports deliberate gist, detail and raw-evidence retrieval, with the current identity and visibility rules. `include_cold: true` explicitly includes older physically cold records; ordinary recall and automatic context exclude them. Reading a cold record alone does not restore or revise it.

Physical lifecycle maintenance is opt-in: `autoMemoryMaintenance` and `automaticCold` default to false. It preserves cold records and history rather than treating age as a deletion request. See [lifecycle and deeper recall](lifecycle.md) for current behavior and limitations.

## Independent growth

Actual choices, outcomes and later feedback may support a growth proposal. Reflection and the configured stability thresholds determine when a compatible proposal becomes a stable tendency. Candidates are not loaded as stable personality. One event split into several facts still counts as one event; repetition and requests to change personality do not manufacture maturity.

`variable`, `normal`, `stubborn` and default `auto` affect later growth thresholds. Core identity and factual correction remain continuous across modes. Auto becomes steadier with qualifying experiences. See [stability](stability.md) and [self integrity](self-integrity.md); long-term model behavior remains a separate acceptance scope.

After a core version upgrade, old growth remains stored but is not automatically loaded. The [core-upgrade review](core-upgrades.md) rechecks it against the new core: compatible stable traits remain stable, compatible candidates remain candidates, and rejected items stay preserved and unloaded. Original text, evidence, identity and maturity remain unchanged; older revisions remain in history.

## Portability and owner operations

Use the [local management CLI](management.md) for preview, export, import, legacy migration and precise removal. Full transfer v3 preserves record locations, provenance, revisions, individual identity, growth, maturity and the applicable integrity/purge states. Copying only a `self/` folder is not a complete identity-preserving transfer. The current host stability mode wins over an imported snapshot.

From 0.2.1, ordinary preset startup and memory operations send detected old-layout or damaged-data errors to the independent current-spec repair Agent. The host preserves original files and publishes only a validated replacement. Explicit owner APIs keep their direct validation and separate-root workflows; see [owner-managed upgrade rules](self-integrity.md).

Version 0.2.0 is published; the 0.2.1 repair candidate is not yet published. One focused Electron repair test with synthetic corruption has passed. Earlier core fact, correction, restart and focused growth checks cover their recorded release scope. Broader corruption patterns, long-term growth and complete optional-body journeys remain separate validation scopes. New V2 narrative dream diaries are not implemented; current reflection is distinct from the [V1 dream-journal behavior](MEMORY-V1.md).
