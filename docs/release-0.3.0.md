# 0.3.0 Conversation memory

[中文](release-0.3.0.zh-CN.md)

Version 0.3.0 adds `/whale-remember-session`, a Skill for retaining useful content from a selected DSH conversation.

In a Whale Chan session, provide a conversation ID or DSH session reference. Name a topic to retain only related information, or let the Agent select lasting facts, preferences, plans and meaningful experiences. The default mode chooses a concise summary or useful detail; you can also ask explicitly for either. See the [conversation memory guide](session-memory.md) for examples.

Facts are grounded in the user's own statements. Detailed memory uses selected original user excerpts; unconfirmed assistant suggestions do not become adopted steps. Related fragments are grouped, existing records are compared together to avoid duplicate imports, and names and preferred forms of address remain available in the current user's small memory context. Source IDs and execution receipts stay outside memory prose. Importing does not earn personality maturity or change the persona core.

Update the plugin through DSH's Plugins page, restart if prompted, and open a new Whale Chan session. Updating from 0.2.x keeps the memory format, default location and existing records; no manual file conversion or clearing is required. The earlier [automatic repair workflow](release-0.2.1.md) continues to handle old layouts and damaged memory data.

Validation includes a fixed 14-round Web conversation with focused and automatic extraction, repeat import with no new records, and recall from a new session. The plugin still uses the currently configured model route; longer conversations can require several model calls.
