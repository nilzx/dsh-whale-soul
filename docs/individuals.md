# Individual identity

[中文](individuals.zh-CN.md)

Set `individualKey` on the `dsh-whale-soul/persona` plugin row. Omitting it or using `default` continues the original identity and its legacy binding. A name such as `research` creates or resumes a separate individual within the same persona, subject and memory space. Keys are case-sensitive, contain 1–64 ASCII letters, digits, dots, underscores or hyphens, and must start with a letter or digit.

```yaml
individualKey: research
stabilityMode: auto
memorySpaceId: owner
subjectId: owner
```

This is trusted host configuration. Chat messages and tool arguments cannot select an individual, grant management permission or reset identity. The key is a storage selector; it is not added to the character's prompt. The persona core is unchanged.

Each individual has its own stable random identity, memory visibility, evidence qualifications, maturity, personality additions and integrity heads. Switching `default → research → default` resumes each existing individual. The current host `stabilityMode` still wins over a stored mode; `variable`, `normal`, `stubborn` and `auto` never relax identity, safety, privacy or permission boundaries.

Use a new Session after changing the key. An existing Session already attributed to another individual is rejected, and its host owner and memory-root mirror remain intact. Clearing memory or editing a prompt does not transfer Session ownership. Unknown old Session history is not silently claimed. A genuinely blank, unattributed Session follows the official host behavior until material input seals its owner.

A key is not a portable identity by itself. Preserve the memory space with the explicit owner export/import workflow, including persona and self-integrity state, to resume the same individual on another root or machine. A fresh independent root creates a new random individual even when the key matches. Losing a required anchor produces a repair error rather than silently replacing that individual.
