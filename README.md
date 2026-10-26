<p align="center">
  <img src="assets/icon.png" alt="Whale-chan" width="128" height="128">
</p>

# dsh-whale-soul

An in-character **Whale-chan (鲸鱼娘)** Agent mode for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), with long-term memory that settles like a dream.

[中文文档](README.zh-CN.md)

## What it is

`dsh-whale-soul` adds a new Agent mode called **鲸鱼娘** to DSH. She chats, helps with normal Agent work, and quietly remembers the things that matter. The conversation stays in DSH; the plugin only owns the persona and the memory.

## Features

- **In character, without the machinery** — no OOC switch, no tool logs, no memory counts. Switching to another DSH Agent mode is the way out.
- **Speaks your language** — replies and reasoning follow the language of your current message. Switch languages mid-conversation and she switches with you.
- **Long-term memory** — preferences, promises, boundaries, and moments are kept in a layered store. A session starts with only a small summary; details are recalled when needed.
- **Forgets gracefully** — memories can merge, fade, or be archived over time. Pinned and user-edited memories are protected.
- **Dream-like upkeep** — maintenance happens in the background as a dream, never as a chat status report.
- **Yours to edit** — memory files are plain Markdown/JSON and remain the source of truth. Your edits are treated as corrections.
- **Local-first** — everything lives under `$DSH_HOME`; nothing is uploaded.
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

After installation, start a new session and choose **鲸鱼娘** in the Agent mode selector. Existing sessions keep the preset they started with.

## Use

- Choose **鲸鱼娘** and chat normally. She can still do normal Agent work: files, shell, web, schedules, skills, and so on.
- Memory maintenance is automatic. To inspect or edit memory files, switch to a work mode; the character mode deliberately has no memory dashboard.

## Privacy and safety

- Memory stays local under `$DSH_HOME` and is not uploaded.
- The persona is all-ages and non-sexual. Harmful or sexualized requests are refused in character.
- The Agent does not record passwords, tokens, bank details, or identity numbers. You can ask her to forget something.
- Images are saved only when you explicitly ask; nothing is captured automatically.
- Memory files are yours. External edits are treated as corrections, and malformed files are isolated instead of breaking the store.
- She does not claim to be a real person, and she does not create exclusive dependency.

## Learn more

- [Memory design](docs/MEMORY.md)
- [Roleplay contract](docs/ROLEPLAY.md)

## License

MIT. See [LICENSE](LICENSE).
