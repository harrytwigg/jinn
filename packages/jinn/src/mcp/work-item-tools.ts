import { gatewayRequest, JinnMcpToolError, type JinnMcpTool } from "./toolkit.js";
import { labelTools } from "./label-tools.js";
import { workItemDispatchTools } from "./work-item-dispatch-tools.js";
import { assertIdentity, gatewayFailure, mutationResult } from "./work-item-result.js";
import type { JinnMcpContext } from "./toolkit.js";
import { BLOCK_KIND_ERROR, BLOCK_KINDS, parseBlockKind } from "../work-items/blocks.js";
import { PARKED_UNTIL_ERROR, UNBLOCK_HINT_ERROR, parseParkedUntil, parseUnblockHint } from "../work-items/stop-cause.js";
import { parseTodoId } from "../work-items/id.js";
import {
  clampInt,
  FILTER_CHAR_CAP,
  optionalEnum,
  optionalString,
  optionalTodoIdField,
  RELATION_KINDS,
  requireLabelRefs,
  requireRelationKind,
  requireString,
  requireTodoId,
  requireTodoIdField,
  validatedVerifyPolicy,
} from "./work-item-args.js";

export const WORK_ITEM_SEARCH_LIMIT_MAX = 100;
export const WORK_ITEM_SEARCH_LIMIT_DEFAULT = 25;
export const WORK_ITEM_QUERY_CHAR_CAP = 512;
const WORK_ITEM_BODY_CHAR_CAP = 64_000;
/** Matches the route's own title ceiling, so an over-long title fails here with the field named. */
const WORK_ITEM_TITLE_CHAR_CAP = 200;
const WORK_ITEM_NOTE_CHAR_CAP = 8_000;

const STATUSES = ["backlog", "assigned", "executing", "in_review", "done", "blocked", "escalated", "cancelled"] as const;
const SOURCES = ["human", "delegation", "cron", "workflow", "session", "connector", "goal"] as const;
const AGENT_UPDATE_STATUSES = ["backlog", "assigned", "executing", "in_review", "blocked", "escalated", "done"] as const;
const TODO_ID_SCHEMA = { type: "string", pattern: "^[A-Z]{3}-[1-9][0-9]*$" } as const;
const COMMENT_ID_SCHEMA = { type: "string", pattern: "^wic_[0-9a-f]{12}$" } as const;
const COMMENT_ID_PATTERN = /^wic_[0-9a-f]{12}$/;
const COMMENT_LIST_LIMIT_MAX = 500;
const COMMENT_ATTACHMENTS_MAX = 10;
const ATTACHMENT_PATH_CHAR_CAP = 1024;

function qs(params: Record<string, string | number | undefined>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) parts.push(`${key}=${encodeURIComponent(String(value))}`);
  }
  return parts.join("&");
}

function summarize(item: Record<string, unknown>): Record<string, unknown> {
  return {
    id: item.id,
    title: item.title,
    status: item.status,
    assignee: item.assignee ?? null,
    department: item.department ?? null,
    source: item.source,
    parentId: item.parentId ?? null,
    rootId: item.rootId ?? item.id ?? null,
    depth: item.depth ?? 0,
    version: item.version,
    updatedAt: item.updatedAt ?? null,
  };
}

function workItemsFrom(body: unknown): Array<Record<string, unknown>> {
  const rec = (body ?? {}) as { workItems?: Array<Record<string, unknown>> };
  return Array.isArray(rec.workItems) ? rec.workItems.map(summarize) : [];
}

function findApprovalKeysDeep(value: unknown, path = "args", found: string[] = []): string[] {
  if (!value || typeof value !== "object") return found;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = `${path}.${key}`;
    if (/^approval/i.test(key)) found.push(childPath);
    findApprovalKeysDeep(child, childPath, found);
  }
  return found;
}

function rejectApprovalFields(args: Record<string, unknown>, toolName: string): void {
  const forbidden = findApprovalKeysDeep(args);
  if (forbidden.length > 0) {
    throw new JinnMcpToolError(
      `approval fields (${forbidden.join(", ")}) cannot be attached by ${toolName} — approvals are routed gates; request/decide them through the separate approval authority surface, not Todo creation/status updates.`,
    );
  }
}

/** PATCH the metadata pen at a freshly read version, retrying ONCE on a concurrent
 *  bump so an agent never runs the optimistic-concurrency loop itself. A second
 *  conflict surfaces the 409. */
async function patchWorkItem(ctx: JinnMcpContext, id: string, patch: Record<string, unknown>, what: string): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    const read = await gatewayRequest(ctx, "GET", `/api/work-items/${encodeURIComponent(id)}`);
    if (read.status >= 400) throw gatewayFailure(what, read.status, read.body);
    const version = ((read.body ?? {}) as { workItem?: { version?: unknown } }).workItem?.version;
    if (typeof version !== "number") throw new JinnMcpToolError(`${what} failed: the gateway detail payload carried no version`);
    const { status, body } = await gatewayRequest(ctx, "PATCH", `/api/work-items/${encodeURIComponent(id)}`, { ...patch, expectedVersion: version });
    const stale = attempt === 0 && status === 409 && ((body ?? {}) as { code?: unknown }).code === "todo_version_conflict";
    if (stale) continue;
    if (status >= 400) throw gatewayFailure(what, status, body);
    return body;
  }
}

function rejectProvenance(args: Record<string, unknown>): void {
  if (args.provenance !== undefined) {
    throw new JinnMcpToolError(
      "provenance cannot be supplied by create_work_item — the server assigns source provenance: create_work_item uses source=session, while cron and delegation create their own records; source=workflow is historical audit provenance and is not currently minted",
    );
  }
}

export function buildWorkItemTools(): JinnMcpTool[] {
  const list: JinnMcpTool = {
    name: "list_work_items",
    description: "List recent or filtered Todo roots and sub-tasks; compact summaries.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: [...STATUSES] },
        source: { type: "string", enum: [...SOURCES] },
        assignee: { type: "string" },
        department: { type: "string" },
        needsAttentionFor: { type: "string" },
        createdBy: { type: "string" },
        parentId: TODO_ID_SCHEMA,
        rootId: TODO_ID_SCHEMA,
        rootsOnly: { type: "boolean" },
        label: { type: "string" },
        text: { type: "string" },
        since: { type: "string" },
        until: { type: "string" },
        limit: { type: "number" },
        offset: { type: "number" },
      },
    },
    handler: async (args, ctx) => {
      assertIdentity(ctx);
      const params = qs({
        status: optionalEnum(args, "status", STATUSES),
        source: optionalEnum(args, "source", SOURCES),
        assignee: optionalString(args, "assignee"),
        department: optionalString(args, "department"),
        needsAttentionFor: optionalString(args, "needsAttentionFor"),
        createdBy: optionalString(args, "createdBy"),
        parent: optionalTodoIdField(args, "parentId"),
        root: optionalTodoIdField(args, "rootId"),
        rootsOnly: args.rootsOnly === true ? "true" : undefined,
        label: optionalString(args, "label"),
        text: optionalString(args, "text", WORK_ITEM_QUERY_CHAR_CAP),
        since: optionalString(args, "since", 64),
        until: optionalString(args, "until", 64),
        limit: clampInt(args.limit, WORK_ITEM_SEARCH_LIMIT_DEFAULT, 1, WORK_ITEM_SEARCH_LIMIT_MAX),
        offset: clampInt(args.offset, 0, 0, 1_000_000),
      });
      const { status, body } = await gatewayRequest(ctx, "GET", `/api/work-items?${params}`);
      if (status >= 400) throw gatewayFailure("listing work items", status, body);
      const workItems = workItemsFrom(body);
      return { workItems, hint: workItems.length ? "Next: get_work_item { id }." : "No matches. Next: search_work_items or create_work_item." };
    },
  };

  const get: JinnMcpTool = {
    name: "get_work_item",
    description: "Get full Todo detail.",
    inputSchema: {
      type: "object",
      properties: { id: TODO_ID_SCHEMA },
      required: ["id"],
    },
    handler: async (args, ctx) => {
      assertIdentity(ctx);
      const id = requireTodoId(args);
      const { status, body } = await gatewayRequest(ctx, "GET", `/api/work-items/${encodeURIComponent(id)}`);
      if (status >= 400) throw gatewayFailure(`getting work item "${id}"`, status, body);
      return body;
    },
  };

  const search: JinnMcpTool = {
    name: "search_work_items",
    description: "Search Todos by text and structured filters; compact hits only.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        status: { type: "string", enum: [...STATUSES] },
        source: { type: "string", enum: [...SOURCES] },
        assignee: { type: "string" },
        department: { type: "string" },
        limit: { type: "number" },
      },
    },
    handler: async (args, ctx) => {
      assertIdentity(ctx);
      const params: Record<string, string | number | undefined> = {
        text: optionalString(args, "text", WORK_ITEM_QUERY_CHAR_CAP),
        status: optionalEnum(args, "status", STATUSES),
        source: optionalEnum(args, "source", SOURCES),
        assignee: optionalString(args, "assignee"),
        department: optionalString(args, "department"),
        limit: clampInt(args.limit, WORK_ITEM_SEARCH_LIMIT_DEFAULT, 1, WORK_ITEM_SEARCH_LIMIT_MAX),
      };
      const hasFilter = Object.entries(params).some(([k, v]) => k !== "limit" && v !== undefined);
      if (!hasFilter) throw new JinnMcpToolError("pass at least one filter (text, status, source, assignee, department) — for recent Todos use list_work_items.");
      const { status, body } = await gatewayRequest(ctx, "GET", `/api/search/work-items?${qs(params)}`);
      if (status >= 400) throw gatewayFailure("searching work items", status, body);
      const workItems = workItemsFrom(body);
      return { workItems, hint: workItems.length ? "Next: get_work_item { id }." : "No matches. Try fewer words or filters." };
    },
  };

  const create: JinnMcpTool = {
    name: "create_work_item",
    description: "Create a Todo or parentId sub-task; no approvals.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        body: { type: "string" },
        acceptance: { type: "string" },
        department: { type: "string" },
        verifyPolicy: { type: "object" },
        parentId: TODO_ID_SCHEMA,
        priority: { type: "number", enum: [0, 1, 2, 3] },
        dueAt: { type: "string" },
        labels: { type: "array", items: { type: "string" } },
        idempotencyKey: { type: "string" },
        autoStart: { type: "boolean", description: "false: no Workflow auto-starts it on assignment." },
      },
      required: ["title"],
    },
    handler: async (args, ctx) => {
      assertIdentity(ctx);
      rejectApprovalFields(args, "create_work_item");
      rejectProvenance(args);
      const body: Record<string, unknown> = { title: requireString(args, "title") };
      for (const key of ["body", "acceptance", "department"] as const) {
        const v = optionalString(args, key, key === "body" || key === "acceptance" ? WORK_ITEM_BODY_CHAR_CAP : FILTER_CHAR_CAP);
        if (v !== undefined) body[key] = v;
      }
      const verifyPolicy = validatedVerifyPolicy(args);
      if (verifyPolicy !== undefined) body.verifyPolicy = verifyPolicy;
      if (args.parentId !== undefined) {
        try { body.parentId = parseTodoId(args.parentId); }
        catch { throw new JinnMcpToolError("parentId must be a canonical Todo ID such as ACM-42"); }
      }
      if (args.priority !== undefined) {
        if (typeof args.priority !== "number" || !Number.isInteger(args.priority) || args.priority < 0 || args.priority > 3) {
          throw new JinnMcpToolError("priority must be an integer 0..3");
        }
        body.priority = args.priority;
      }
      const dueAt = optionalString(args, "dueAt", 64);
      if (dueAt !== undefined) body.dueAt = dueAt;
      if (args.labels !== undefined) body.labels = requireLabelRefs(args);
      if (args.autoStart !== undefined) {
        if (typeof args.autoStart !== "boolean") throw new JinnMcpToolError("autoStart must be a boolean");
        body.autoStart = args.autoStart;
      }
      // ICI-733: repeating the same key returns the Todo the first call made,
      // so a retried cron or connector fire cannot mint a duplicate.
      const idempotencyKey = optionalString(args, "idempotencyKey");
      if (idempotencyKey !== undefined) body.idempotencyKey = idempotencyKey;
      const { status, body: resp } = await gatewayRequest(ctx, "POST", "/api/work-items", body);
      if (status >= 400) throw gatewayFailure("creating work item", status, resp);
      return mutationResult(resp, "Next: assign_work_item or update_work_item.");
    },
  };

  const tree: JinnMcpTool = {
    name: "get_work_item_tree",
    description: "Get a Todo's sub-task tree with per-status totals and derived spend.",
    inputSchema: {
      type: "object",
      properties: { id: TODO_ID_SCHEMA },
      required: ["id"],
    },
    handler: async (args, ctx) => {
      assertIdentity(ctx);
      const id = requireTodoId(args);
      const { status, body } = await gatewayRequest(ctx, "GET", `/api/work-items/${encodeURIComponent(id)}/tree`);
      if (status >= 400) throw gatewayFailure(`getting work item tree "${id}"`, status, body);
      return { ...(body as Record<string, unknown>), hint: "Next: get_work_item { id } on a child, or update_work_item." };
    },
  };

  const update: JinnMcpTool = {
    name: "update_work_item",
    description: "Update Todo status.",
    inputSchema: {
      type: "object",
      properties: {
        id: TODO_ID_SCHEMA,
        status: { type: "string", enum: [...AGENT_UPDATE_STATUSES] },
        blockKind: { type: "string", enum: [...BLOCK_KINDS], description: "`dependency` re-queues it; the rest wait on a human." },
        note: { type: "string" },
        asOperator: { type: "boolean", description: "Record the move as the operator's. COO only." },
        cascade: { type: "boolean", description: "With `done`, close open sub-tasks. Operator only." },
        acknowledgeEscalated: { type: "boolean", description: "Let it close an escalated sub-task." },
        parkedUntil: { type: "string" },
        unblockHint: { type: "object", description: "{what, who}. Required to escalate." },
        verifyPolicy: { type: "object" },
      },
      required: ["id", "status"],
    },
    handler: async (args, ctx) => {
      assertIdentity(ctx);
      rejectApprovalFields(args, "update_work_item");
      const id = requireTodoId(args);
      const rawStatus = requireString(args, "status");
      if (rawStatus === "cancelled") throw new JinnMcpToolError("cancelling a Todo is a human surface decision; agents do not have a cancel tool.");
      if (!(AGENT_UPDATE_STATUSES as readonly string[]).includes(rawStatus)) throw new JinnMcpToolError(`status must be one of ${AGENT_UPDATE_STATUSES.join(", ")}; cancellation/other lifecycle edits are human surface decisions.`);
      const blockKind = parseBlockKind(args.blockKind);
      if (blockKind === null) throw new JinnMcpToolError(`${BLOCK_KIND_ERROR}.`);
      // The route's validator AND its words verbatim: a trailing full stop is enough to make them unequal.
      if (parseUnblockHint(args.unblockHint) === null) throw new JinnMcpToolError(UNBLOCK_HINT_ERROR);
      if (parseParkedUntil(args.parkedUntil) === null) throw new JinnMcpToolError(`${PARKED_UNTIL_ERROR}.`);
      const note = optionalString(args, "note", WORK_ITEM_NOTE_CHAR_CAP);
      // Where a Todo's product lands is metadata, not a lifecycle edge: it rides the same
      // pen the web surface writes it through, and rides it first, so a refused declaration
      // cannot move the status — and a refused move says what did land, not "nothing happened".
      const verifyPolicy = validatedVerifyPolicy(args);
      if (verifyPolicy !== undefined) await patchWorkItem(ctx, id, { verifyPolicy }, `updating work item "${id}"`);
      const payload: Record<string, unknown> = { status: rawStatus, ...(blockKind ? { blockKind } : {}), ...(note !== undefined ? { note } : {}), ...Object.fromEntries((["asOperator", "cascade", "acknowledgeEscalated", "parkedUntil", "unblockHint"] as const).filter((key) => args[key] !== undefined).map((key) => [key, args[key]])) };
      const { status, body } = await gatewayRequest(ctx, "POST", `/api/work-items/${encodeURIComponent(id)}/status`, payload);
      if (status >= 400) throw new JinnMcpToolError(`${gatewayFailure(`updating work item "${id}"`, status, body).message}${verifyPolicy === undefined ? "" : " — the deliverable declaration was written and stands; only the status move failed, so a retry does not need to carry verifyPolicy again"}`);
      return mutationResult(body, "Todo status updated.");
    },
  };

  const edit: JinnMcpTool = {
    name: "edit_work_item",
    description: "Edit Todo content.",
    inputSchema: {
      type: "object",
      properties: {
        id: TODO_ID_SCHEMA,
        title: { type: "string" },
        body: { type: "string" },
        acceptance: { type: ["string", "null"] },
        priority: { type: "number", enum: [0, 1, 2, 3] },
        dueAt: { type: ["string", "null"] },
      },
      required: ["id"],
    },
    handler: async (args, ctx) => {
      assertIdentity(ctx);
      rejectApprovalFields(args, "edit_work_item");
      const id = requireTodoId(args);
      if (args.status !== undefined) {
        throw new JinnMcpToolError("status is not a metadata edit — use update_work_item for lifecycle changes");
      }
      // Refuse other non-editable fields LOUDLY too: silently dropping them
      // would report success without the edit the caller asked for.
      if (args.assignee !== undefined) {
        throw new JinnMcpToolError("assignee is not editable here — use assign_work_item");
      }
      if (args.department !== undefined || args.rank !== undefined) {
        throw new JinnMcpToolError("department and rank are operator-only edits (web/HTTP surface) — edit_work_item cannot change them");
      }
      const patch: Record<string, unknown> = {};
      {
        const v = optionalString(args, "title", WORK_ITEM_TITLE_CHAR_CAP);
        if (v !== undefined) patch.title = v;
      }
      {
        const v = optionalString(args, "body", WORK_ITEM_BODY_CHAR_CAP);
        if (v !== undefined) patch.body = v;
      }
      // Explicit null CLEARS acceptance/dueAt (slice-4 review F3), passing
      // through to the route's existing null support.
      if (args.acceptance === null) {
        patch.acceptance = null;
      } else {
        const v = optionalString(args, "acceptance", WORK_ITEM_BODY_CHAR_CAP);
        if (v !== undefined) patch.acceptance = v;
      }
      if (args.priority !== undefined) {
        if (typeof args.priority !== "number" || !Number.isInteger(args.priority) || args.priority < 0 || args.priority > 3) {
          throw new JinnMcpToolError("priority must be an integer 0..3");
        }
        patch.priority = args.priority;
      }
      if (args.dueAt === null) {
        patch.dueAt = null;
      } else {
        const dueAt = optionalString(args, "dueAt", 64);
        if (dueAt !== undefined) patch.dueAt = dueAt;
      }
      if (Object.keys(patch).length === 0) {
        throw new JinnMcpToolError("pass at least one editable field (title, body, acceptance, priority, dueAt)");
      }
      return mutationResult(await patchWorkItem(ctx, id, patch, `editing work item "${id}"`), "Todo metadata edited.");
    },
  };

  const assign: JinnMcpTool = {
    name: "assign_work_item",
    description: "Assign a Todo.",
    inputSchema: {
      type: "object",
      properties: {
        id: TODO_ID_SCHEMA,
        assignee: { type: "string" },
      },
      required: ["id", "assignee"],
    },
    handler: async (args, ctx) => {
      assertIdentity(ctx);
      rejectApprovalFields(args, "assign_work_item");
      const id = requireTodoId(args);
      const assignee = requireString(args, "assignee");
      const { status, body } = await gatewayRequest(ctx, "POST", `/api/work-items/${encodeURIComponent(id)}/assign`, { assignee });
      if (status >= 400) throw gatewayFailure(`assigning work item "${id}"`, status, body);
      return mutationResult(body, "Todo assigned.");
    },
  };

  const archive: JinnMcpTool = {
    name: "archive_work_item",
    description: "Archive a Todo; retain its audit.",
    inputSchema: {
      type: "object",
      properties: {
        id: TODO_ID_SCHEMA,
        note: { type: "string" },
      },
      required: ["id"],
    },
    handler: async (args, ctx) => {
      assertIdentity(ctx);
      rejectApprovalFields(args, "archive_work_item");
      const id = requireTodoId(args);
      const payload: Record<string, unknown> = {};
      const note = optionalString(args, "note", WORK_ITEM_NOTE_CHAR_CAP);
      if (note !== undefined) payload.note = note;
      const { status, body } = await gatewayRequest(ctx, "POST", `/api/work-items/${encodeURIComponent(id)}/archive`, payload);
      if (status >= 400) throw gatewayFailure(`archiving work item "${id}"`, status, body);
      return mutationResult(body, "Todo archived.");
    },
  };

  const comment: JinnMcpTool = {
    name: "comment_work_item",
    description: "Comment on a Todo.",
    inputSchema: {
      type: "object",
      properties: {
        id: TODO_ID_SCHEMA,
        body: { type: "string" },
        parentCommentId: COMMENT_ID_SCHEMA,
        attachments: { type: "array", items: { type: "string" } },
      },
      required: ["id", "body"],
    },
    handler: async (args, ctx) => {
      assertIdentity(ctx);
      const id = requireTodoId(args);
      const body = requireString(args, "body", WORK_ITEM_BODY_CHAR_CAP);
      const payload: Record<string, unknown> = { body };
      if (args.parentCommentId !== undefined) {
        if (typeof args.parentCommentId !== "string" || !COMMENT_ID_PATTERN.test(args.parentCommentId)) {
          throw new JinnMcpToolError("parentCommentId must be a comment ID such as wic_0a1b2c3d4e5f");
        }
        payload.parentCommentId = args.parentCommentId;
      }
      let attachmentPaths: string[] = [];
      if (args.attachments !== undefined) {
        if (!Array.isArray(args.attachments) || args.attachments.length > COMMENT_ATTACHMENTS_MAX
          || args.attachments.some((entry) => typeof entry !== "string" || !entry.trim() || entry.length > ATTACHMENT_PATH_CHAR_CAP)) {
          throw new JinnMcpToolError(`attachments must be an array of up to ${COMMENT_ATTACHMENTS_MAX} local file paths (non-empty strings)`);
        }
        attachmentPaths = (args.attachments as string[]).map((entry) => entry.trim());
      }
      const { status, body: resp } = await gatewayRequest(ctx, "POST", `/api/work-items/${encodeURIComponent(id)}/comments`, payload);
      if (status >= 400) throw gatewayFailure(`commenting on work item "${id}"`, status, resp);
      const created = resp as Record<string, unknown>;
      if (attachmentPaths.length === 0) return { ...created, hint: "Next: get_work_item { id }." };
      const commentId = (created.comment as { id?: unknown } | undefined)?.id;
      if (typeof commentId !== "string") {
        throw new JinnMcpToolError(`the comment was created but the gateway response carried no comment id — attachments were NOT uploaded`);
      }
      const uploaded: unknown[] = [];
      for (const filePath of attachmentPaths) {
        const attach = await gatewayRequest(ctx, "POST", `/api/work-items/${encodeURIComponent(id)}/attachments`, {
          path: filePath,
          commentId,
        });
        if (attach.status >= 400) {
          throw gatewayFailure(
            `comment ${commentId} was created, but attaching "${filePath}" (${uploaded.length}/${attachmentPaths.length} uploaded)`,
            attach.status,
            attach.body,
          );
        }
        uploaded.push((attach.body as { attachment?: unknown } | null)?.attachment ?? attach.body);
      }
      return { ...created, attachments: uploaded, hint: "Next: get_work_item { id }." };
    },
  };

  const listComments: JinnMcpTool = {
    name: "list_work_item_comments",
    description: "List Todo comments chronologically.",
    inputSchema: {
      type: "object",
      properties: {
        id: TODO_ID_SCHEMA,
        limit: { type: "number" },
        offset: { type: "number" },
      },
      required: ["id"],
    },
    handler: async (args, ctx) => {
      assertIdentity(ctx);
      const id = requireTodoId(args);
      const params = qs({
        limit: args.limit !== undefined ? clampInt(args.limit, 50, 1, COMMENT_LIST_LIMIT_MAX) : undefined,
        offset: args.offset !== undefined ? clampInt(args.offset, 0, 0, 1_000_000) : undefined,
      });
      const { status, body } = await gatewayRequest(ctx, "GET", `/api/work-items/${encodeURIComponent(id)}/comments${params ? `?${params}` : ""}`);
      if (status >= 400) throw gatewayFailure(`listing comments on work item "${id}"`, status, body);
      return body;
    },
  };

  const attach: JinnMcpTool = {
    name: "attach_to_work_item",
    description: "Attach a local file to a Todo or comment.",
    inputSchema: {
      type: "object",
      properties: {
        id: TODO_ID_SCHEMA,
        path: { type: "string" },
        commentId: COMMENT_ID_SCHEMA,
        filename: { type: "string" },
      },
      required: ["id", "path"],
    },
    handler: async (args, ctx) => {
      assertIdentity(ctx);
      const id = requireTodoId(args);
      const filePath = requireString(args, "path", ATTACHMENT_PATH_CHAR_CAP);
      const payload: Record<string, unknown> = { path: filePath };
      if (args.commentId !== undefined) {
        if (typeof args.commentId !== "string" || !COMMENT_ID_PATTERN.test(args.commentId)) {
          throw new JinnMcpToolError("commentId must be a comment ID such as wic_0a1b2c3d4e5f");
        }
        payload.commentId = args.commentId;
      }
      const filename = optionalString(args, "filename");
      if (filename !== undefined) payload.filename = filename;
      const { status, body } = await gatewayRequest(ctx, "POST", `/api/work-items/${encodeURIComponent(id)}/attachments`, payload);
      if (status >= 400) throw gatewayFailure(`attaching to work item "${id}"`, status, body);
      return { ...(body as Record<string, unknown>), hint: "Next: list_work_item_attachments { id }." };
    },
  };

  const listAttachments: JinnMcpTool = {
    name: "list_work_item_attachments",
    description: "List Todo attachments and storage paths.",
    inputSchema: {
      type: "object",
      properties: { id: TODO_ID_SCHEMA },
      required: ["id"],
    },
    handler: async (args, ctx) => {
      assertIdentity(ctx);
      const id = requireTodoId(args);
      const { status, body } = await gatewayRequest(ctx, "GET", `/api/work-items/${encodeURIComponent(id)}/attachments`);
      if (status >= 400) throw gatewayFailure(`listing attachments on work item "${id}"`, status, body);
      return body;
    },
  };

  const link: JinnMcpTool = {
    name: "link_work_items",
    description: "Link Todos; blocks is cycle-checked.",
    inputSchema: {
      type: "object",
      properties: {
        srcId: TODO_ID_SCHEMA,
        dstId: TODO_ID_SCHEMA,
        kind: { type: "string", enum: [...RELATION_KINDS] },
      },
      required: ["srcId", "dstId", "kind"],
    },
    handler: async (args, ctx) => {
      assertIdentity(ctx);
      const srcId = requireTodoIdField(args, "srcId");
      const dstId = requireTodoIdField(args, "dstId");
      const kind = requireRelationKind(args);
      const { status, body } = await gatewayRequest(ctx, "POST", `/api/work-items/${encodeURIComponent(srcId)}/relations`, { dstId, kind });
      if (status >= 400) throw gatewayFailure(`linking "${srcId}" ${kind} "${dstId}"`, status, body);
      return mutationResult(body, "Todos linked.");
    },
  };

  const unlink: JinnMcpTool = {
    name: "unlink_work_items",
    description: "Remove a Todo relation.",
    inputSchema: {
      type: "object",
      properties: {
        srcId: TODO_ID_SCHEMA,
        dstId: TODO_ID_SCHEMA,
        kind: { type: "string", enum: [...RELATION_KINDS] },
      },
      required: ["srcId", "dstId", "kind"],
    },
    handler: async (args, ctx) => {
      assertIdentity(ctx);
      const srcId = requireTodoIdField(args, "srcId");
      const dstId = requireTodoIdField(args, "dstId");
      const kind = requireRelationKind(args);
      const { status, body } = await gatewayRequest(ctx, "DELETE", `/api/work-items/${encodeURIComponent(srcId)}/relations`, { dstId, kind });
      if (status >= 400) throw gatewayFailure(`unlinking "${srcId}" ${kind} "${dstId}"`, status, body);
      return mutationResult(body, "Relation removed.");
    },
  };

  const departments: JinnMcpTool = {
    name: "list_departments",
    description: "List departments with Todo prefixes and counts.",
    inputSchema: { type: "object", properties: {} },
    handler: async (_args, ctx) => {
      assertIdentity(ctx);
      const { status, body } = await gatewayRequest(ctx, "GET", "/api/departments");
      if (status >= 400) throw gatewayFailure("listing departments", status, body);
      return body;
    },
  };

  const { dispatch, dispatchConfig, landOn } = workItemDispatchTools();
  return [list, get, tree, search, create, update, edit, assign, archive, dispatch, landOn, comment, listComments, attach, listAttachments, link, unlink, ...labelTools(), dispatchConfig, departments];
}
