# Deterministic memory lifecycle

The V2 file provider supports owner-managed physical cold storage and one-process host maintenance. Both `autoMemoryMaintenance` and `automaticCold` default to `false`. A missing maintenance-writer capability disables physical maintenance, including manual `force`, while ordinary persona facts and authorized reads remain available.

Cold records retain the complete current five-file bundle and every anchored revision at `cold/records/<record_id>`. Their root head declares the location; reads do not infer activity from file presence. Default retrieval excludes cold records. Authorized `include_cold: true` reads the actual cold bundle without moving it back. Pinned records, protected external revisions and legacy user edits do not decay. Ordinary model writes cannot independently move records or complete agreements. A newly admitted correction can restore one bound cold fact through the correction path below.

Maintenance due state is host-local scheduling authority in `.administration/lifecycle/<space>.json`; the space index is a rebuildable projection. Same-root restart or index deletion cannot reset its watermarks. A separate-root `upgrade-self` preserves record age, expiry, cold location, evidence, persona maturity and purge authority, but does not export the source host's scheduling ledger. Its preview and apply results report `lifecycle_schedule: reinitialized_for_destination`, or `preserved_destination` when the target already has a ledger. Source scheduling bytes are included in the reviewed source snapshot and final source recheck. Reinitializing a destination schedule is not a persona maturity reset.

The host coordinator combines actual Agent/session bindings, queues, in-flight calls, Runtime work and constructor-registered writers for the same canonical root and memory space. An unknown writer or missing capability fails closed; `force` bypasses only the due threshold. It never bypasses scope, idle, cancellation, ownership or the final synchronous COMMIT check. This establishes a single-process boundary, not global idle across hosts or arbitrary filesystem writers.

Completed transaction redo can repair missing record bytes only when they match the current root anchor and location. It does not restore self data, rewind a root head, overwrite changed bytes or recreate a hot copy of a cold record. Portable transfer v3 keeps self integrity and record-location integrity as separate authorities. Owner-managed agreement state has deterministic CAS operations. The [narrow conversation bridge](agreements.md) now supports explicit proposals, separate acceptances, cancellation and deadlines; it does not infer fulfillment from ordinary tool success.

The writer API floor is 1.3.0. Earlier 1.2 writers do not understand the physical-cold contract and must not open this root. The `physical-cold-v1` capability is descriptive and does not replace this version floor. A 1.2 root is refused by default with `LIFECYCLE_INTEGRITY_UPGRADE_REQUIRED`; the explicit separate-root `upgrade-self` flow accepts 1.1 or 1.2 sources. Trusted 1.2 self bundles retain their original anchors and active traits. Unanchored 1.1 growth remains opaque. Storage format 2, transfer format 3 and provider protocol 1.0.0 are independent versions.

The trusted `PersonaRuntime.recall` host API propagates explicit `include_cold: true` to owner-reviewed quotation leases. The lease binds the boolean view intent, original context, tier, current head, payload and time window; cancellation or a late change invalidates it. Default automatic context and ordinary recall still exclude cold records. The model-facing `soul_recall` tool offers the same optional boolean for deliberate deeper recollection. Omitting it or passing `false` keeps active-only reads. It grants no memory management, restore or write capability. Owner quotation access grants no growth or maturity qualification.

## Deliberate deeper recollection

Use `soul_recall({"query":"the concert","include_cold":true})` when choosing to recall older cold experiences. The optional field accepts a boolean only and defaults to false. Existing query, depth, time and result-limit options keep their current contracts. Read access remains scoped to the actual Agent/Session/individual and still applies source, privacy, consent, expiry and cancellation checks. It neither changes original bytes nor increases growth or maturity qualification.

This recall option remains read-only: it does not restore, revise or warm a record. Automatic L0 context continues to exclude cold memory.

## Correcting an older fact

An explicit natural correction, such as “Correction: I now prefer white tea,” can include cold facts in the runtime’s bounded target catalog. The admitted selection must name the matching record and expected revision. An ambiguous or stale target is not silently rebased.

The host correction commits restoration and the new revision together. The current head becomes active with the corrected fact; previous revisions and their original bytes remain in history. Owner-reviewed records keep their title, tags, pinned and protected status. The new gist/detail contain the factual correction, while source, restoration and revision information stay in metadata.

This is distinct from reading with `include_cold`. Ordinary deeper recall stays read-only, and a general new fact does not restore an unrelated cold record. The path currently covers private long-term facts, preferences and episodes in the same individual scope; see [protected fact corrections](protected-fact-correction.md).
