# Jinn Fork Constitution

This document governs **`harrytwigg/jinn`**, a permanent fork of `hristo2612/jinn`.
It is the ratified statement of how work is proposed, reviewed, and accepted here. Where a
principle below is a compression of an existing rule, the operative text is
[`AGENTS.md`](../../AGENTS.md); this constitution does not restate it, it binds to it.

## Core Principles

### I. This fork does not return upstream (NON-NEGOTIABLE)

**No change made in this repository is ever submitted to `hristo2612/jinn`.** There is no
upstreaming plan, no eventual pull request, no "keep it clean so it can go back later." The
`upstream` remote is a **read-only** source of changes to merge *in*; it is never a push or
pull-request target.

What this licenses:

- Divergence is a design option, not a debt. A change may contradict upstream's direction,
  delete an upstream feature, or restructure an upstream file, and that costs nothing here.
- Fork-local files (`.specify/`, this constitution, fork-only packages and docs) are
  first-class. They are not "carried patches" awaiting cleanup.
- Merge conflicts against `upstream/main` are paid at merge time by whoever merges. They are
  not a reason to avoid a local change that is otherwise right.

What this does **not** license:

- Lowering the review bar. Every other principle in this document applies in full. A fork that
  never upstreams is a fork with no second reviewer downstream — the rubric is the only gate
  left, so it gets *more* weight here, not less.
- Silently dropping the provenance. Upstream's `LICENSE` and attribution stay intact.

Any proposal, plan, or spec that reasons about "what upstream would accept" has reasoned about
the wrong repository. Say what is right for this fork.

### II. Verify the premise before you fix it

A ticket records what someone believed when they wrote it. No fix ships without a reproduction
on current `main` (the command and its real output), the exact `file:line` where the bug
manifests, and evidence that the change alters *that line's* behaviour. A claim that a state is
now unreachable needs a red test: write it, revert the fix, watch it fail, restore the fix,
watch it pass. When the premise has moved — the line the ticket calls wrong has since become
right — record the finding and leave the line. See `AGENTS.md` §1.

### III. Climb the Footprint Ladder from the bottom

Every core MCP tool ships its name, description, and full input schema to the model on every
call, for every employee, forever. That budget is enforced by
`packages/jinn/src/mcp/__tests__/tool-manifest-budget.test.ts` (`MAX_MANIFEST_TOKENS`, and a
pinned tool count), and the manifest sits close enough to the ceiling that a verbose
description turns the suite red rather than warning.

Take the lowest rung that solves the problem: (1) extend something that exists, (2) a CLI
command or a Markdown skill — both cost zero context, (3) a gated MCP tool, (4) an
out-of-process MCP server under `mcp.custom`, (5) a new core tool. Rung 5 is the last resort
and the only rung that taxes every session in the company; taking it requires the token
arithmetic against the current budget **read from the test file, not quoted from memory**, and
an argument for why rungs 1–4 fail. `context-diet.test.ts` states the bar: a read tool that
shrinks no prompt does not ship. See `AGENTS.md` §2.

### IV. No speculative infrastructure

No hook, config key, abstraction layer, strategy interface, or extension point without a named
consumer that exists in this tree today. One caller is not a pattern — extract the helper on
the second. One strategy is not a strategy pattern. A config key nobody sets is a branch nobody
tests. This is a ban on guessing, not on design: name the concrete consumer and the
conversation becomes whether the abstraction is the right one.

The reviewer's side binds equally: *"you should have made this extensible"* is not a valid
finding unless a second consumer exists. See `AGENTS.md` §3.

### V. Tests that can fail for a reason

Branching logic, parsing, state transitions, and boundary conditions get tests. Glue and
pass-through wrappers do not. Coverage is a floor against regression, not a target.

Change-detector tests are banned. Ask of every assertion: *if this fails, have I learned that
something is broken, or only that something is different?* If it is the second, delete it.
Restating a constant, hand-copying a list the source already derives, and asserting a number
equals itself all fail that question. No snapshot tests.

Source-reading architecture tests are allowed **deliberately**, and only when all three hold:
the invariant genuinely cannot be executed; it asserts on meaning rather than formatting; and
no other tool already enforces it. Windows is a required CI leg and is not decorative — a
timed-out hook marks a file's tests SKIPPED rather than failed, so a slow suite can vanish
while the run stays green. See `AGENTS.md` §4.

### VI. A plan opens with a `file:line` table

Before a plan proposes anything, it lists the infrastructure that already exists in the area it
is about, as a table of `path:line` entries and what each one is. Cite the line, not the file —
a file reference proves nothing was opened. Every reference must resolve, and **references
rot**: re-verify them against the tree immediately before handing the plan over. Include what
you found and rejected, not only what you will use. Numbers get their source; a pinned constant
with its path is a fact, "the budget is tight" is a feeling. See `AGENTS.md` §5.

Under the spec-kit workflow this applies to `plan.md` in full, and to any `spec.md` that makes
a claim about what the tree currently does.

### VII. Comments explain why, and stay true

A comment records the constraint and where it came from — the incident, the ticket, what breaks
if the line is removed. It never narrates the line below it. A comment restating its own line,
a section divider, an unowned `TODO`, or commented-out code does not earn its place.

**A comment your own change makes false is part of your change.** If a diff falsifies a
comment, a doc line, or an error message, it is fixed in the same diff. Leaving it and
reporting it ships a lie. See `AGENTS.md` §6.

## Hard Constraints

**This repository is public and publishes to npm.** Everything under `packages/**` reaches
strangers, including `packages/jinn/template/**` and test files, which compile into `dist/` and
ship in the tarball. No real names, client names, emails, API keys, chat workspace IDs, or
absolute home-directory paths go anywhere in this tree. Anything personal is read at runtime
from the instance home, never hardcoded.
`packages/jinn/src/shared/__tests__/privacy-guard.test.ts` scans the shipped trees and fails the
build on a match. **Principle I does not relax this** — a fork that never upstreams is still a
public repository that publishes.

Four commands gate a change, each a required CI job in `.github/workflows/ci.yml`:

```bash
pnpm typecheck
pnpm lint
pnpm test     # ubuntu and windows, both required
pnpm build
```

The `upstream` remote is read-only (Principle I). Merges flow `upstream/main` → `origin/main`
and never the other way.

## Development Workflow

Spec-kit drives feature work from `.specify/`:

| Step | Command | Produces |
| --- | --- | --- |
| Principles | `/speckit-constitution` | this file |
| Specification | `/speckit-specify` | `specs/<feature>/spec.md` |
| De-risking (optional) | `/speckit-clarify` | clarifications folded into `spec.md` |
| Plan | `/speckit-plan` | `specs/<feature>/plan.md` — opens with the `file:line` table (Principle VI) |
| Tasks | `/speckit-tasks` | `specs/<feature>/tasks.md` |
| Consistency (optional) | `/speckit-analyze` | cross-artifact report |
| Implementation | `/speckit-implement` | the change |

The Constitution Check gate in `.specify/templates/plan-template.md` is evaluated against the
Core Principles above. A plan that reaches rung 5 of the Footprint Ladder, adds an abstraction
with one consumer, or proposes a change-detector test must either justify it in the plan's
Complexity Tracking section or be revised.

Spec-kit governs *how a change is proposed*. `AGENTS.md` governs *whether it is accepted*. A
green spec-kit run is not a review.

## Governance

This constitution supersedes ad-hoc practice within this fork. Where it and `AGENTS.md`
disagree, `AGENTS.md` wins on review substance and this document wins on fork identity and
process — and the disagreement is itself a defect to be resolved in the next amendment.

Amendments are ordinary commits to this file. Each one states what changed and why, and bumps
the version: MAJOR for removing or redefining a principle, MINOR for adding one or materially
expanding a section, PATCH for wording and reference repair. An amendment that touches
Principle I requires an explicit decision by the repository owner recorded in the commit
message.

Reviewers may fault a change against any principle here. An author may push back on a finding
that cites neither this constitution, `AGENTS.md`, nor a stated requirement.

**Version**: 1.0.0 | **Ratified**: 2026-09-14 | **Last Amended**: 2026-09-14
