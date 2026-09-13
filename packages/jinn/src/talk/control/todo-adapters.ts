/**
 * Talk's Todo lane: read one, make one, change one.
 *
 * Split from `domain-adapters.ts` because the Todo verbs are what keep
 * arriving, and because that file has no size budget and a hard cap. Every
 * write here is re-read authoritatively by `verification.ts` before the runtime
 * will call it verified.
 */
import { orgRegistry } from "../../gateway/org-registry.js";
import { assignWorkItem } from "../../work-items/assignment.js";
import { addComment, commentsTail } from "../../work-items/comments.js";
import { createWorkItemIdempotent } from "../../work-items/create-idempotency.js";
import { getWorkItemLabels } from "../../work-items/labels.js";
import { writeDetail } from "../../work-items/origin.js";
import {
  getWorkItem,
  updateWorkItemConditional,
  type UpdateWorkItemInput,
  type WorkItemStatus,
} from "../../work-items/store.js";
import { transition } from "../../work-items/transitions.js";
import { requiredText, type DomainHandler } from "./domain-types.js";

/** One Todo as Talk describes it: enough for the model to answer about it
 *  without a second call, and nothing the operator did not ask about. */
export function todoData(id: string): Record<string, unknown> {
  const item = getWorkItem(id);
  if (!item) throw new Error(`Todo ${id} not found`);
  const comments = commentsTail(id);
  return {
    id: item.id,
    title: item.title,
    body: item.body,
    status: item.status,
    assignee: item.assignee,
    department: item.department,
    priority: item.priority,
    version: item.version,
    labels: getWorkItemLabels(id).map((label) => label.name),
    comments: comments.comments.map((comment) => ({ id: comment.id, author: comment.author, body: comment.body })),
    commentCount: comments.total,
  };
}

const readTodo: DomainHandler = (_host, args) => {
  const id = requiredText(args, "id");
  return { data: todoData(id), uiEffect: null };
};

/**
 * Create one, at most once.
 *
 * Keyed on the provider call so a retried turn returns the Todo the first
 * attempt made rather than a second row — the operator dictated one Todo.
 */
const createTodo: DomainHandler = (_host, args, call) => {
  const title = requiredText(args, "title");
  const created = createWorkItemIdempotent({
    title,
    ...(typeof args.body === "string" && args.body.trim() ? { body: args.body.trim() } : {}),
    ...(typeof args.parentId === "string" && args.parentId.trim() ? { parentId: args.parentId.trim() } : {}),
    source: "human",
    createdBy: "operator",
    origin: "talk",
  }, call.idempotencyKey);
  return {
    data: { todo: todoData(created.item.id), replayed: created.replayed },
    uiEffect: { invalidate: ["todos"], navigate: `/todos/${encodeURIComponent(created.item.id)}` },
  };
};

function todoEditPatch(args: Record<string, unknown>): UpdateWorkItemInput {
  const patch: UpdateWorkItemInput = {};
  if (typeof args.title === "string" && args.title.trim()) patch.title = args.title.trim();
  if (typeof args.body === "string") patch.body = args.body;
  if (Number.isInteger(args.priority) && Number(args.priority) >= 0 && Number(args.priority) <= 3) patch.priority = Number(args.priority);
  if (Object.keys(patch).length === 0) throw new Error("an editable field is required");
  return patch;
}

const editTodo: DomainHandler = (_host, args, call) => {
  const id = requiredText(args, "id");
  const expectedVersion = args.expectedVersion;
  if (!Number.isInteger(expectedVersion) || Number(expectedVersion) < 1) throw new Error("expectedVersion must be positive");
  const patch = todoEditPatch(args);
  const result = updateWorkItemConditional(id, patch, { expectedVersion: Number(expectedVersion), idempotencyKey: call.idempotencyKey, actor: "operator", origin: "talk" });
  if (!result) throw new Error(`Todo ${id} not found`);
  return { data: { todo: todoData(id), replayed: result.replayed }, uiEffect: { invalidate: ["todos", `todo:${id}`], navigate: `/todos/${encodeURIComponent(id)}` } };
};

/**
 * Move one.
 *
 * `human: true` because a Talk control is the authenticated operator arriving
 * by voice rather than by click — the same authority the operator's own PUT
 * carries, so the same edges are walkable. `TransitionError` is left to
 * propagate: its message names the edge that was refused, which is exactly what
 * the operator needs to hear.
 */
const setTodoStatus: DomainHandler = (_host, args) => {
  const id = requiredText(args, "id");
  const status = requiredText(args, "status") as WorkItemStatus;
  const note = typeof args.note === "string" && args.note.trim() ? args.note.trim() : undefined;
  if (!getWorkItem(id)) throw new Error(`Todo ${id} not found`);
  const detail = writeDetail({ ...(note ? { note } : {}) }, "talk");
  transition(id, status, "operator", { manual: true, human: true, ...(detail ? { detail } : {}) });
  return { data: { todo: todoData(id) }, uiEffect: { invalidate: ["todos", `todo:${id}`], navigate: `/todos/${encodeURIComponent(id)}` } };
};

const commentTodo: DomainHandler = (_host, args, call) => {
  const id = requiredText(args, "id");
  const comment = addComment({
    workItemId: id,
    body: requiredText(args, "body"),
    author: "operator",
    authorKind: "operator",
    origin: "talk",
    idempotencyKey: call.idempotencyKey,
  });
  return { data: { commentId: comment.id, todoId: id }, uiEffect: { invalidate: ["todos", `todo:${id}`, `todo-comments:${id}`], navigate: `/todos/${encodeURIComponent(id)}` } };
};

const assignTodo: DomainHandler = (host, args) => {
  const id = requiredText(args, "id");
  const employeeName = requiredText(args, "assignee");
  const employee = orgRegistry(host.context.getConfig()).get(employeeName);
  if (!employee) throw new Error(`Employee ${employeeName} not found`);
  const item = assignWorkItem(id, employee.name, employee.department ?? null, "operator", { origin: "talk" });
  if (!item) throw new Error(`Todo ${id} not found`);
  return { data: { todo: todoData(id) }, uiEffect: { invalidate: ["todos", `todo:${id}`], navigate: `/todos/${encodeURIComponent(id)}` } };
};

export const TODO_DOMAIN_HANDLERS: Record<string, DomainHandler> = {
  read_todo: readTodo,
  talk_create_todo: createTodo,
  talk_edit_todo: editTodo,
  talk_set_todo_status: setTodoStatus,
  talk_comment_todo: commentTodo,
  talk_assign_todo: assignTodo,
};
