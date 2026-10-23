import { describe, expect, it } from "vitest";
import {
  FAILED_WAKE_MONITOR_REARM_DELAY_MS,
  buildIssueMonitorRearmedAfterFailedWakePatch,
  buildIssueMonitorTriggeredPatch,
  shouldRearmIssueMonitorAfterFailedWake,
} from "./issue-execution-policy.js";

const agentId = "11111111-1111-4111-8111-111111111111";

describe("failed-wake monitor re-arm helpers", () => {
  it("keeps consume-on-fire and restores a scheduled monitor without bumping attemptCount", () => {
    const triggeredAt = new Date("2026-10-16T00:05:15.000Z");
    const nextCheckAt = new Date(triggeredAt.getTime() + FAILED_WAKE_MONITOR_REARM_DELAY_MS);
    const triggered = buildIssueMonitorTriggeredPatch({
      issue: {
        status: "in_progress",
        assigneeAgentId: agentId,
        assigneeUserId: null,
        executionPolicy: null,
        executionState: null,
        monitorAttemptCount: 0,
        monitorNextCheckAt: new Date("2026-10-16T00:05:00.000Z"),
        monitorLastTriggeredAt: null,
        monitorNotes: "Check deployment",
        monitorScheduledBy: "assignee",
      },
      policy: {
        mode: "normal",
        commentRequired: true,
        stages: [],
        monitor: {
          nextCheckAt: "2026-10-16T00:05:00.000Z",
          notes: "Check deployment",
          scheduledBy: "assignee",
          maxAttempts: 4,
        },
      },
      triggeredAt,
    });
    expect(triggered.monitorNextCheckAt).toBeNull();
    expect(triggered.monitorAttemptCount).toBe(1);

    const rearmed = buildIssueMonitorRearmedAfterFailedWakePatch({
      issue: {
        status: "in_progress",
        assigneeAgentId: agentId,
        assigneeUserId: null,
        executionPolicy: null,
        executionState: triggered.executionState,
        monitorAttemptCount: 1,
        monitorNextCheckAt: null,
        monitorLastTriggeredAt: triggeredAt,
        monitorNotes: "Check deployment",
        monitorScheduledBy: "assignee",
      },
      policy: null,
      nextCheckAt,
    })!;
    expect(rearmed.monitorNextCheckAt).toEqual(nextCheckAt);
    expect(rearmed.monitorAttemptCount).toBe(1);
    expect(rearmed.executionState).toMatchObject({
      monitor: { status: "scheduled", attemptCount: 1, maxAttempts: 4 },
    });
  });

  it("does not treat maxAttempts as retry-on-failed-wake", () => {
    const base = {
      runStatus: "failed",
      wakeReason: "issue_monitor_due",
      issueStatus: "in_progress",
      assigneeAgentId: agentId,
      assigneeUserId: null,
      monitorNextCheckAt: null as Date | null,
      attemptCount: 1,
      maxAttempts: 4 as number | null,
      postedComment: false,
    };
    expect(shouldRearmIssueMonitorAfterFailedWake(base)).toBe(true);
    expect(shouldRearmIssueMonitorAfterFailedWake({ ...base, postedComment: true })).toBe(false);
    expect(shouldRearmIssueMonitorAfterFailedWake({ ...base, monitorNextCheckAt: new Date() })).toBe(false);
    expect(shouldRearmIssueMonitorAfterFailedWake({ ...base, attemptCount: 4 })).toBe(false);
    expect(shouldRearmIssueMonitorAfterFailedWake({ ...base, issueStatus: "todo" })).toBe(false);
    expect(shouldRearmIssueMonitorAfterFailedWake({ ...base, maxAttempts: null })).toBe(true);
    expect(shouldRearmIssueMonitorAfterFailedWake({ ...base, monitorStatus: "cleared" })).toBe(false);
    expect(shouldRearmIssueMonitorAfterFailedWake({ ...base, monitorStatus: "triggered" })).toBe(true);
    expect(shouldRearmIssueMonitorAfterFailedWake({ ...base, retryOwnsNextAttempt: true })).toBe(false);
    const originating = new Date("2026-10-16T00:05:00.000Z");
    expect(
      shouldRearmIssueMonitorAfterFailedWake({
        ...base,
        monitorStatus: "scheduled",
        monitorNextCheckAt: originating,
        originatingNextCheckAt: originating,
      }),
    ).toBe(true);
    expect(
      shouldRearmIssueMonitorAfterFailedWake({
        ...base,
        monitorStatus: "scheduled",
        monitorNextCheckAt: originating,
        originatingNextCheckAt: new Date("2026-10-17T00:00:30.000Z"),
      }),
    ).toBe(false);
  });

  it("does not restore a monitor that was cleared after fire", () => {
    const triggeredAt = new Date("2026-10-16T00:05:15.000Z");
    const nextCheckAt = new Date(triggeredAt.getTime() + FAILED_WAKE_MONITOR_REARM_DELAY_MS);
    const rearmed = buildIssueMonitorRearmedAfterFailedWakePatch({
      issue: {
        status: "in_progress",
        assigneeAgentId: agentId,
        assigneeUserId: null,
        executionPolicy: null,
        executionState: {
          status: "idle",
          currentStageId: null,
          currentStageIndex: null,
          currentStageType: null,
          currentParticipant: null,
          returnAssignee: null,
          completedStageIds: [],
          lastDecisionId: null,
          lastDecisionOutcome: null,
          monitor: {
            status: "cleared",
            nextCheckAt: null,
            lastTriggeredAt: triggeredAt.toISOString(),
            attemptCount: 1,
            notes: "Check deployment",
            scheduledBy: "assignee",
            maxAttempts: 4,
            timeoutAt: null,
            clearedAt: nextCheckAt.toISOString(),
            clearReason: "cancelled",
          },
        },
        monitorAttemptCount: 1,
        monitorNextCheckAt: null,
        monitorLastTriggeredAt: triggeredAt,
        monitorNotes: "Check deployment",
        monitorScheduledBy: "assignee",
      },
      policy: null,
      nextCheckAt,
    });
    expect(rearmed).toBeNull();
  });
});
