# Persona stability

[中文](stability.zh-CN.md)

Set `stabilityMode` on the `dsh-whale-soul/persona` plugin row to `variable`, `normal`, `stubborn` or `auto` (default). This is host configuration, not a chat command. The mode changes the evidence threshold for later personality additions and revisions. Core identity, safety, privacy, permissions and fact correction use the same boundaries in every mode.

| Mode | Independent events | Sessions | Subsequent maintenance passes |
|---|---:|---:|---:|
| `variable` | 2 | 1 | 1 |
| `normal` | 3 | 2 | 1 |
| `stubborn` | 6 | 4 | 3 |

All three thresholds must be met. Counts alone do not prove a proposed trait: compatible scope, original evidence, provenance, counterevidence and assessment still apply. One message split into several facts is one event. A maintenance pass must happen after the relevant observations.

`auto` starts with the variable thresholds. It uses normal thresholds after 20 eligible interactions across 3 sessions and 3 successful maintenance passes, then stubborn thresholds after 80 interactions across 10 sessions and 12 passes. Each transition requires all three counts. Ordinary chatter, commands to change personality, tool spam, repeated Agent statements, dreams and mechanical copies do not provide independent maturity evidence. Eligibility is selected by the trusted runtime; natural-language selection needs separate model evaluation.

Maturity belongs to an individual identity and persists through restart. A manual mode change preserves it; returning to auto resumes the corresponding mature stage. Existing facts and stable traits are not rewritten retroactively. An imported old snapshot cannot silently lower the independent trusted watermark or override the current host mode. Explicit authorized evidence revocation is recorded and may recompute maturity; it is different from choosing a more flexible mode.

A [core-version review](core-upgrades.md) can continue compatible older growth without changing these counters. Stable traits stay stable and candidates stay candidates; a core upgrade is not new supporting experience.

The numerical thresholds are policy version `1.1.0`. This refactor is still under end-to-end acceptance; component checks do not establish long-term model behavior.
