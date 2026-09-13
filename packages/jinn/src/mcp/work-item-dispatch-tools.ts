import { gatewayRequest, JinnMcpToolError, type JinnMcpTool } from "./toolkit.js";
import { assertIdentity, gatewayFailure, mutationResult } from "./work-item-result.js";
import { TODO_SKILLS_MAX } from "../work-items/dispatch-config.js";
import { requireSkillNames, requireString, requireTodoId } from "./work-item-args.js";

/**
 * Starting a Todo's next attempt, and saying how it should run.
 *
 * Both verbs answer the same question — what happens when this Todo is next
 * picked up — which is why they read together here rather than among the
 * content and relation verbs. They are also the pair a system employee reaches
 * for: the Shaper hands its Todo on with `dispatch_work_item`, and a caller
 * that needs the next attempt on another engine sets that first.
 *
 * `land_on_work_item` is the third way a capture ends, and it lives here for
 * the same reason: it is the Shaper's OTHER handoff. When the board already has
 * the Todo the capture restates, there is nothing to dispatch — but there is
 * still an answer to "where did my sentence go", and this is what records it.
 */

const TODO_ID_SCHEMA = { type: "string", pattern: "^[A-Z]{3}-[1-9][0-9]*$" } as const;

/** The Shaper's handoff. Its whole job is to be a thin pipe: the route decides
 *  whether this caller may dispatch and whether the Todo is already claimed,
 *  and `gatewayFailure` puts that answer in front of the agent word for word —
 *  a claim conflict has to read as the claim conflict it is, not as a generic
 *  failure the agent might reasonably retry around. */
function dispatchTool(): JinnMcpTool {
  return {
    name: "dispatch_work_item",
    description: "Start the Todo Dispatcher.",
    inputSchema: {
      type: "object",
      properties: { id: TODO_ID_SCHEMA },
      required: ["id"],
    },
    handler: async (args, ctx) => {
      assertIdentity(ctx);
      const id = requireTodoId(args);
      const { status, body } = await gatewayRequest(ctx, "POST", `/api/work-items/${encodeURIComponent(id)}/dispatch`, {});
      if (status >= 400) throw gatewayFailure(`dispatching work item "${id}"`, status, body);
      return mutationResult(body, "The Dispatcher is running; it routes the Todo and comments its reason.");
    },
  };
}

function dispatchConfigTool(): JinnMcpTool {
  return {
    name: "set_work_item_dispatch",
    description: "Set how a Todo's NEXT attempt runs. Safe while executing.",
    inputSchema: {
      type: "object",
      properties: {
        id: TODO_ID_SCHEMA,
        skills: { type: "array", items: { type: "string" }, maxItems: TODO_SKILLS_MAX },
        engine: { type: ["string", "null"] },
        model: { type: ["string", "null"] },
        autoStart: { type: "boolean" },
      },
      required: ["id"],
    },
    handler: async (args, ctx) => {
      assertIdentity(ctx);
      const id = requireTodoId(args);
      const payload: Record<string, unknown> = {};
      if (args.skills !== undefined) payload.skills = requireSkillNames(args);
      for (const key of ["engine", "model"] as const) {
        if (args[key] === null) payload[key] = null;
        else if (args[key] !== undefined) payload[key] = requireString(args, key);
      }
      if (args.autoStart !== undefined) {
        if (typeof args.autoStart !== "boolean") throw new JinnMcpToolError("autoStart must be a boolean");
        payload.autoStart = args.autoStart;
      }
      if (Object.keys(payload).length === 0) {
        throw new JinnMcpToolError("pass at least one of skills, engine, model or autoStart — an empty call would change nothing");
      }
      const { status, body } = await gatewayRequest(ctx, "PUT", `/api/work-items/${encodeURIComponent(id)}/dispatch-config`, payload);
      if (status >= 400) throw gatewayFailure(`setting dispatch config on work item "${id}"`, status, body);
      return mutationResult(body, "The next attempt on this Todo uses it; the one running now is untouched.");
    },
  };
}

/** Where a capture landed when it created nothing.
 *
 *  Without this the shaping session leaves only prose — a comment saying "this
 *  restated PLA-12" — and prose is not something the capture's derived stage is
 *  allowed to read: matching on comment text would be exactly the guessing that
 *  deriving the stage exists to forbid. The link this writes is a fact, and the
 *  strip reads the fact. */
function landOnTool(): JinnMcpTool {
  return {
    name: "land_on_work_item",
    description: "Record that your capture restated this Todo.",
    inputSchema: {
      type: "object",
      properties: { id: TODO_ID_SCHEMA },
      required: ["id"],
    },
    handler: async (args, ctx) => {
      assertIdentity(ctx);
      const id = requireTodoId(args);
      const { status, body } = await gatewayRequest(ctx, "POST", `/api/work-items/${encodeURIComponent(id)}/capture-landing`, {});
      if (status >= 400) throw gatewayFailure(`recording a capture landing on work item "${id}"`, status, body);
      return mutationResult(body, "The capture is recorded as landing here; do not create a duplicate.");
    },
  };
}

export function workItemDispatchTools(): { dispatch: JinnMcpTool; dispatchConfig: JinnMcpTool; landOn: JinnMcpTool } {
  return { dispatch: dispatchTool(), dispatchConfig: dispatchConfigTool(), landOn: landOnTool() };
}
