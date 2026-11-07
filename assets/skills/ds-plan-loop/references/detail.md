# ds-plan-loop — detail

Expanded rules for `SKILL.md`. Read when a plan is large, when a step keeps failing its check, or when you want the worked example of a good step.

## Rules, expanded

- No step without a check. "Looks right" is not a check. If you cannot name the command or observation that proves a step, the step is not ready.
- One step per diff. Do not batch steps to save time; a batched diff hides which step broke.
- Do not add steps the goal does not need. Scope creep in the plan becomes scope creep in the diff.
- Keep the plan at about 3-10 steps. Bigger work gets split into separate plans, each with its own goal.

## A good step, and a bad one

- Good: "Add `auth.expired` handling in `lib/session.js`; check: `npm test -- session` passes and the expired-token case appears in the output."
- Bad: "Refactor auth"; nothing to run, nothing to read, and no way to say done.
- Good: "Point the CLI at the new endpoint; check: `node bin/cli.js --ping` prints `pong` from the new host."
- Bad: "Update config"; which file, which key, and what proves it took effect?

## Running the critique well

- Give the critic only the goal and the plan. If it sees the code first, it starts agreeing with the plan.
- Ask for missing steps, unverified assumptions, and simpler paths. Three questions, not a general review.
- A critique that returns "looks fine" is usually a critique that read the plan as the author.
- Two rounds is the cap. The third round rarely finds anything new; execute instead.

## When to skip the plan

- Two steps or fewer, each already checkable: just do it, and say the steps in the reply.
- The work is exploratory and the next step depends on what the last one showed: use ds-unstick or ds-context-reset instead, and keep a short note per step.
