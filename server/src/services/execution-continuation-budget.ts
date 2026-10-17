export const MAX_EXECUTION_CONTINUATION_JSON_BYTES = 80 * 1024;
export const MAX_EXECUTION_CONTINUATION_OBJECTIVE_CHARS = 12_000;

export type ContinuationMessageLike = {
  id: string;
  body: string;
  deleted: boolean;
};

export type ContinuationEnvelopeLike<TMessage extends ContinuationMessageLike> = {
  objective: string;
  messages: TMessage[];
  resumeDelta?: { baseRunId: string; messages: TMessage[] };
  coverage: {
    kind: string;
    throughCommentId: string | null;
    summaryThroughCommentId: null;
    omittedCount?: number;
    oldestRetainedCommentId?: string | null;
    omittedDeletedIds?: string[];
  };
};

export function omitDeletedContinuationMessages<TMessage extends ContinuationMessageLike>(
  messages: TMessage[],
): { messages: TMessage[]; omittedDeletedIds: string[] } {
  const omittedDeletedIds: string[] = [];
  const kept: TMessage[] = [];
  for (const message of messages) {
    if (message.deleted) {
      omittedDeletedIds.push(message.id);
      continue;
    }
    kept.push(message);
  }
  return { messages: kept, omittedDeletedIds };
}

export function capExecutionContinuationObjective(objective: string): string {
  return objective.length <= MAX_EXECUTION_CONTINUATION_OBJECTIVE_CHARS
    ? objective
    : objective.slice(0, MAX_EXECUTION_CONTINUATION_OBJECTIVE_CHARS);
}

function continuationUtf8Bytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export function boundExecutionContinuationEnvelope<
  TMessage extends ContinuationMessageLike,
  TEnvelope extends ContinuationEnvelopeLike<TMessage>,
>(
  envelope: TEnvelope,
  originCommentIds: string[],
  budgetBytes = MAX_EXECUTION_CONTINUATION_JSON_BYTES,
): TEnvelope & ContinuationEnvelopeLike<TMessage> {
  const originSet = new Set(originCommentIds);
  let messages = envelope.messages.slice();
  let resumeMessages = envelope.resumeDelta?.messages.slice() ?? null;
  let omittedCount = 0;
  let emptiedOriginBodies = false;
  const objective = capExecutionContinuationObjective(envelope.objective);

  const apply = (): TEnvelope => ({
    ...envelope,
    objective,
    messages,
    ...(envelope.resumeDelta && resumeMessages
      ? { resumeDelta: { ...envelope.resumeDelta, messages: resumeMessages } }
      : {}),
  });

  let current = apply();
  const overBudget = () => continuationUtf8Bytes(current) > budgetBytes;
  const dropOldest = (
    list: TMessage[],
    preferNonOrigin: boolean,
  ): { list: TMessage[]; dropped: boolean; emptied: boolean } => {
    const dropIndex = preferNonOrigin
      ? list.findIndex((message) => !originSet.has(message.id))
      : -1;
    if (dropIndex >= 0) {
      return {
        list: list.filter((_, index) => index !== dropIndex),
        dropped: true,
        emptied: false,
      };
    }
    const bulkyIndex = list.findIndex((message) => message.body.length > 0);
    if (bulkyIndex >= 0) {
      return {
        list: list.map((message, index) =>
          index === bulkyIndex ? { ...message, body: "" } : message,
        ),
        dropped: true,
        emptied: originSet.has(list[bulkyIndex]!.id),
      };
    }
    return { list, dropped: false, emptied: false };
  };

  while (overBudget()) {
    const fromHistory = dropOldest(messages, true);
    if (fromHistory.dropped) {
      if (fromHistory.list.length < messages.length) omittedCount += 1;
      if (fromHistory.emptied) emptiedOriginBodies = true;
      messages = fromHistory.list;
      current = apply();
      continue;
    }
    if (resumeMessages) {
      const fromDelta = dropOldest(resumeMessages, true);
      if (fromDelta.dropped) {
        if (fromDelta.list.length < resumeMessages.length) omittedCount += 1;
        if (fromDelta.emptied) emptiedOriginBodies = true;
        resumeMessages = fromDelta.list;
        current = apply();
        continue;
      }
    }
    const fromOrigins = dropOldest(messages, false);
    if (fromOrigins.dropped) {
      if (fromOrigins.emptied) emptiedOriginBodies = true;
      messages = fromOrigins.list;
      current = apply();
      continue;
    }
    break;
  }

  const truncated =
    omittedCount > 0 ||
    emptiedOriginBodies ||
    objective !== envelope.objective;
  return {
    ...current,
    coverage: {
      ...current.coverage,
      kind: truncated ? "truncated_task_history" : current.coverage.kind,
      throughCommentId: messages.at(-1)?.id ?? current.coverage.throughCommentId,
      ...(truncated
        ? {
            omittedCount,
            oldestRetainedCommentId: messages[0]?.id ?? null,
          }
        : {}),
    },
  };
}
