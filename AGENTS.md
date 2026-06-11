# Repository Guidelines

## Do not patch symptoms
- When fixing bugs, do not add quick workarounds whose only purpose is to make the current case pass.
- Treat such changes as a temporary stub, not a real solution.
- Your goal is to find and fix the actual root cause of the error. Before changing code, investigate why the failure happens, where the incorrect assumption is, and what part of the system is responsible.

Avoid fixes like:
- swallowing errors without understanding them
- adding special cases just to satisfy one scenario
- forcing values into a valid shape without knowing why they are invalid
- retrying, ignoring, or bypassing failing logic
- making the code “just work” while leaving the underlying issue unresolved

A correct fix should explain and address the real cause of the bug, not merely hide its effects.