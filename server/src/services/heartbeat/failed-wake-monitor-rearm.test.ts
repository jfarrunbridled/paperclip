import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agents,
  companies,
  createDb,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { FAILED_WAKE_MONITOR_REARM_DELAY_MS, parseIssueExecutionState } from "../issue-execution-policy.js";
import { rearmIssueMonitorAfterFailedWake } from "./failed-wake-monitor-rearm.js";

const postgres = await getEmbeddedPostgresTestSupport();

describe.skipIf(!postgres.supported)("failed-wake issue monitor re-arm", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-failed-wake-monitor-rearm");
    db = createDb(database.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await db?.$client.end();
    await database?.cleanup();
  });

  beforeEach(async () => {
    await db.execute(sql`truncate table companies restart identity cascade`);
  });

  async function fixture(overrides: {
    status?: string;
    runStatus?: string;
    wakeReason?: string;
    attemptCount?: number;
    maxAttempts?: number | null;
    monitorNextCheckAt?: Date | null;
    withComment?: boolean;
  } = {}) {
    const triggeredAt = new Date("2026-10-16T00:05:15.000Z");
    const [company] = await db.insert(companies).values({ name: "Rearm", issuePrefix: "ARM" }).returning();
    const [agent] = await db.insert(agents).values({
      companyId: company.id,
      name: "Monitor agent",
      adapterType: "process",
    }).returning();
    const maxAttempts = overrides.maxAttempts === undefined ? 4 : overrides.maxAttempts;
    const attemptCount = overrides.attemptCount ?? 1;
    const [issue] = await db.insert(issues).values({
      companyId: company.id,
      title: "Spent monitor",
      status: overrides.status ?? "in_progress",
      assigneeAgentId: agent.id,
      monitorNextCheckAt: overrides.monitorNextCheckAt ?? null,
      monitorAttemptCount: attemptCount,
      monitorLastTriggeredAt: triggeredAt,
      monitorNotes: "Check deployment",
      monitorScheduledBy: "assignee",
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
          status: "triggered",
          nextCheckAt: null,
          lastTriggeredAt: triggeredAt.toISOString(),
          attemptCount,
          notes: "Check deployment",
          scheduledBy: "assignee",
          maxAttempts,
          timeoutAt: "2026-10-23T00:00:00.000Z",
          clearedAt: null,
          clearReason: null,
        },
      },
    }).returning();
    const [run] = await db.insert(heartbeatRuns).values({
      companyId: company.id,
      agentId: agent.id,
      status: overrides.runStatus ?? "failed",
      errorCode: "adapter_failed",
      exitCode: 143,
      finishedAt: new Date("2026-10-16T00:13:43.000Z"),
      contextSnapshot: {
        issueId: issue.id,
        source: "issue.monitor",
        wakeReason: overrides.wakeReason ?? "issue_monitor_due",
      },
    }).returning();
    if (overrides.withComment) {
      await db.insert(issueComments).values({
        companyId: company.id,
        issueId: issue.id,
        authorAgentId: agent.id,
        createdByRunId: run.id,
        body: "Monitor wake posted a comment",
      });
    }
    return { company, agent, issue, run, now: new Date("2026-10-16T00:13:43.000Z") };
  }

  async function readIssue(id: string) {
    return db.select().from(issues).where(eq(issues.id, id)).then((rows) => rows[0]!);
  }

  it("restores nextCheckAt ~60s after adapter_failed with no comment and leaves attemptCount unchanged", async () => {
    const f = await fixture();
    const result = await rearmIssueMonitorAfterFailedWake(db, f.run, f.now);
    expect(result.rearmed).toBe(true);
    const issue = await readIssue(f.issue.id);
    expect(issue.monitorNextCheckAt?.toISOString()).toBe(
      new Date(f.now.getTime() + FAILED_WAKE_MONITOR_REARM_DELAY_MS).toISOString(),
    );
    expect(issue.monitorAttemptCount).toBe(1);
    expect(parseIssueExecutionState(issue.executionState)?.monitor).toMatchObject({
      status: "scheduled",
      attemptCount: 1,
      maxAttempts: 4,
    });
    const activity = await db.select().from(activityLog).where(eq(activityLog.entityId, f.issue.id));
    expect(activity.map((row) => row.action)).toContain("issue.monitor_rearmed_after_failed_wake");
  });

  it("stays spent when the failed wake already posted a comment", async () => {
    const f = await fixture({ withComment: true });
    expect(await rearmIssueMonitorAfterFailedWake(db, f.run, f.now)).toEqual({ rearmed: false });
    expect((await readIssue(f.issue.id)).monitorNextCheckAt).toBeNull();
  });

  it("does not overwrite a later agent PATCH that already set nextCheckAt", async () => {
    const existing = new Date("2026-10-17T00:00:30.000Z");
    const f = await fixture({ monitorNextCheckAt: existing });
    expect(await rearmIssueMonitorAfterFailedWake(db, f.run, f.now)).toEqual({ rearmed: false });
    expect((await readIssue(f.issue.id)).monitorNextCheckAt).toEqual(existing);
  });

  it("does not re-arm when attemptCount already equals maxAttempts", async () => {
    const f = await fixture({ attemptCount: 4, maxAttempts: 4 });
    expect(await rearmIssueMonitorAfterFailedWake(db, f.run, f.now)).toEqual({ rearmed: false });
    expect((await readIssue(f.issue.id)).monitorNextCheckAt).toBeNull();
  });

  it("re-arms even when a pending confirmation exists on the issue", async () => {
    const f = await fixture();
    await db.insert(issueComments).values([{
      companyId: f.company.id,
      issueId: f.issue.id,
      authorType: "user",
      body: "Pending confirmation is adapter-retry, not monitor schedule",
    }]);
    const result = await rearmIssueMonitorAfterFailedWake(db, f.run, f.now);
    expect(result.rearmed).toBe(true);
    expect((await readIssue(f.issue.id)).monitorNextCheckAt).not.toBeNull();
  });

  it("does not re-arm after a todo wipe; that path is not this failed-wake hole", async () => {
    const f = await fixture({ status: "todo" });
    expect(await rearmIssueMonitorAfterFailedWake(db, f.run, f.now)).toEqual({ rearmed: false });
    expect((await readIssue(f.issue.id)).monitorNextCheckAt).toBeNull();
  });
});
