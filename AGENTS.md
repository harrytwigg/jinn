# AGENTS.md

The review rubric for this repository. It applies to humans and to agents; a reviewer may
fault a change against a rule written here, and an author may push back on a finding that
cites nothing here and no stated requirement.

Jinn is a pnpm + turbo monorepo: a gateway daemon and CLI (`packages/jinn`), a React web
dashboard (`packages/web`), and a shared event contract (`packages/gateway-events`).

**This is a permanent fork. Nothing here goes back upstream.** `harrytwigg/jinn` diverges from
`hristo2612/jinn` on purpose and forever: there is no upstreaming plan and no eventual pull
request. The `upstream` remote is read-only — a source of changes to merge *in*, never a push
or pull-request target. Divergence from upstream is therefore not a defect and not a finding.
Do not argue a change down to what upstream would accept; argue it against the rules below.
The full statement is [`.specify/memory/constitution.md`](.specify/memory/constitution.md),
Principle I.

**This repository is public and publishes to npm.** Everything under `packages/**` reaches
strangers, including `packages/jinn/template/**` (the files that seed a new user's instance
home) and test files (they compile into `dist/` and ship in the tarball). No real names,
client names, emails, API keys, chat workspace IDs, or absolute home-directory paths go
anywhere in this tree. Anything that must be personal is read at runtime from the instance
home, never hardcoded. `packages/jinn/src/shared/__tests__/privacy-guard.test.ts:9` scans the
shipped trees and fails the build on a match.

Four commands gate a change, and each one is a CI job in `.github/workflows/ci.yml`:

```bash
pnpm typecheck   # ci.yml:27
pnpm lint        # ci.yml:39
pnpm test        # ci.yml:81 — ubuntu and windows, both required
pnpm build       # ci.yml:109
```

---

## 1. Verify the premise

A ticket describes what someone believed at the time they wrote it. Before you fix it,
establish that it is still true.

**No fix ships without three things:**

1. A reproduction on current `main` — the command, and its real output.
2. The exact `file:line` where the bug manifests. Not the area. The line.
3. Evidence that your change alters *that line's* behaviour.

**A claim of impossibility needs a red test.** If you say a hole is now closed, a state is
unreachable, or an input can no longer forge a result, write the test, revert your fix, and
watch it fail. Put the fix back and watch it pass. Without that round trip you have written a
test that asserts your implementation exists — which is indistinguishable from one that
asserts the hole is shut, right up until the day it isn't.

**When the premise has moved, say so and stop.** A ticket claiming a doc line is wrong, where
the line has since become right, does not license editing it. Changing a true line to satisfy
a stale ticket ships a regression with a green checkmark on it. Record the finding, leave the
line, and do the rest of the work.

The same applies to numbers a ticket hands you. A count from a grep is a count of grep hits,
not of the thing you meant to count. Reproduce it or do not repeat it — especially in a file
that ships.

---

## 2. The Footprint Ladder

Every core MCP tool ships its name, description, and full input schema to the model on every
single call, for every employee, forever. That is the cost this ladder exists to protect, and
it is enforced, not aspirational:

- `packages/jinn/src/mcp/__tests__/tool-manifest-budget.test.ts:297` — `toHaveLength(69)`.
  Sixty-nine core tools, each pinned by name.
- Same file `:10` — `MAX_MANIFEST_TOKENS = 5477`, a fixed provider ceiling.
- Same file `:58-60` — the attested measurements: `rpc: 4996`, `pi: 5472`, `openai: 5189`.
  **Pi sits five tokens under the ceiling.** A verbose description on a new tool does not get
  a warning; it turns the suite red.
- A default install ships **65** of the 69: Notes is off out of the box
  (`packages/jinn/src/cli/setup.ts:239`, `notesEnabled: false`).

So: climb from the bottom. Take the lowest rung that actually solves the problem.

**Rung 1 — extend something that already exists.** A new field on an existing tool's schema, a
new value in an existing enum, a new branch in an existing handler. Cost: a few tokens, or
none. This is the right answer far more often than it feels like it is.

**Rung 2 — a CLI command, or a skill.** Both cost zero context.
A command goes in `packages/jinn/bin/jinn.ts`; every handler is lazily `import()`ed inside its
action (`:79`), so adding one loads nothing until it runs.
A skill is a Markdown file at `packages/jinn/template/skills/<name>/SKILL.md` — 15 ship today.
`packages/jinn/src/cli/setup.ts:622` copies them into the instance home and
`packages/jinn/src/gateway/watcher.ts:28` symlinks them where engines look. There is no
runtime and no loader: the engine reads the file when it needs it, so an unused skill costs
nothing.

**Rung 3 — a gated MCP tool.** Ships only when something turns it on. Two precedents:

- *Config key.* `packages/jinn/src/mcp/server.ts:125` — `notesEnabled ? buildNoteTools() : []`,
  resolved at startup by `notesEnabledFromConfig` (`:139`), typed at
  `packages/jinn/src/shared/types.ts:911`.
- *Per-session environment.* `packages/jinn/src/mcp/workflow-tools.ts:181` filters
  `workflow_submit_output` and `workflow_extend_deadline` out of the manifest unless the
  session is a workflow attempt; the variable is `packages/jinn/src/mcp/identity.ts:62` and it
  is stamped onto the child at `:208`.

**Rung 4 — a custom, out-of-process MCP server.** Declared under `mcp.custom` in the instance
`config.yaml` and scoped per employee by the persona's `mcp` field
(`packages/jinn/src/shared/types.ts:565`), which `packages/jinn/src/mcp/resolver.ts:30`
(`resolveMcpServers`) reads: `mcp: false` drops every server, an `mcp:` list keeps only the
ids it names (`:58`). Know which way the default falls before you add one — an employee with
no `mcp` field gets every configured server (`:77`), so a new custom server reaches the whole
company until personas scope it out. Documented in
`packages/jinn/template/docs/mcp.md:27`. Either way it costs this repo nothing: the server
lives outside it entirely.

*There is no in-repo plugin system **yet**.* Skills are Markdown with no plugin API, and plugins
are a roadmap line (`README.md:307`) with an accepted design (`.plans/plugins.md`) and nothing
built against it today. Until that design lands, `mcp.custom` is the extension point that
exists, and a plugin is not something you can pick off this ladder.

**Rung 5 — a new core MCP tool.** The last resort, and the only rung that taxes every session
in the company. To take it, show the token arithmetic against the budget above, and show why
rungs 1 through 4 do not work. The bar is already written into the code:
`packages/jinn/src/mcp/__tests__/context-diet.test.ts:9` — *"a read tool that shrinks no
prompt does not ship."* A tool earns its schema by removing more prose from the prompt than it
adds, the way the knowledge index did when it collapsed into a two-line manifest
(`packages/jinn/src/sessions/context.ts:873-880`). The restraint note at
`packages/jinn/src/mcp/server.ts:111-116` is the standing statement of this policy — read it
before proposing rung 5.

Note that the whole toolset attaches all-or-nothing per session
(`packages/jinn/src/mcp/attachment.ts:126`, default on at `:53`). There is no "just for this
one employee" for a core tool. That is what rungs 3 and 4 are for.

---

## 3. Speculative infrastructure is rejected

No hook, config key, abstraction layer, strategy interface, or extension point without a named
consumer that exists in this tree today.

- One caller is not a pattern. Extract the helper on the second caller.
- One strategy is not a strategy pattern.
- "We might want to swap this out" is not a requirement. When someone wants to, they will
  write the seam, and they will know where it goes because they will have two cases.
- A config key nobody sets is a branch nobody tests.

This is not a ban on design. It is a ban on *guessing*, and the cure is cheap: state the
concrete use case. The moment a real consumer is named, the abstraction stops being
speculative and the conversation is about whether it is the right one.

The reviewer's side of this rule: "you should have made this extensible" is not a valid
finding unless a second consumer exists.

---

## 4. Test doctrine

### Banned: change-detector tests

A change-detector fails when the code changes and passes when the code is correct — the same
event. It cannot catch a bug, because it does not know what the code is supposed to do; it
only knows what it currently says. Every one is a tax on the next refactor.

The specimens in this repo, so you can recognise the shape:

- `packages/jinn/src/mcp/__tests__/attachment.test.ts:45-49` — an entire `describe` whose body
  is `expect(JINN_ATTACH_DEFAULT).toBe(true)`. It restates a constant. The `describe` directly
  below it at `:51` tests what the default actually *does*, across every engine, and would
  catch a real flip.
- `packages/web/src/lib/__tests__/nav.test.ts:35-43` — a hand-copied, order-sensitive array of
  hrefs. The very next test (`:46`) derives the same list from the shared source and is
  literally titled *"derived, not a second hardcoded list"*. The first one exists only to be
  updated.
- A constant restatement riding inside an otherwise good test still counts:
  `packages/jinn/src/gateway/__tests__/session-comm-guards.test.ts:129` and
  `packages/jinn/src/mcp/__tests__/session-tools.test.ts:281` are single lines that assert a
  number equals itself, at the end of tests that already prove the behaviour.

Ask of every assertion: *if this fails, have I learned that something is broken, or only that
something is different?* If it is the second, delete it.

(Mock-call-count assertions are **not** on this list. Each one sampled here encodes a real
invariant — that a write happened exactly once, that a retry did not fire. Judge them by the
question above like anything else. There are no snapshot tests in this repo; do not add the
habit.)

### Allowed, deliberately: source-reading architecture tests

Some invariants cannot be executed. "No file in this directory imports the session database",
"the shipped template contains no personal data", "boot does X before Y" — there is no
function to call that returns the answer. Reading the source and asserting on it is the only
way to hold the line, and this repo does it on purpose: **19 test files assert against the
text of a committed repo file, 12 of them reading `.ts`/`.tsx` sources.**

Done right:

- `packages/jinn/src/shared/__tests__/privacy-guard.test.ts:9` — walks the shipped trees and
  fails on a blocked term. No runtime behaviour could ever express this.
- `packages/jinn/src/workflows/__tests__/todo-capability-boundary.test.ts:15` — reads every
  production file in the workflows directory and enforces which ones may touch storage. An
  architectural boundary, checked at the only place it is visible.

The boundary — a source-reading test is legitimate only when **all three** hold:

1. The invariant genuinely cannot be executed. If you can call the function and assert on its
   return value, do that instead.
2. It asserts on *meaning*, not on formatting. Matching a symbol or an import is durable;
   matching indentation is not.
3. No other tool already enforces it.

Failing those, the same three files show what it looks like:

- `packages/jinn/src/gateway/__tests__/server-boot-ordering.test.ts:19-25` compares
  `String.indexOf` offsets in `server.ts` to assert call order, and `:37` pins the exact
  formatting of an arrow function. Moving a call into a helper breaks it without changing boot
  order at all.
- `packages/jinn/src/cli/__tests__/config-seed.test.ts:17` regexes an exact multi-line YAML
  literal, indentation included, out of `setup.ts` — instead of calling the seeding function
  and parsing what it produced.
- `packages/jinn/src/cli/__tests__/workflow-v2-registration.test.ts:42-61` walks the
  TypeScript AST of `bin/jinn.ts` to re-implement a function-length cap and a parameter cap.
  `eslint.config.mjs:30` enforces both for real, on that exact file (`:7` includes
  `packages/jinn/bin/**/*.ts`), and its length cap is stricter. Duplicated enforcement that
  can only drift.

### Where tests are required

Branching logic, parsing, state transitions, and boundary conditions get tests. Glue and
pass-through wrappers do not. Coverage is a floor against regression, not a target
(`packages/jinn/vitest.config.ts:60-65`).

Both packages run Vitest — `packages/jinn/vitest.config.ts:32` (node, `pool: 'forks'` at
`:37`) and `packages/web/vitest.config.ts:9` (jsdom). Windows is a required CI leg
(`.github/workflows/ci.yml:97`), and it is not decorative: a timed-out *hook* marks that
file's tests SKIPPED rather than failed, so a slow suite disappears while the run stays green.
The comment at `packages/jinn/vitest.config.ts:16-25` records the run where roughly 180 tests
went missing that way.

---

## 5. Plans open with a `file:line` table

Before a plan proposes anything, it lists the infrastructure that already exists in the area
it is about, as a table of `path:line` entries with what each one is.

This is not documentation. It is the cheapest way to find out that the thing you were about to
build is already there, that the constant you were going to add has a home, or that the
extension point you wanted exists one rung down the ladder. It is also what makes a plan
reviewable: a reader can open six paths and know whether the author actually looked.

Rules:

- Cite the **line**, not the file. A file reference proves nothing was opened.
- Every reference must resolve — the named symbol or text appears at that line, within a few
  lines of drift. Check them again before you hand the plan over; they rot.
- Include what you found and rejected, not only what you will use. "Rung 3 does not work here
  because X" is the most useful row in the table.
- Numbers get their source. `MAX_MANIFEST_TOKENS = 5477` with its path is a fact; "the token
  budget is tight" is a feeling.

Every `file:line` in this document was verified against the tree at the commit that added it.

---

## 6. Incident-archaeology comments

A comment explains **why**, and where the constraint came from. It never narrates the line
below it.

The convention already in practice here — the reason, then the reference that lets the next
reader find the whole story:

- `packages/web/src/hooks/use-query-invalidation.ts:23` — why every event also schedules a
  reconciliation pass, and what the patch alone cannot prove (ICI-570).
- `packages/web/src/lib/query-keys.ts:4` — why these surfaces refetch on mount: an
  invalidation arriving while a surface is unmounted must not survive its next mount (ICI-659).
- `packages/jinn/src/work-items/migrate.ts:138` and `:304` — a frozen recognizer for a shape
  that predates a migration, and the storage ownership rule that replaced it (PLA-48).

Each one answers a question the code cannot: *why is this here, and what breaks if I remove
it?* That is a comment that survives a refactor.

What does not earn its place: a comment restating its own line; a section divider; a `TODO`
with no owner and no reason; commented-out code.

**A comment your own change makes false is part of your change, not an adjacent problem.** If
your diff falsifies a comment, a doc line, or an error message, fix it in the same diff.
Leaving it and reporting it ships a lie.
