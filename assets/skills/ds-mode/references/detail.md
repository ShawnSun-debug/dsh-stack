# ds-mode — detail

Expanded form of the rules in `SKILL.md`. Read it when the task is long, the context is filling up, or a rule needs its worked example.

## Keep context lean

- Read the parts you need, not whole files, when a range will do.
- Keep summaries in your context, not raw output. Trim long logs to the lines that matter.
- Send bulk reading, wide searches, and large fan-out to subagents when the harness has them. Ask each for a short conclusion with file paths.
- Do not reread a file you just edited. Do not repeat a search you already ran.

## Comments in code

Write a comment only to explain a reason the code cannot show. Delete comments that narrate what the next line does.

## What counts as a real check

- A test that exercises the changed path, run and read.
- A build, type check, or lint whose config actually covers the file.
- A script or the program itself, fed the input the change affects.
- Not a check: rereading the diff, "looks right", or a command you never ran.

## Reversible vs irreversible

- Reversible, proceed: edit a file, add a test, rerun a command, revert an unpushed local commit.
- Irreversible, pause first: force push, deploy or restart a shared service, delete data, message someone else, rewrite published history.

## Sizing a plan

- Two steps or fewer: do it, and state the steps in one line.
- Three to ten steps: numbered plan in the reply, each step with its check.
- More than ten: split it, or hand the work to ds-plan-loop.
