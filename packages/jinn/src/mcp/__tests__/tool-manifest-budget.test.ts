import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { buildTools } from "../server.js";
import { projectPiToolManifest } from "../../engines/pi-mcp.js";
import { EXPECTED_ENUMS, EXPECTED_REQUIRED, EXPECTED_TOOL_NAMES } from "./tool-manifest-expectations.js";

// Fixed provider budget. Rebased for the experiment Todo link with the same
// ~zero headroom discipline as before: new tool prose must stay concise rather
// than growing into this ceiling.
const MAX_MANIFEST_TOKENS = 6132;
// Exact gate: js-tiktoken 1.0.21 with its local o200k_base ranks. The provider
// projection is the OpenAI Responses API function-tool request shape pinned on 2026-07-12.
const ATTESTED = {
  // Rebased for `create_label`, `labels` on create_work_item, and `view` on
  // get_workflow_run (95 tokens, bought back by cutting four dead clauses).
  // Rebased again for `operatorOnly` on request_work_item_approval — the flag
  // that reserves a Todo gate for the human operator. It costs 8 tokens and
  // leaves Pi 9 under the ceiling, down from 17. The next addition to this
  // surface has to buy its own room back; there is no longer slack to spend.
  // Rebased for `assigned` on update_work_item's status enum: the agent lane
  // can now put a Todo back in the queue. It costs 2 tokens and leaves Pi 7
  // under the ceiling, down from 9.
  // Rebased once more for `asOperator` on update_work_item, which costs 24 and
  // broke the ceiling. Three dead clauses bought it back:
  //   - "Match role/persona fit;" on spawn_session — its own `employee` field
  //     already teaches the selection rule, one line below.
  //   - the field list on list_employees ("name, role, rank, department,
  //     engine, reporting") — the rows it describes carry their own keys. The
  //     part worth saying, that they include reporting lines, stays.
  //   - "Include own session." on search_messages — the property name says it,
  //     and the tool description already states the default it flips.
  // Rebased for `title` on edit_work_item, now that a Todo's content is open to
  // every session. It costs 9 tokens; the tool's own description bought 10 back
  // by dropping the field list ("Edit Todo title, body, acceptance, priority, or
  // dueAt.") that its schema properties already enumerate.
  // Rebased for `backlog` on update_work_item's status enum: "not now" is a
  // legitimate agent move. It costs 3 tokens and leaves Pi 3 under the ceiling.
  // Rebased for read_session's full-body and last=0 transcript contract. Its
  // concise field prose keeps Pi one token under the fixed ceiling.
  // Reattested for list_sessions' `pinned` scope. The new enum value spent
  // tokens; shortening its redundant description from an enumeration of the
  // same scopes to "by scope" bought those back plus four,
  // leaving Pi five under the unchanged ceiling.
  // Rebased for the six-tool Experiments ledger. This is a new public company
  // block rather than prose growth on an existing tool; Pi remains five tokens
  // under the fixed ceiling.
  // Rebased for the three-tool heartbeats group (arm/list/stop). Like the
  // Experiments ledger this is a new public capability rather than prose growth
  // on an existing tool, and unlike the earlier rebases there was no dead prose
  // left to buy it back with: its own descriptions were tightened first (19
  // tokens), and the remaining 175 are the group's honest cost. Pi stays five
  // under the ceiling, so the next addition still has to pay its own way.
  // Rebased for the Experiments audit fixes: `limit` on list_experiments and
  // `baseline` plus the one line teaching that a new metric needs one on
  // update_experiment — the client halves of the bounded list and the
  // baseline-on-update fix, without which an agent editing metrics just gets
  // `invalid`. Two redundant clauses bought 7 of the 24 back: "optionally by
  // status" on list_experiments, whose property carries its own enum and now
  // sits beside `limit`, and "'s definition"/"here" on update_experiment. The
  // remaining 17 are the fixes' honest cost. Pi stays five under the ceiling.
  // Rebased for `todoId` and `owner` on create_experiment and update_experiment:
  // the fields that stop an experiment being an island with no owner and no link
  // to the work it informs. Four schema properties and not one word of prose —
  // both tool descriptions are byte-for-byte what they were, because the property
  // names say what they are and `["string","null"]` on the update pair says that
  // null clears them. Create declares plain strings: there is nothing to clear at
  // creation. That leaves 35 tokens with nothing dead left in this group to buy
  // them back from, so the ceiling moves by exactly that. Pi stays five under it.
  // Rebased for `blockKind` on update_work_item: the four-value enum that says
  // WHY a Todo is blocked, and with it where the block lands. It has to be on
  // the tool rather than inferred, because `dependency` returns the Todo to its
  // queue while the other three park it in front of a human, and a caller that
  // cannot say which gets the human every time. The enum plus its one clause of
  // routing prose cost 39; its own description already paid 3 of that back by
  // dropping "Why blocked.", which the property name says. Nothing dead is left
  // in this group to buy the rest from, so the ceiling moves by exactly the 39.
  // Pi stays five under it.
  // Rebased for `set_work_item_dispatch` and `idempotencyKey` on
  // create_work_item (ICI-733): how a Todo's next attempt runs, and a
  // caller-supplied create key. Like the Experiments ledger and the heartbeats
  // group before it, this is a new public capability rather than prose growth on
  // an existing tool, and there was no dead prose left in this group to buy it
  // back with — its own description was tightened first ("and an engine/model
  // override" to "engine/model override", "while it is executing" to "while
  // executing"), and the remaining 126 are the addition's honest cost. Pi stays
  // five under the ceiling, so the next addition still has to pay its own way.
  // Rebased for `cascade` and `acknowledgeEscalated` on update_work_item
  // (PLA-96): closing a container and its open sub-tasks in one move, and the
  // separate word that lets that run over an escalated sub-task. Both have to be
  // on the tool — the route refuses a cascade it was not asked for, and refuses
  // one over an escalation until the caller says so, and a caller that cannot
  // say either has to close a dozen sub-tasks one at a time. Their prose was cut
  // to one clause each first ("the Todo's" to "its"; the repeated "Operator
  // surface only." dropped from the second, where the first already says it),
  // which paid 8 of the cost back. Nothing dead is left in this group to buy the
  // remaining 49 from, so the ceiling moves by exactly that. Pi stays five under.
  // Rebased for `offset` on read_knowledge and the cap it now names (PLA-100).
  // Both have to be on the tool: an agent that cannot see the boundary reads a
  // truncated file believing it whole, and one that cannot page has no way to
  // reach the rest. Its own description paid 2 back first ("N chars at a time;
  // page the rest with offset" to "N chars per call; offset pages the rest"),
  // and nothing dead is left in this group to buy the remaining 14 from, so the
  // ceiling moves by exactly that. Pi stays five under it.
  // Reattested for `verifyPolicy` on update_work_item (PLA-102): a Todo whose
  // product lands in the operator's workspace rather than in the diff has to be
  // able to say so on the tool that moves it, or the route is one the web
  // surface can declare and an agent cannot. It is a bare `{"type":"object"}`
  // and not one word of prose — the shared validator names every legal shape in
  // its refusal — so its whole cost is 7 tokens on each of the three wrappers.
  // It buys them back rather than moving the ceiling: `cost_report.groupBy`
  // carried the description "employee or day.", which is its own enum
  // `["employee","day"]` written out a second time in English, and dropping it
  // pays exactly 7 on each wrapper. So the ceiling, all three totals, and the
  // tool count are what `main` pinned; only the payload moved, so only the SHAs
  // do.
  // Reattested for `choice` on decide_workflow_approval (PLA-133): without it an
  // approval gate that offers variants is undecidable from MCP at all, because
  // approving one without naming a pick is refused rather than defaulted. The
  // bare `{"type":"string"}` costs 7 and not one word of prose. Two restatements
  // of an enum already in the schema bought 4 of that back, the same trade
  // `cost_report.groupBy` made: "Approve or reject" on this very tool, whose
  // `decision` enum is `["approve","reject"]`, and "with the original or current
  // definition" on rerun_workflow_run, whose `definition` enum is
  // `["original","current"]`. The remaining 3 fit under the unchanged ceiling —
  // Pi sits two below it, so the next addition still has to pay its own way.
  // Rebased for `parkedUntil` and `unblockHint` on update_work_item (PLA-157) —
  // the two fields that let a stopped Todo say whether it is waiting on a clock
  // or on a person. They cost 39. Three redundant clauses and two tightenings
  // bought 36 of that back:
  //   - the field list on set_work_item_dispatch ("skills to preload,
  //     engine/model override"), which its schema properties enumerate.
  //   - "supports threaded replies and local attachments" on comment_work_item,
  //     enumerated by its own `parentCommentId` and `attachments`.
  //   - "last=0 returns the whole transcript" on read_session, said again by
  //     `last`'s own "0=all (default 30)" one line below.
  //   - update_work_item's own `cascade` and `acknowledgeEscalated`, said in
  //     fewer words without losing either rule.
  // The two employee-selection clauses look like the same kind of duplication
  // and are NOT: exact-string tests in delegation-tools.test.ts and
  // session-tools.test.ts pin them, so they are contract, not prose.
  // `parkedUntil` carries no description of its own because the refusal names
  // the format at the moment it matters. The remaining 3 are the fields' honest
  // cost.
  // Rebased again for `mode` on label_work_item (PLA-155). Replace was the only
  // mode this tool had, so an agent told to drop one label had to re-send every
  // other label from memory to keep it — and a Todo that lost its arming label
  // that way sits at its arming status forever, because its lane trigger filters
  // on that label. The whole addition is one enum property and six words: `mode`
  // is `{"type":"string","enum":["add","remove"]}` at 14 tokens, and the tool's
  // own description went from "Set existing Todo labels." to "Set Todo labels;
  // mode add/remove keeps the rest." for 6 more. The alternative shape — sibling
  // `add` and `remove` arrays — cost 8 tokens more and let a caller name two
  // modes at once. No enum is restated in prose anywhere on this surface any more
  // and no field list duplicates its own properties, so unlike the earlier
  // rebases there was nothing dead left to buy the 20 back from; the ceiling
  // moves by exactly that. PLA-157's 3 land in the same release and take the
  // headroom the move would otherwise have left, so Pi sits exactly ON the moved
  // ceiling: the next addition to this surface has to buy its room BEFORE it
  // spends any.
  // Reattested for PLA-227: `assignee` left create_work_item's schema, because
  // creation no longer writes ownership — the assign flow is its only writer. It
  // gives 8 tokens back on each wrapper. The ceiling does not move, so Pi comes off
  // it and sits 8 under: this refactor hands the next addition its room back.
  // Rebased for `dispatch_work_item` (PLA-228): the Todo Shaper's handoff. The
  // Shaper's whole contract is to create one Todo and hand it on, and without
  // this verb it cannot — the dispatch route exists but has no MCP hand, so the
  // shaping half of quick capture would end at a Todo nobody starts. It is the
  // cheapest shape the capability has: a six-word description and one `id`
  // property, no prose the schema already carries. That is 64 tokens. Unlike
  // the earlier rebases there was nothing dead left to buy any of it back with
  // — PLA-155 already retired the last restated enum and the last duplicated
  // field list, and PLA-227's 8 are the headroom this spends first. So the
  // ceiling moves by exactly the remaining 56 and Pi sits ON it again: the next
  // addition to this surface has to buy its room before it spends any.
  // Rebased for `land_on_work_item` (PLA-228): the third way a capture can end.
  // Without it a capture that restated a Todo the board already had leaves only
  // a comment, and a comment is prose — the derived stage is not allowed to
  // pattern-match it, so the strip reported a correct dedupe as `failed`. The
  // verb writes the one fact the stage can read. It is the same minimal shape
  // as `dispatch_work_item`: a seven-word description and one `id` property.
  // That is 68 tokens. Four were bought back by cutting "on a Todo" from
  // `dispatch_work_item` — its own `id` property already names which Todo — and
  // there was nothing else left to cut, since S1 and PLA-155 between them took
  // the last of the restated enums and duplicated field lists. So the ceiling
  // moves by the remaining 64 and Pi sits ON it again. As before: the next
  // addition to this surface has to buy its room before it spends any.
  // Rebased for `intent` on delegate_task (DAH-214 item 1). A delegation links
  // the delegate's session to the Todo, and the self-review ban reads that link
  // as "you produced this" — so a reviewer delegated to close a Todo was
  // refused the close. The link now records WHY, and the Todo's own status
  // supplies the answer for the ordinary handoff (an `in_review` Todo is being
  // handed to a reviewer), which is why this property is an override rather
  // than a required field. It is the cheapest shape that still tells an agent
  // when to reach for it: two enum values and one clause naming the default,
  // no prose restating the enum. That is 31 tokens, and — as the paragraphs
  // above record — there is no dead prose left on this surface to buy them back
  // with, so the ceiling moves by exactly that and Pi sits ON it again. The next
  // addition to this surface has to buy its room before it spends any.
  // Rebased for `autoStart` on create_work_item and set_work_item_dispatch
  // (GEN-67). An instance's auto-start Workflow spawns the assignee's session
  // on backlog→assigned, so an employee that created a Todo and claimed it from
  // the session already working it got a second session on the same Todo. The
  // self-assign case is handled without any manifest cost (the assignment event
  // records the actor's employee); this property is the explicit opt-out for a
  // Todo that must wait for a hand-over. It is the cheapest shape that still
  // says what `false` does: one boolean on each tool, and a single eight-word
  // clause on the create tool only — the dispatch tool's boolean rides on it.
  // That is 29 tokens, and — as every paragraph above records — there is no
  // dead prose left on this surface to buy them back with, so the ceiling moves
  // by exactly that and Pi sits ON it again. The next addition to this surface
  // has to buy its room before it spends any.
  rpc: { tokens: 5611, sha256: "032be88e7f2dad04270bc8ee4b6ed59e62e84bea984f3708cfdf5dd3c20dc2cc" },
  pi: { tokens: 6132, sha256: "6bb240faba369b5568b2baa1a82c41808007653c2cea3588917d6753a8df9a81" },
  openai: { tokens: 5822, sha256: "5f7e61514826505830fd10a511f360a42c6f1fa70982471036d79f7f401aba18" },
} as const;

type TokenizerLoader = () => Promise<[{ Tiktoken: typeof import("js-tiktoken/lite").Tiktoken }, { default: typeof import("js-tiktoken/ranks/o200k_base").default }]>;
const loadPinnedTokenizer: TokenizerLoader = () => Promise.all([
  import("js-tiktoken/lite"),
  import("js-tiktoken/ranks/o200k_base"),
]);

async function exactOrAttested(name: keyof typeof ATTESTED, payload: string, loadTokenizer: TokenizerLoader = loadPinnedTokenizer): Promise<number> {
  try {
    const [{ Tiktoken }, ranks] = await loadTokenizer();
    return new Tiktoken(ranks.default).encode(payload).length;
  } catch {
    const hash = crypto.createHash("sha256").update(payload).digest("hex");
    if (hash !== ATTESTED[name].sha256) throw new Error(`tokenizer unavailable and ${name} manifest is not the attested golden payload (${hash})`);
    return ATTESTED[name].tokens;
  }
}

function collectEnums(value: unknown, path: string[] = []): Array<[string, string[]]> {
  if (!value || typeof value !== "object") return [];
  const schema = value as Record<string, unknown>;
  const own = Array.isArray(schema.enum) ? ([[path.join("."), schema.enum as string[]]] as Array<[string, string[]]>) : [];
  return [
    ...own,
    ...Object.entries(schema).flatMap(([key, child]) => collectEnums(child, [...path, key])),
  ];
}

describe("tool manifest budget", () => {
  it(`keeps exact JSON-RPC, owned Pi, and pinned OpenAI wrapper manifests under ${MAX_MANIFEST_TOKENS} o200k_base tokens`, async () => {
    const tools = buildTools().map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
    const wrappers = {
      rpc: { jsonrpc: "2.0", id: 1, result: { tools } },
      pi: { tools: projectPiToolManifest(tools) },
      // Pinned provider fixture: OpenAI Responses API function tool shape (2026-07-12).
      openai: { tools: tools.map(({ name, description, inputSchema }) => ({ type: "function", name, description, parameters: inputSchema })) },
    } as const;
    for (const [name, wrapper] of Object.entries(wrappers) as Array<[keyof typeof wrappers, unknown]>) {
      expect(await exactOrAttested(name, JSON.stringify(wrapper))).toBeLessThanOrEqual(MAX_MANIFEST_TOKENS);
    }
  }, 15_000);

  it("fails closed when a 350-character manifest mutation exceeds the cap", async () => {
    const tools = buildTools().map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
    const sentence = " This ordinary manifest mutation adds realistic English guidance for a workflow tool without changing its schema contract.";
    const prose = sentence.repeat(4).slice(0, 350);
    expect(prose).toHaveLength(350);
    const mutated = { tools: projectPiToolManifest(tools), mutation: prose };
    expect(await exactOrAttested("pi", JSON.stringify(mutated))).toBeGreaterThan(MAX_MANIFEST_TOKENS);
  });

  it("uses attestation only for the unchanged golden when the pinned tokenizer is unavailable", async () => {
    const unavailable: TokenizerLoader = async () => { throw new Error("simulated unavailable tokenizer"); };
    const tools = buildTools().map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
    const golden = JSON.stringify({ tools: projectPiToolManifest(tools) });
    expect(await exactOrAttested("pi", golden, unavailable)).toBe(ATTESTED.pi.tokens);

    const sentence = " This ordinary manifest mutation adds realistic English guidance for a workflow tool without changing its schema contract.";
    const changed = JSON.stringify({ tools: projectPiToolManifest(tools), mutation: sentence.repeat(4).slice(0, 350) });
    await expect(exactOrAttested("pi", changed, unavailable)).rejects.toThrow(/not the attested golden payload/);
  });

  it("keeps tool names, required arrays, and enum arrays stable", () => {
    const tools = buildTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...EXPECTED_TOOL_NAMES].sort());
    expect(tools).toHaveLength(75);

    const required = Object.fromEntries(tools.map((t) => [t.name, t.inputSchema.required ?? []]));
    expect(required).toEqual(EXPECTED_REQUIRED);

    const enums = Object.fromEntries(
      tools
        .map((t) => [t.name, collectEnums(t.inputSchema)] as const)
        .filter(([, entries]) => entries.length > 0),
    );
    expect(enums).toEqual(EXPECTED_ENUMS);
  });
});
