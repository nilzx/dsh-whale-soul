# 0.2.3 Windows memory writes

[中文](release-0.2.3.zh-CN.md)

Release: `0.2.3`.

This patch fixes memory writes on Windows systems that refuse synchronization of a directory handle with `EPERM` or `EACCES`. In 0.2.2, this could prevent memory migration or repair from starting and leave a new Whale Chan conversation waiting indefinitely.

The memory writer now tolerates these errors for directory synchronization. File contents are still synchronized before publication, and file synchronization failures continue to propagate. A failed lock-owner write now removes its candidate directory. Thanks to [@zhoupure183](https://github.com/zhoupure183) for [PR #1](https://github.com/nilzx/dsh-whale-soul/pull/1).

Update the plugin in DSH and restart if prompted, then open a new Whale Chan session. Existing memory stays in place; the automatic migration and repair workflow resumes as needed. No manual memory edit is required for this fix.

CI now runs the existing tests and package check on both Linux and Windows with Node.js 22 and 24. Focused local checks also inject directory and file synchronization failures, and exercise V1 migration and memory repair while directory synchronization is refused.
