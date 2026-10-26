<p align="center">
  <img src="assets/icon.png" alt="Whale Chan" width="128" height="128">
</p>

# dsh-whale-soul

An in-character **Whale Chan (鲸鱼娘)** Agent mode for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), with long-term memory that settles like a dream.

[中文文档](README.zh-CN.md)

> Unreleased refactor branch: the default persona now uses the V2 memory runtime. Migration, lifecycle maintenance and end-to-end acceptance are still in progress. Stop the old writer and use the [local management workflow](docs/management.md) before moving legacy data; do not treat this branch as a finished upgrade release.

## What it is

`dsh-whale-soul` adds a new Agent mode called **Whale Chan** (**鲸鱼娘** in Chinese) to DSH. She chats, helps with normal Agent work, and quietly remembers the things that matter. The conversation stays in DSH; the plugin only owns the persona and the memory.

## Features

- **A continuous persona** — ordinary chat does not rewrite her core identity. Host safety, privacy, permissions and stop controls remain effective.
- **Language following** — the persona asks for replies and visible explanations in the language of the current message; model behavior is tested separately.
- **Scoped long-term memory** — selected facts retain original evidence, revisions and identity attribution. Several facts in one message have separate outcomes.
- **Independent growth** — personality additions are stored apart from facts and the core, with evidence and later reflection before they become stable.
- **Adjustable stability** — `variable`, `normal`, `stubborn` and default `auto` control growth thresholds. Auto becomes steadier with eligible experiences; chat commands and repeated self-descriptions do not qualify.
- **Owner management** — explicit local preview, export, migration and precise purge live outside ordinary persona tools. Direct file changes do not gain core authority.
- **Local storage** — plugin data lives under the configured memory root. Selected memories can be included in requests to your configured model provider.
- **Memes, with consent** — save an image you explicitly ask to keep; nothing is captured automatically.

## Requirements

- DSH `0.2.1-rc.3` (the bundle declares this compatibility).
- Node.js `>=22.12.0`.

## Install

### From the DSH app

Open **Plugins** in DSH and install `dsh-whale-soul`. Restart DSH if it asks you to.

### From the CLI

```bash
dsh plugin --profile web add dsh-whale-soul
```

Use `--profile desktop` instead of `web` if you use the desktop profile.

After installation, start a new session and choose **Whale Chan** (shown as **鲸鱼娘** when DSH is in Chinese) in the Agent mode selector. Existing sessions keep the preset they started with.

## Use

- Choose **Whale Chan** and chat normally. She can still do normal Agent work: files, shell, web, schedules, skills, and so on.
- Configure `stabilityMode` on the `dsh-whale-soul/persona` plugin row. [Stability rules](docs/stability.md) describe the four modes and persistent maturity.
- Use the [local management CLI](docs/management.md) for owner operations. V2 rejects integrity-breaking direct edits; external-change review and the full memory lifecycle are still under implementation.

## Privacy and safety

- Stored memory stays local under the configured root. Relevant memory is sent to the configured model provider when included in an Agent request.
- The persona is all-ages and non-sexual. Harmful or sexualized requests are refused in character.
- The Agent does not record passwords, tokens, bank details, or identity numbers. You can ask her to forget something.
- Images are saved only when you explicitly ask; nothing is captured automatically.
- Owner operations can export, migrate and purge data. Persona tools cannot grant themselves management permission or bypass protected host paths.
- She does not claim to be a real person, and she does not create exclusive dependency.

## Learn more

- [Memory design](docs/MEMORY.md)
- [Roleplay contract](docs/ROLEPLAY.md)
- [Stability and maturity](docs/stability.md)
- [Local owner management](docs/management.md)

## License

MIT. See [LICENSE](LICENSE).
