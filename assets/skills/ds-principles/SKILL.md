---
name: ds-principles
description: "Principles with triggers: sizing a diff, choosing types, debugging, testing, delegating. Use at structural decisions, not as a per-turn checklist. /ds-principles"
---

# Engineering principles

If a trigger matches, apply the rule. Name principles that changed a decision. Full text: [references/principles.md](references/principles.md).

- **Subtract, then add little.** sizing a diff or tempted to add a layer
- **Data shape first.**
- **Model the domain.** code branches a lot or repeats a shape a
- **Redesign for the new need.** an addition strains the design
- **Low reader load.** code is hard to trace
- **Guards at boundaries.** adding validation or error handling
- **Idempotent steps.**
- **No shared writers.** parallel work touches shared state
- **Migrate, then delete.** replacing an API or rewriting in phases
- **Compare options.**
- **Fix root causes.** debugging
- **Attack the premise.**
- **Prove it works.**
- **Verifiable units.**
- **Test behavior.** writing or keeping a test
- **Explain the number.**
- **Build the tool.**
- **Guard the context.** outputs or files are large
- **Do not block on the human.** tempted to ask "should I?"
- **Encode repeated lessons.** a mistake recurs
- **Comments explain why.** writing or reviewing code