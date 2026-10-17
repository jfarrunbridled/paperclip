import { describe, expect, it } from "vitest";
import {
  boundExecutionContinuationEnvelope,
  omitDeletedContinuationMessages,
} from "./execution-continuation-budget.js";

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

describe("execution continuation budget", () => {
  it("omits deleted tombstones and keeps live empty bodies", () => {
    const tombstone = continuationMessage("deleted", "", { deleted: true });
    const liveEmpty = continuationMessage("empty", "");
    const live = continuationMessage("live", "keep me");
    const result = omitDeletedContinuationMessages([tombstone, liveEmpty, live]);
    expect(result.messages.map((message) => message.id)).toEqual(["empty", "live"]);
    expect(result.omittedDeletedIds).toEqual(["deleted"]);
  });

  it("drops oldest history first so a large thread stays under the byte budget", () => {
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
    expect(new TextEncoder().encode(JSON.stringify(bounded)).byteLength).toBeLessThanOrEqual(12_000);
    expect(bounded.coverage.kind).toBe("truncated_task_history");
    expect(bounded.messages.map((message) => message.id)).not.toContain("oldest");
    expect(bounded.messages.map((message) => message.id)).toContain("origin");
    expect(bounded.messages.at(-1)?.id).toBe("newest");
    expect(bounded.coverage.omittedCount).toBeGreaterThan(0);
  });
});
