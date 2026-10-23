import { and, eq, isNull } from "drizzle-orm";
import { heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { parseObject } from "../../adapters/utils.js";
import { logActivity } from "../activity-log.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "../delivery-work-notifications.js";
import {
  FAILED_WAKE_MONITOR_REARM_DELAY_MS,
  buildIssueMonitorRearmedAfterFailedWakePatch,
  isIssueMonitorFailedWakeReason,
  normalizeIssueExecutionPolicy,
  parseIssueExecutionState,
  shouldRearmIssueMonitorAfterFailedWake,
} from "../issue-execution-policy.js";

type Run = typeof heartbeatRuns.$inferSelect;

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readOriginatingNextCheckAt(run: Pick<Run, "contextSnapshot">) {
  const context = parseObject(run.contextSnapshot);
  const payload = parseObject(context.payload);
  return (
    readNonEmptyString(context.nextCheckAt) ??
    readNonEmptyString(payload.nextCheckAt)
  );
}

export function retryOutcomeOwnsNextAttempt(result: unknown) {
  return Boolean(
    result &&
      typeof result === "object" &&
      "outcome" in result &&
      (result as { outcome?: unknown }).outcome === "scheduled",
  );
}

function readMonitorBounds(issue: typeof issues.$inferSelect) {
  const parsed = parseIssueExecutionState(issue.executionState)?.monitor ?? null;
  const raw = parseObject(parseObject(issue.executionState).monitor);
  const maxAttempts =
    parsed?.maxAttempts ??
    (typeof raw.maxAttempts === "number" ? raw.maxAttempts : null);
  const timeoutAt =
    parsed?.timeoutAt ??
    (typeof raw.timeoutAt === "string" ? raw.timeoutAt : null);
  return {
    parsed,
    maxAttempts,
    timeoutAt,
    attemptCount: issue.monitorAttemptCount ?? parsed?.attemptCount ?? 0,
  };
}

function issueIdFromRun(run: Run): string | null {
  const context = parseObject(run.contextSnapshot);
  return readNonEmptyString(context.issueId) ?? readNonEmptyString(context.taskId);
}

export async function rearmIssueMonitorAfterFailedWake(
  db: Db,
  run: Pick<Run, "id" | "companyId" | "agentId" | "status" | "contextSnapshot">,
  now = new Date(),
  opts?: { retryOwnsNextAttempt?: boolean },
): Promise<{ rearmed: boolean; nextCheckAt?: Date }> {
  const context = parseObject(run.contextSnapshot);
  const wakeReason = readNonEmptyString(context.wakeReason);
  const wakeSource = readNonEmptyString(context.source);
  if (!isIssueMonitorFailedWakeReason(wakeReason, wakeSource)) {
    return { rearmed: false };
  }
  if (opts?.retryOwnsNextAttempt) return { rearmed: false };

  const issueId = issueIdFromRun(run as Run);
  if (!issueId) return { rearmed: false };
  const originatingNextCheckAt = readOriginatingNextCheckAt(run);

  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    const [issue] = await tx
      .select()
      .from(issues)
      .where(and(eq(issues.id, issueId), eq(issues.companyId, run.companyId)))
      .for("update")
      .limit(1);
    if (!issue) return { rearmed: false };

    const [runComment] = await tx
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(
        and(
          eq(issueComments.issueId, issue.id),
          eq(issueComments.createdByRunId, run.id),
          isNull(issueComments.deletedAt),
        ),
      )
      .limit(1);

    const bounds = readMonitorBounds(issue);
    if (
      !shouldRearmIssueMonitorAfterFailedWake({
        runStatus: run.status,
        wakeReason,
        wakeSource,
        issueStatus: issue.status,
        assigneeAgentId: issue.assigneeAgentId,
        assigneeUserId: issue.assigneeUserId,
        monitorStatus: bounds.parsed?.status ?? (issue.monitorNextCheckAt ? "scheduled" : "triggered"),
        monitorNextCheckAt: issue.monitorNextCheckAt,
        originatingNextCheckAt,
        retryOwnsNextAttempt: opts?.retryOwnsNextAttempt,
        attemptCount: bounds.attemptCount,
        maxAttempts: bounds.maxAttempts,
        timeoutAt: bounds.timeoutAt,
        postedComment: Boolean(runComment),
        now,
      })
    ) {
      return { rearmed: false };
    }

    const nextCheckAt = new Date(now.getTime() + FAILED_WAKE_MONITOR_REARM_DELAY_MS);
    const issueForPatch = bounds.parsed
      ? issue
      : {
          ...issue,
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
              status: issue.monitorNextCheckAt ? "scheduled" : "triggered",
              nextCheckAt: issue.monitorNextCheckAt?.toISOString() ?? null,
              lastTriggeredAt: issue.monitorLastTriggeredAt?.toISOString() ?? null,
              attemptCount: bounds.attemptCount,
              notes: issue.monitorNotes ?? null,
              scheduledBy: issue.monitorScheduledBy === "board" ? "board" : "assignee",
              maxAttempts: bounds.maxAttempts,
              timeoutAt: bounds.timeoutAt,
              clearedAt: null,
              clearReason: null,
            },
          },
        };
    const policy = normalizeIssueExecutionPolicy(issue.executionPolicy);
    const patch = buildIssueMonitorRearmedAfterFailedWakePatch({
      issue: issueForPatch,
      policy,
      nextCheckAt,
      originatingNextCheckAt,
      now,
    });
    if (!patch) return { rearmed: false };

    const { restoredMonitor: _restoredMonitor, ...issuePatch } = patch;
    await notifyDeliveryWork(tx, DELIVERY_QUEUES.issueMonitors);
    const updated = await tx
      .update(issues)
      .set({
        ...issuePatch,
        updatedAt: now,
      })
      .where(
        and(
          eq(issues.id, issue.id),
          eq(issues.companyId, run.companyId),
          eq(issues.status, issue.status),
          issue.monitorNextCheckAt
            ? eq(issues.monitorNextCheckAt, issue.monitorNextCheckAt)
            : isNull(issues.monitorNextCheckAt),
        ),
      )
      .returning({ id: issues.id, monitorNextCheckAt: issues.monitorNextCheckAt });

    if (updated.length === 0) return { rearmed: false };

    await logActivity(tx, {
      companyId: issue.companyId,
      actorType: "system",
      actorId: "heartbeat_scheduler",
      agentId: run.agentId,
      runId: run.id,
      action: "issue.monitor_rearmed_after_failed_wake",
      entityType: "issue",
      entityId: issue.id,
      details: {
        identifier: issue.identifier,
        source: "failed_wake",
        nextCheckAt: nextCheckAt.toISOString(),
        attemptCount: issuePatch.monitorAttemptCount,
        maxAttempts: bounds.maxAttempts,
        failedRunId: run.id,
        failedRunStatus: run.status,
      },
    });

    return { rearmed: true, nextCheckAt };
  });
}
