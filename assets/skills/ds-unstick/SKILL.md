---
name: ds-unstick
description: "Name the assumption behind the failed fixes, test it, list three other approaches, restart. Use after the same failure twice. /ds-unstick"
---

# ds-unstick

When two fixes fail the same way, the problem is usually a wrong belief, not a wrong edit. Find that belief and test it.

## Steps

1. Stop editing. Do not try a third variation of the same fix.
2. Write down each failed attempt in one line: what you changed and what happened, with the exact error text.
3. Write the assumption that all of those attempts shared. Typical: "this file is the one that runs", "the config is loaded", "the error comes from my code". Name one, in one sentence.
4. Test that assumption with the cheapest probe that answers yes or no: a print statement, a log line, `which` or `--version`, a grep for the real call site, a minimal script, or the docs for the installed version. Paste the result.
5. If the assumption is false, you have found the real problem. Plan the fix from the new fact.
6. If the assumption holds, list 3 different approaches: another mechanism, library, layer or data path, not a tweak of the same edit. One line each on cost and risk.
7. Pick one approach and say why in one sentence.
8. Restart from a clean state if the failed attempts left debris: revert them with git (`git stash` or `git checkout -- <files>`), then apply only the chosen approach.
9. Record the false assumption or the chosen approach in PROGRESS.md (see ds-context-reset) so a later session does not repeat the attempts.
10. Return to ds-verify-loop with the new approach.

## Stop when

- The probe in step 4 explains the failure, or the new approach passes its check.
- Two rounds of this skill have failed. Stop and report to the user: the attempts, the assumptions you tested, and the evidence. Ask for direction.

## Rules

Do not repeat a failed fix, even with small changes. Evidence beats reasoning, so run the probe. Keep the failed-attempt list. Start a new approach from a clean state. Expanded rules and probe examples: `references/detail.md`.
