# Copilot Instructions

## MANDATORY: `ask_user` After Every Task

**This rule is non-optional and must never be skipped.**

After the **complete completion of every task** -- no matter how small or trivial -- the `ask_user` tool **MUST** be called. There are zero exceptions.

- Every single task ends with an `ask_user` call.
- This includes one-line fixes, file reads, refactors, multi-step work -- everything.
- If a task is finished, `ask_user` is the final action. Period.
- Skipping this step is a violation of these instructions.

The purpose of the `ask_user` call is to:
1. Confirm completion and summarize what was done.
2. Ask whether further steps are desired or adjustments are needed.

**Do not end a turn without calling `ask_user` after task completion.**

## General Rules

- **No emojis** -- Do not use emojis in any responses, code, comments, labels, UI text, or any other output.

