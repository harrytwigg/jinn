# Jinn Fork Constitution

This document governs **`harrytwigg/jinn`**, a permanent fork of `hristo2612/jinn`.
It is the ratified statement of what this fork is for and how work is proposed, reviewed, and
accepted here.

Principles I and II are fork-local and have no counterpart upstream: they say what this
repository is and what it is aimed at. Principles III–VIII compress the review rubric in
[`AGENTS.md`](../../AGENTS.md), which remains the operative text — this constitution binds to
it rather than restating it.

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
the wrong repository. Say what is right for this fork — which is Principle II.

### II. The direction: a company that runs itself (NON-NEGOTIABLE)

Principle I says what this fork is not. This says what it is for.

Upstream Jinn is an org that a person operates: the human decides what runs, when it runs, and
what it costs. **This fork is aimed at an org that operates itself** — one that picks up work,
decides when to do it, and manages what it spends doing it, with the human setting policy
rather than pressing start. The centre of gravity is autonomous development: agents doing the
coding work, and the system deciding when that work happens.

The question a proposal has to answer: **does this move a decision from the operator to the
system?** Ranked roughly by how much it does:

1. Work starts without a human starting it — on a schedule, a trigger, a condition, or spare
   capacity.
2. The system chooses *when* to spend what it has, and defers or promotes work accordingly.
3. The system closes a loop the operator currently closes by hand.
4. The operator gets a better view of a decision they still have to make themselves.

Rung 4 is not forbidden — the system cannot be trusted with a decision nobody can see — but a
proposal that stops there should say why it stops there.

**Capacity is a scheduling input, not a dashboard.** The scarce resource here is model capacity
inside a window that refreshes: rate-limit windows, plan quotas, credits with a reset time.
Capacity unspent before the window rolls is capacity destroyed. A system that holds both a
backlog of low-priority work and hours of unspent quota, and does neither because nobody typed
a command, is the specific waste this fork exists to remove.

**The primitives already exist; the wire between them does not.** Verified against the tree at
the commit that amended this document:

| `path:line` | What it is |
| --- | --- |
| `packages/jinn/src/shared/engine-limits.ts:310` | `collectEngineLimits` — per-engine windows, credits, and buckets |
| `packages/jinn/src/shared/engine-reset-times.ts:55` | `claudeResetsAtSeconds` — when a window reopens, best-effort by construction |
| `packages/jinn/src/shared/engine-health.ts` | `recordExhaustedWindows` — exhaustion is already durable state |
| `packages/jinn/src/cron/scheduler.ts:24` | `startScheduler` — a real scheduler, wall-clock only (`node-cron`, `:1`) |
| `packages/jinn/src/heartbeats/scheduler.ts:71` | `startHeartbeatScheduler` — durable timers with claim/advance/disarm |
| `packages/jinn/src/workflows/trigger-service.ts` | work started by condition rather than by hand |
| `packages/jinn/src/plugins/runtime.ts:17` | `startPluginRuntime`, started from `gateway/server.ts:80` — a permissioned host for out-of-tree behaviour |

The gap is the join. Every consumer of `collectEngineLimits` outside `shared/` is display or
refresh — `cli/limits.ts`, `gateway/api.ts`, `gateway/background-refresh.ts`. The cron
scheduler imports nothing from it. **The system can see its capacity and it can run things on a
timer, and those two facts have never been connected to each other.** Work in this direction is
therefore rung 1 of the Footprint Ladder far more often than it looks: extend what is there,
and say in the plan's `file:line` table which of the rows above you are joining.

**What this de-prioritises.** Measurement for its own sake is upstream's interest, not this
fork's. The experiment subsystem is the concrete case: six core MCP tools
(`packages/jinn/src/mcp/experiment-tools.ts:62,98,121,131,153,176`) shipped unconditionally to
every session at `packages/jinn/src/mcp/server.ts:125`. It is maintained where it already
exists and it is not extended. When manifest budget blocks direction work, it is the first
place to look for the tokens — gate it behind a config key (rung 3) or remove it. Principle I
means neither needs upstream's agreement.

What this does **not** license:

- **Unbounded spend.** A system that starts its own work needs a stated ceiling and a way for
  the operator to stop it. "It was using spare capacity" is not a defence for an unbounded
  loop. The bound is part of the feature, not a follow-up.
- **Illegibility.** Autonomy raises the bar on being able to reconstruct what happened and why:
  what ran, what it cost, what it decided, and what it decided *against*. A decision the
  operator cannot audit after the fact is not delegation, it is a black box.
- **Speculative autonomy.** Principle V applies unchanged. Direction is not a licence to build
  an extension point for an autonomous consumer that does not exist yet.

### III. Verify the premise before you fix it

A ticket records what someone believed when they wrote it. No fix ships without a reproduction
on current `main` (the command and its real output), the exact `file:line` where the bug
manifests, and evidence that the change alters *that line's* behaviour. A claim that a state is
now unreachable needs a red test: write it, revert the fix, watch it fail, restore the fix,
watch it pass. When the premise has moved — the line the ticket calls wrong has since become
right — record the finding and leave the line. See `AGENTS.md` §1.

### IV. Climb the Footprint Ladder from the bottom

Every core MCP tool ships its name, description, and full input schema to the model on every
call, for every employee, forever. That budget is enforced by
`packages/jinn/src/mcp/__tests__/tool-manifest-budget.test.ts` (`MAX_MANIFEST_TOKENS`, and a
pinned tool count), and the manifest sits close enough to the ceiling that a verbose
description turns the suite red rather than warning.

Take the lowest rung that solves the problem: (1) extend something that exists, (2) a CLI
command or a Markdown skill — both cost zero context, (3) a gated MCP tool, (4) an
out-of-process MCP server under `mcp.custom`, or the in-repo plugin host at
`packages/jinn/src/plugins/`, (5) a new core tool. Rung 5 is the last resort and the only rung
that taxes every session in the company; taking it requires the token arithmetic against the
current budget **read from the test file, not quoted from memory**, and an argument for why
rungs 1–4 fail. `context-diet.test.ts` states the bar: a read tool that shrinks no prompt does
not ship. See `AGENTS.md` §2 — noting that its claim that no in-repo plugin system exists is
stale, and that rung 4 is wider here than it says.

### V. No speculative infrastructure

No hook, config key, abstraction layer, strategy interface, or extension point without a named
consumer that exists in this tree today. One caller is not a pattern — extract the helper on
the second. One strategy is not a strategy pattern. A config key nobody sets is a branch nobody
tests. This is a ban on guessing, not on design: name the concrete consumer and the
conversation becomes whether the abstraction is the right one.

The reviewer's side binds equally: *"you should have made this extensible"* is not a valid
finding unless a second consumer exists. See `AGENTS.md` §3.

### VI. Tests that can fail for a reason

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

Autonomy sharpens this one. A scheduler, a budget check, or a deferral rule is branching logic
over time and exhaustion — the clock and the capacity source are injected, and the interesting
cases (window rolls mid-run, quota exhausted, two jobs due at once) are tested, not observed in
production.

### VII. A plan opens with a `file:line` table

Before a plan proposes anything, it lists the infrastructure that already exists in the area it
is about, as a table of `path:line` entries and what each one is. Cite the line, not the file —
a file reference proves nothing was opened. Every reference must resolve, and **references
rot**: re-verify them against the tree immediately before handing the plan over. Include what
you found and rejected, not only what you will use. Numbers get their source; a pinned constant
with its path is a fact, "the budget is tight" is a feeling. See `AGENTS.md` §5.

Under the spec-kit workflow this applies to `plan.md` in full, and to any `spec.md` that makes
a claim about what the tree currently does. The table in Principle II is the starting point for
anything in the fork's direction, and is itself subject to rot.

### VIII. Comments explain why, and stay true

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
| Plan | `/speckit-plan` | `specs/<feature>/plan.md` — opens with the `file:line` table (Principle VII) |
| Tasks | `/speckit-tasks` | `specs/<feature>/tasks.md` |
| Consistency (optional) | `/speckit-analyze` | cross-artifact report |
| Implementation | `/speckit-implement` | the change |

The Constitution Check gate in `.specify/templates/plan-template.md` is evaluated against the
Core Principles above. A plan must state which rung of Principle II's ranking it reaches and
why it stops there. A plan that reaches rung 5 of the Footprint Ladder, adds an abstraction
with one consumer, or proposes a change-detector test must either justify it in the plan's
Complexity Tracking section or be revised.

Spec-kit governs *how a change is proposed*. `AGENTS.md` governs *whether it is accepted*. A
green spec-kit run is not a review.

## Governance

This constitution supersedes ad-hoc practice within this fork. Where it and `AGENTS.md`
disagree, `AGENTS.md` wins on review substance and this document wins on fork identity,
direction, and process — and the disagreement is itself a defect to be resolved in the next
amendment.

Amendments are ordinary commits to this file. Each one states what changed and why, and bumps
the version: MAJOR for removing or redefining a principle, MINOR for adding one or materially
expanding a section, PATCH for wording and reference repair. An amendment that touches
Principle I or Principle II requires an explicit decision by the repository owner recorded in
the commit message.

Reviewers may fault a change against any principle here. An author may push back on a finding
that cites neither this constitution, `AGENTS.md`, nor a stated requirement.

**Version**: 1.1.0 | **Ratified**: 2026-09-14 | **Last Amended**: 2026-09-14
