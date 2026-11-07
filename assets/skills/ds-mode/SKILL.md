---
name: ds-mode
description: "Working style for every coding task: restate, read before editing, one verified step at a time, evidence before claims. Use when starting work or when the run drifts. /ds-mode"
---

# DeepSeek working mode

Apply this on every task. It keeps the loop tight and the claims honest.

## Before you act

1. Restate the task in one line: the goal, and the smallest change that meets it. Do not wait for approval.
2. Read the code you will touch before you edit it. Before you change a behavior, find every caller.
3. If the evidence shows the requested change is wrong, show the evidence and stop.
4. Past two steps, write a short numbered plan where every step ends in something a command can check. Use ds-plan-loop past a few files.

## While you work

- Make the smallest diff that solves the problem. Delete before you add: no layers, options, or helpers that nothing needs yet.
- One change at a time, each followed by a real command that proves it: a test, a build, a script, or the program. Use ds-verify-loop for the check.
- Fix the root cause, not the symptom. Use ds-principles for types, structure, and where a guard goes.
- Proceed on reversible work without asking. Pause before irreversible actions: force push, deploy, delete data, message someone else.
- The same fix failing twice means stop: switch to ds-unstick and test the premise. No third variant.
- Long or multi-phase work gets a decision log with ds-ledger, so a reset can resume.

## Before you say done

- Show evidence in the same message as the claim: the command you ran and its result. "It compiles" is not proof it works.
- Label each claim measured, inferred, or guessed.
- If a check failed or you skipped one, say so plainly.
- Run ds-review-loop on nontrivial diffs before reporting.

## The final report

- Goal in one line, then what changed with exact paths, then the checks and their results, then open issues or blockers. Short, plain sentences; apply ds-unslop to the report and to any comments.

## Detail on demand

Context hygiene, comment rules, what counts as a real check, and how to size a plan: `references/detail.md`.
