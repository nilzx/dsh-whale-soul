# Persona self integrity and owner upgrades

The current storage API is **1.3.0**. Facts and episodes have root record heads; each individual's self manifest, proposals, traits and history have a separate root self head. Original evidence and maturity remain governed by the independent persona ledger. An internally consistent set of edited self files does not establish authority.

Normal writes verify the previous complete self bundle before deriving the next head in the same durable transaction. Context assembly rejects damaged or unanchored self data. `PersonaSelfAdministration.restoreSelf` restores only bytes matching the existing trusted head; it cannot assign an arbitrary personality value.

Full exports use transfer version 3 and carry `self_integrity_state` without prose. Owner imports require `identity_mode: 'preserve'` and explicit `accept_self_integrity: true`, in addition to applicable persona, purge and record-integrity acceptance. Current host stability mode wins over a snapshot. Conflicting self snapshots do not merge by modification time. Ordinary backup restoration cannot lower trusted maturity watermarks.

## Upgrade an API 1.1 root

Stop the source's writers and maintenance, preserve the source, and use a separate non-overlapping destination. Run the CLI outside the persona's restricted process:

```sh
dsh-whale-soul-manage upgrade-self --root /absolute/new-root --space owner \
  --source /absolute/old-root --source-quiescent \
  --legacy-self-policy preserve-opaque
```

Review `source_snapshot` and the preview. Apply the same command with `--snapshot HASH --apply`. The source remains unchanged. Existing identity and evidence credentials are preserved; old unanchored growth is archived under `cold/legacy-self/` and never loaded as stable traits. The current host mode remains authoritative.

The destination keeps a local, non-portable list of old source paths for persona file protection. A declared but missing authority fails closed; committed pending restrictions are enforced before normal recovery. This does not delete the old source or stop another already-running old writer.

API 1.0 record baselines deliberately stop at API 1.1. The new reader still refuses that intermediate root until this separate self upgrade completes. The record-baseline step currently uses the explicit owner API documented in [external review](external-review-api.md); it is not an automatic CLI migration. Keep its operation ID and reviewed snapshot for exact recovery retries.

See the [Chinese version](self-integrity.zh-CN.md) and [management CLI](management.md).
