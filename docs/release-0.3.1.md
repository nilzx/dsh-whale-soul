# 0.3.1 Cross-platform persona startup

[中文](release-0.3.1.zh-CN.md)

Version 0.3.1 fixes Whale Chan startup on Windows and Linux. Version 0.3.0 required a macOS-specific protection layer during persona initialization, which caused other platforms to reject the preset.

Whale Chan now uses DSH's official filesystem, process and sandbox services on every platform. File and command access follows the host's configured permissions. If a command sandbox runner is unavailable, DSH reports that when the command is executed, while the persona and memory can initialize normally.

Update the plugin through DSH's Plugins page, restart if prompted, and open a new Whale Chan session. The update continues using your existing memory. Conversation memory import, personality growth and structured memory writes remain available.

Validation covers Windows, Linux and macOS with Node 22 and 24. All six CI jobs passed 21 tests, including actual persona initialization with official DSH services, memory save/recall, ordinary file access, read-only write refusal and command delegation to the host sandbox. Local Web preset and image checks also passed.
