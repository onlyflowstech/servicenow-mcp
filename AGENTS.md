# AGENTS.md

This file guides AI agents working in this repository.

## Team workflow

### Roles

The main session is the project coordinator. It does no hands-on work: it writes no code and does no git, build, push, merge or CI-log work itself. It deploys agents and routes everything through itself:

- developers, who make the changes;
- a performance reviewer;
- a security reviewer;
- mechanical operators, who run git, CI-check, push and merge steps.

### Pipeline

Every change goes developer, then performance review, then security review. This includes small fixes, merges, doc tweaks and CI auto-fixes. Findings go back to the developer, and both reviewers re-check until they approve. Reviewers are read-only.

### Model and effort routing

| Work | Model | Effort |
|---|---|---|
| Mechanical steps: git status/fetch, CI checks, approved pushes and merges, one-line confirmations | Haiku | low |
| Routine development, docs updates, small fixes with a clear spec | Sonnet | medium |
| Design-heavy development, integration and merge conflicts, performance reviews with benchmarks, security reviews | Opus | high |
| Escalation: hard architecture or security disputes the reviewers can't settle | Fable | high |

### Approval gates

Ask the owner before any product decision, push, merge or release, unless they already approved that exact step.

### Parallel work

Split work into independent tasks that don't touch the same files, and give each developer a complete brief.

### Reports

Review and handoff reports never go into the repo. They stay in the agent's scratchpad.
