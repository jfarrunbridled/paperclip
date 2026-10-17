import { test } from "node:test";
import assert from "node:assert/strict";
import {
  boundExecutionContinuationEnvelope,
  omitDeletedContinuationMessages,
} from "./execution-continuation-budget.ts";

function continuationMessage(
  id: string,
  body: string,
  extra: { deleted?: boolean } = {},
) {
  return {
    id,
    authorType: "agent",
    authorId: "agent",
    createdByRunId: "run",
    body,
    createdAt: "2026-10-16T00:00:00.000Z",
    updatedAt: "2026-10-16T00:00:00.000Z",
    deleted: extra.deleted === true,
    sourceTrust: null,
  };
}

test("omits deleted tombstones and keeps live empty bodies", () => {
  const tombstone = continuationMessage("deleted", "", { deleted: true });
  const liveEmpty = continuationMessage("empty", "");
  const live = continuationMessage("live", "keep me");
  const result = omitDeletedContinuationMessages([tombstone, liveEmpty, live]);
  assert.deepEqual(result.messages.map((message) => message.id), ["empty", "live"]);
  assert.deepEqual(result.omittedDeletedIds, ["deleted"]);
});

test("drops oldest history first so a large thread stays under the byte budget", () => {
  const origin = continuationMessage("origin", "trigger");
  const oldest = continuationMessage("oldest", "x".repeat(8_000));
  const middle = continuationMessage("middle", "y".repeat(8_000));
  const newest = continuationMessage("newest", "z".repeat(8_000));
  const envelope = {
    version: 1 as const,
    companyId: "company",
    issueId: "issue",
    trigger: { reason: "task_execution", interactionId: null, sourceRunId: null },
    originCommentIds: ["origin"],
    objective: "Do the work.",
    messages: [oldest, middle, origin, newest],
    interactionOutcomes: [],
    completedWork: null,
    unresolvedInteractionIds: [],
    coverage: {
      kind: "full_task_history",
      throughCommentId: "newest",
      summaryThroughCommentId: null,
    },
  };
  const bounded = boundExecutionContinuationEnvelope(envelope, ["origin"], 12_000);
  assert.ok(Buffer.byteLength(JSON.stringify(bounded), "utf8") <= 12_000);
  assert.equal(bounded.coverage.kind, "truncated_task_history");
  assert.equal(bounded.messages.some((message) => message.id === "oldest"), false);
  assert.equal(bounded.messages.some((message) => message.id === "origin"), true);
  assert.equal(bounded.messages.at(-1)?.id, "newest");
  assert.ok((bounded.coverage.omittedCount ?? 0) > 0);
});
