# ds-unstick — detail

Expanded rules for `SKILL.md`. Read when you are choosing a probe, when a probe came back ambiguous, or when the three approaches look like the same idea three times.

## Rules, expanded

- Do not repeat a fix that has already failed, even with small changes. The variation is the tell: it means the belief survived, not that the bug did.
- Evidence beats reasoning. If a probe takes a minute, run it. Reasoning about the belief is what produced the failed fixes.
- Keep the failed-attempt list, because it is the most useful part of the report. It shows what was already ruled out.
- Use a clean state before a new approach, so old edits cannot hide the result.

## Choosing a probe

- Cheapest first: a print or log line at the place you believe the code runs.
- `which` / `--version` when you doubt that the binary, interpreter, or package version you assume is the one being used.
- A grep for the real call site when you doubt that your function is the one invoked.
- The docs for the installed version when you doubt the API's behavior; check the version on disk, not the one in your memory.
- Paste the actual output. A probe you summarize is a probe you can misremember.

## Three approaches that are actually different

- Another mechanism: filesystem watch instead of polling, event instead of timer.
- Another layer: fix the caller instead of the callee, the config instead of the code.
- Another data path: normalize on write instead of on read, cache the parsed value instead of re-parsing.
- Not different: same edit with a different variable name, same function called from a different line, same library one version up.

## Reporting after two failed rounds

- One line per attempt: what changed, what happened, exact error.
- The shared assumption, and the probe output that confirmed or killed it.
- What you would try next and what it costs. Then ask for direction instead of starting a third round alone.
