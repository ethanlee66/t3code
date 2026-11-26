// @effect-diagnostics globalDate:off -- Parses stored SQLite ISO timestamps into epoch millis for timezone day bucketing.
import {
  type UsageDay,
  type WorkspaceUsageDailyTotals,
  type WorkspaceUsageModelTotals,
  WorkspaceUsageReadError,
  type WorkspaceUsageStats,
  type WorkspaceUsageStatsInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { makeDayFormatter } from "./usageAggregation.ts";

// Pad coarse UTC query bounds so timezone offsets up to ±14h and DST shifts never miss boundary days.
const COARSE_SINCE_PADDING_MS = 26 * 3600_000;
const COARSE_UNTIL_PADDING_MS = 50 * 3600_000;
const encodeProjectIdsJson = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Array(Schema.String)),
);

interface MessageStatsRow {
  readonly threadId: unknown;
  readonly createdAt: unknown;
}

interface TurnStatsRow {
  readonly threadId: unknown;
  readonly rootThreadId: unknown;
  readonly isUserThread: unknown;
  readonly eventAt: unknown;
  readonly driver: unknown;
  readonly model: unknown;
  readonly inputTokens: unknown;
  readonly cachedInputTokens: unknown;
  readonly cacheCreationTokens: unknown;
  readonly outputTokens: unknown;
  readonly reasoningTokens: unknown;
  readonly otherInputTokens: unknown;
  readonly otherOutputTokens: unknown;
}

function nonNegativeInt(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseTimestampMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseUtcDayMs(day: string): number | null {
  const parsed = DateTime.make(`${day}T00:00:00Z`);
  return Option.isSome(parsed) ? DateTime.toEpochMillis(parsed.value) : null;
}

export class WorkspaceUsageService extends Context.Service<
  WorkspaceUsageService,
  {
    readonly readStats: (
      input: WorkspaceUsageStatsInput,
    ) => Effect.Effect<WorkspaceUsageStats, WorkspaceUsageReadError>;
  }
>()("t3/usage/WorkspaceUsageService") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const readStats = Effect.fn("WorkspaceUsageService.readStats")(function* (
    input: WorkspaceUsageStatsInput,
  ) {
    const sinceMs = input.sinceDay === undefined ? null : parseUtcDayMs(input.sinceDay);
    const untilMs = input.untilDay === undefined ? null : parseUtcDayMs(input.untilDay);
    if (
      (input.sinceDay !== undefined && sinceMs === null) ||
      (input.untilDay !== undefined && untilMs === null) ||
      (input.sinceDay !== undefined &&
        input.untilDay !== undefined &&
        input.sinceDay > input.untilDay)
    ) {
      return yield* new WorkspaceUsageReadError({ reason: "invalidWindow" });
    }

    const readAt = DateTime.formatIso(yield* DateTime.now);
    if (input.projectIds !== undefined && input.projectIds.length === 0) {
      return {
        readAt,
        timeZone: input.timeZone,
        sessions: 0,
        messages: 0,
        activeDays: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        cacheEligibleInputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        otherInputTokens: 0,
        otherOutputTokens: 0,
        totalTokens: 0,
        models: [],
        daily: [],
      } satisfies WorkspaceUsageStats;
    }

    const projectIdsJson =
      input.projectIds === undefined
        ? null
        : yield* encodeProjectIdsJson(input.projectIds).pipe(
            Effect.mapError(
              (cause) => new WorkspaceUsageReadError({ reason: "queryFailed", cause }),
            ),
          );
    const sinceUtc =
      sinceMs === null
        ? null
        : DateTime.formatIso(DateTime.makeUnsafe(sinceMs - COARSE_SINCE_PADDING_MS));
    const untilUtc =
      untilMs === null
        ? null
        : DateTime.formatIso(DateTime.makeUnsafe(untilMs + COARSE_UNTIL_PADDING_MS));

    const [messageRows, turnRows] = yield* Effect.all([
      sql<MessageStatsRow>`
        SELECT
          m.thread_id AS threadId,
          m.created_at AS createdAt
        FROM orchestration_v2_projection_messages m
        JOIN orchestration_v2_projection_threads t
          ON t.thread_id = m.thread_id
        WHERE t.deleted_at IS NULL
          AND COALESCE(json_extract(t.payload_json, '$.lineage.relationshipToParent'), '') != 'subagent'
          AND json_extract(t.payload_json, '$.delegatedFrom') IS NULL
          AND m.role IN ('user', 'assistant')
          ${projectIdsJson === null ? sql`` : sql`AND t.project_id IN (SELECT value FROM json_each(${projectIdsJson}))`}
          ${sinceUtc === null ? sql`` : sql`AND m.created_at >= ${sinceUtc}`}
          ${untilUtc === null ? sql`` : sql`AND m.created_at <= ${untilUtc}`}
      `,
      sql<TurnStatsRow>`
        SELECT
          pt.thread_id AS threadId,
          COALESCE(
            CASE
              WHEN json_extract(t.payload_json, '$.lineage.relationshipToParent') = 'subagent'
              THEN json_extract(t.payload_json, '$.lineage.parentThreadId')
              ELSE NULL
            END,
            pt.thread_id
          ) AS rootThreadId,
          CASE
            WHEN COALESCE(json_extract(t.payload_json, '$.lineage.relationshipToParent'), '') != 'subagent'
              AND json_extract(t.payload_json, '$.delegatedFrom') IS NULL
            THEN 1 ELSE 0
          END AS isUserThread,
          COALESCE(pt.completed_at, pt.started_at, r.completed_at, r.requested_at, t.updated_at) AS eventAt,
          COALESCE(
            NULLIF(pth.driver, ''),
            NULLIF(json_extract(r.payload_json, '$.driver'), ''),
            NULLIF(r.provider, ''),
            NULLIF(pth.provider, ''),
            t.default_provider
          ) AS driver,
          COALESCE(
            NULLIF(TRIM(json_extract(pt.payload_json, '$.model')), ''),
            NULLIF(TRIM(json_extract(pt.payload_json, '$.turnTokenUsage.models[0]')), ''),
            NULLIF(TRIM(json_extract(r.payload_json, '$.modelSelection.model')), ''),
            NULLIF(TRIM(json_extract(t.payload_json, '$.modelSelection.model')), '')
          ) AS model,
          json_extract(pt.payload_json, '$.turnTokenUsage.inputTokens') AS inputTokens,
          json_extract(pt.payload_json, '$.turnTokenUsage.cachedInputTokens') AS cachedInputTokens,
          json_extract(pt.payload_json, '$.turnTokenUsage.cacheCreationTokens') AS cacheCreationTokens,
          json_extract(pt.payload_json, '$.turnTokenUsage.outputTokens') AS outputTokens,
          json_extract(pt.payload_json, '$.turnTokenUsage.reasoningTokens') AS reasoningTokens,
          json_extract(pt.payload_json, '$.turnTokenUsage.otherUsage.inputTokens') AS otherInputTokens,
          json_extract(pt.payload_json, '$.turnTokenUsage.otherUsage.outputTokens') AS otherOutputTokens
        FROM orchestration_v2_projection_provider_turns pt
        JOIN orchestration_v2_projection_threads t
          ON t.thread_id = pt.thread_id
        LEFT JOIN orchestration_v2_projection_run_attempts ra
          ON ra.attempt_id = pt.run_attempt_id
        LEFT JOIN orchestration_v2_projection_runs r
          ON r.run_id = ra.run_id
        LEFT JOIN orchestration_v2_projection_provider_threads pth
          ON pth.provider_thread_id = pt.provider_thread_id
        WHERE t.deleted_at IS NULL
          ${projectIdsJson === null ? sql`` : sql`AND t.project_id IN (SELECT value FROM json_each(${projectIdsJson}))`}
          ${sinceUtc === null ? sql`` : sql`AND COALESCE(pt.completed_at, pt.started_at, r.completed_at, r.requested_at, t.updated_at) >= ${sinceUtc}`}
          ${untilUtc === null ? sql`` : sql`AND COALESCE(pt.completed_at, pt.started_at, r.completed_at, r.requested_at, t.updated_at) <= ${untilUtc}`}
      `,
    ]).pipe(
      Effect.mapError((cause) => new WorkspaceUsageReadError({ reason: "queryFailed", cause })),
    );

    const toDay = makeDayFormatter(input.timeZone);
    const inDayRange = (day: string) =>
      (input.sinceDay === undefined || day >= input.sinceDay) &&
      (input.untilDay === undefined || day <= input.untilDay);

    const sessionIds = new Set<string>();
    let messages = 0;
    let inputTokens = 0;
    let cachedInputTokens = 0;
    let cacheCreationTokens = 0;
    let cacheEligibleInputTokens = 0;
    let outputTokens = 0;
    let reasoningTokens = 0;
    let otherInputTokens = 0;
    let otherOutputTokens = 0;
    let totalTokens = 0;

    const dailyMap = new Map<
      string,
      { day: UsageDay; messages: number; turns: number; totalTokens: number }
    >();
    const ensureDay = (day: string) => {
      let entry = dailyMap.get(day);
      if (entry === undefined) {
        entry = { day: day as UsageDay, messages: 0, turns: 0, totalTokens: 0 };
        dailyMap.set(day, entry);
      }
      return entry;
    };

    const modelMap = new Map<
      string,
      {
        driver: string;
        model: string;
        inputTokens: number;
        cachedInputTokens: number;
        cacheCreationTokens: number;
        cacheEligibleInputTokens: number;
        outputTokens: number;
        reasoningTokens: number;
        otherInputTokens: number;
        otherOutputTokens: number;
        totalTokens: number;
        turns: number;
        sessions: Set<string>;
      }
    >();

    for (const row of messageRows) {
      const createdAtMs = parseTimestampMs(row.createdAt);
      if (createdAtMs === null) continue;
      const day = toDay(createdAtMs);
      if (!inDayRange(day)) continue;
      const threadId = nonEmptyString(row.threadId);
      if (threadId !== null) sessionIds.add(threadId);
      messages += 1;
      ensureDay(day).messages += 1;
    }

    for (const row of turnRows) {
      const eventAtMs = parseTimestampMs(row.eventAt);
      if (eventAtMs === null) continue;
      const day = toDay(eventAtMs);
      if (!inDayRange(day)) continue;

      const threadId = nonEmptyString(row.threadId);
      if (row.isUserThread === 1 && threadId !== null) {
        sessionIds.add(threadId);
      }

      const inputCount = nonNegativeInt(row.inputTokens) ?? 0;
      const rawCached = nonNegativeInt(row.cachedInputTokens);
      const cachedCount = rawCached === null ? 0 : Math.min(inputCount, rawCached);
      const cacheEligibleCount = rawCached === null ? 0 : inputCount;
      const cacheCreationCount = nonNegativeInt(row.cacheCreationTokens) ?? 0;
      const outputCount = nonNegativeInt(row.outputTokens) ?? 0;
      const reasoningCount = Math.min(outputCount, nonNegativeInt(row.reasoningTokens) ?? 0);
      const otherInputCount = nonNegativeInt(row.otherInputTokens) ?? 0;
      const otherOutputCount = nonNegativeInt(row.otherOutputTokens) ?? 0;
      const turnTotal = inputCount + outputCount + otherInputCount + otherOutputCount;

      inputTokens += inputCount;
      cachedInputTokens += cachedCount;
      cacheCreationTokens += cacheCreationCount;
      cacheEligibleInputTokens += cacheEligibleCount;
      outputTokens += outputCount;
      reasoningTokens += reasoningCount;
      otherInputTokens += otherInputCount;
      otherOutputTokens += otherOutputCount;
      totalTokens += turnTotal;

      const dayEntry = ensureDay(day);
      dayEntry.turns += 1;
      dayEntry.totalTokens += turnTotal;

      const model = nonEmptyString(row.model);
      if (model !== null) {
        const driver = nonEmptyString(row.driver) ?? "unknown";
        const key = `${driver}\0${model}`;
        let modelEntry = modelMap.get(key);
        if (modelEntry === undefined) {
          modelEntry = {
            driver,
            model,
            inputTokens: 0,
            cachedInputTokens: 0,
            cacheCreationTokens: 0,
            cacheEligibleInputTokens: 0,
            outputTokens: 0,
            reasoningTokens: 0,
            otherInputTokens: 0,
            otherOutputTokens: 0,
            totalTokens: 0,
            turns: 0,
            sessions: new Set(),
          };
          modelMap.set(key, modelEntry);
        }
        modelEntry.inputTokens += inputCount;
        modelEntry.cachedInputTokens += cachedCount;
        modelEntry.cacheCreationTokens += cacheCreationCount;
        modelEntry.cacheEligibleInputTokens += cacheEligibleCount;
        modelEntry.outputTokens += outputCount;
        modelEntry.reasoningTokens += reasoningCount;
        modelEntry.otherInputTokens += otherInputCount;
        modelEntry.otherOutputTokens += otherOutputCount;
        modelEntry.totalTokens += turnTotal;
        modelEntry.turns += 1;
        const rootThreadId = nonEmptyString(row.rootThreadId) ?? threadId;
        if (rootThreadId !== null) modelEntry.sessions.add(rootThreadId);
      }
    }

    const models: WorkspaceUsageModelTotals[] = [...modelMap.values()]
      .map(({ sessions, ...entry }) => ({
        ...entry,
        sessions: sessions.size,
      }))
      .sort(
        (left, right) =>
          right.totalTokens - left.totalTokens ||
          right.turns - left.turns ||
          left.model.localeCompare(right.model),
      );

    const daily: WorkspaceUsageDailyTotals[] = [...dailyMap.values()].sort((left, right) =>
      left.day.localeCompare(right.day),
    );
    const activeDays = daily.filter(
      (entry) => entry.messages > 0 || entry.turns > 0 || entry.totalTokens > 0,
    ).length;

    return {
      readAt,
      timeZone: input.timeZone,
      sessions: sessionIds.size,
      messages,
      activeDays,
      inputTokens,
      cachedInputTokens,
      cacheCreationTokens,
      cacheEligibleInputTokens,
      outputTokens,
      reasoningTokens,
      otherInputTokens,
      otherOutputTokens,
      totalTokens,
      models,
      daily,
    } satisfies WorkspaceUsageStats;
  });

  return WorkspaceUsageService.of({ readStats });
});

export const layer = Layer.effect(WorkspaceUsageService, make);
