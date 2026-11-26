import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProjectId, UsageDay, WorkspaceUsageReadError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as Sqlite from "../persistence/Sqlite.ts";
import * as WorkspaceUsageService from "./WorkspaceUsageService.ts";

const testLayer = WorkspaceUsageService.layer.pipe(
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provide(NodeServices.layer),
);

interface SeedThreadInput {
  readonly id: string;
  readonly projectId: string;
  readonly defaultProvider?: string;
  readonly deletedAt?: string | null;
  readonly modelSelectionModel?: string;
  readonly relationshipToParent?: "subagent" | "fork" | null;
  readonly parentThreadId?: string | null;
  readonly delegatedFrom?: Record<string, unknown> | null;
}

const seedThread = Effect.fn("test.seedThread")(function* (input: SeedThreadInput) {
  const sql = yield* SqlClient.SqlClient;
  const payload = {
    ...(input.modelSelectionModel === undefined
      ? {}
      : {
          modelSelection: {
            instanceId: input.defaultProvider ?? "codex",
            model: input.modelSelectionModel,
          },
        }),
    ...(input.relationshipToParent != null || input.parentThreadId != null
      ? {
          lineage: {
            parentThreadId: input.parentThreadId ?? null,
            relationshipToParent: input.relationshipToParent ?? null,
          },
        }
      : {}),
    ...(input.delegatedFrom !== undefined && input.delegatedFrom !== null
      ? { delegatedFrom: input.delegatedFrom }
      : {}),
  };
  yield* sql`
    INSERT INTO orchestration_v2_projection_threads (
      thread_id,
      project_id,
      title,
      default_provider,
      runtime_mode,
      interaction_mode,
      active_provider_thread_id,
      created_at,
      updated_at,
      archived_at,
      deleted_at,
      payload_json
    )
    VALUES (
      ${input.id},
      ${input.projectId},
      ${input.id},
      ${input.defaultProvider ?? "codex"},
      'full-access',
      'default',
      NULL,
      '2026-11-20T00:00:00.000Z',
      '2026-11-20T00:00:00.000Z',
      NULL,
      ${input.deletedAt ?? null},
      ${JSON.stringify(payload)}
    )
  `;
});

const seedMessage = Effect.fn("test.seedMessage")(function* (input: {
  readonly id: string;
  readonly threadId: string;
  readonly role: "user" | "assistant" | "system";
  readonly createdAt: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO orchestration_v2_projection_messages (
      message_id,
      thread_id,
      run_id,
      node_id,
      role,
      streaming,
      created_at,
      updated_at,
      payload_json
    )
    VALUES (
      ${input.id},
      ${input.threadId},
      NULL,
      NULL,
      ${input.role},
      0,
      ${input.createdAt},
      ${input.createdAt},
      '{}'
    )
  `;
});

const seedTurn = Effect.fn("test.seedTurn")(function* (input: {
  readonly id: string;
  readonly threadId: string;
  readonly ordinal: number;
  readonly provider?: string;
  readonly driver?: string;
  readonly runModel?: string;
  readonly turnModel?: string;
  readonly completedAt?: string | null;
  readonly startedAt?: string | null;
  readonly turnTokenUsage?: Record<string, unknown>;
}) {
  const sql = yield* SqlClient.SqlClient;
  const providerThreadId = `pth-${input.threadId}`;
  const runId = `run-${input.id}`;
  const attemptId = `att-${input.id}`;
  const driver = input.driver ?? input.provider ?? "codex";
  const provider = input.provider ?? driver;

  yield* sql`
    INSERT OR IGNORE INTO orchestration_v2_projection_provider_threads (
      provider_thread_id,
      thread_id,
      owner_node_id,
      provider,
      provider_session_id,
      status,
      updated_at,
      payload_json,
      driver,
      provider_instance_id
    )
    VALUES (
      ${providerThreadId},
      ${input.threadId},
      NULL,
      ${provider},
      NULL,
      'idle',
      '2026-11-20T00:00:00.000Z',
      '{}',
      ${driver},
      ${provider}
    )
  `;

  if (input.runModel !== undefined) {
    yield* sql`
      INSERT INTO orchestration_v2_projection_runs (
        run_id,
        thread_id,
        ordinal,
        provider,
        provider_thread_id,
        status,
        requested_at,
        completed_at,
        payload_json,
        provider_instance_id
      )
      VALUES (
        ${runId},
        ${input.threadId},
        ${input.ordinal},
        ${provider},
        ${providerThreadId},
        'completed',
        ${input.startedAt ?? input.completedAt ?? "2026-11-20T00:00:00.000Z"},
        ${input.completedAt ?? null},
        ${JSON.stringify({ modelSelection: { instanceId: provider, model: input.runModel } })},
        ${provider}
      )
    `;
    yield* sql`
      INSERT INTO orchestration_v2_projection_run_attempts (
        attempt_id,
        thread_id,
        run_id,
        attempt_ordinal,
        root_node_id,
        provider,
        provider_thread_id,
        provider_turn_id,
        status,
        payload_json,
        provider_instance_id
      )
      VALUES (
        ${attemptId},
        ${input.threadId},
        ${runId},
        1,
        ${`node-${input.id}`},
        ${provider},
        ${providerThreadId},
        ${input.id},
        'completed',
        '{}',
        ${provider}
      )
    `;
  }

  const turnPayload = {
    ...(input.turnModel === undefined ? {} : { model: input.turnModel }),
    ...(input.turnTokenUsage === undefined ? {} : { turnTokenUsage: input.turnTokenUsage }),
  };

  yield* sql`
    INSERT INTO orchestration_v2_projection_provider_turns (
      provider_turn_id,
      thread_id,
      provider_thread_id,
      node_id,
      run_attempt_id,
      ordinal,
      status,
      started_at,
      completed_at,
      payload_json
    )
    VALUES (
      ${input.id},
      ${input.threadId},
      ${providerThreadId},
      ${`node-${input.id}`},
      ${input.runModel === undefined ? null : attemptId},
      ${input.ordinal},
      'completed',
      ${input.startedAt ?? null},
      ${input.completedAt ?? null},
      ${JSON.stringify(turnPayload)}
    )
  `;
});

describe("WorkspaceUsageService", () => {
  it.effect(
    "aggregates sessions, messages, tokens, models, and excludes deleted/subagent shell noise",
    () =>
      Effect.gen(function* () {
        const p1 = ProjectId.make("project-1");
        const p2 = ProjectId.make("project-2");

        yield* seedThread({ id: "t-main", projectId: p1, defaultProvider: "claudeAgent" });
        yield* seedThread({
          id: "t-sub",
          projectId: p1,
          defaultProvider: "codex",
          relationshipToParent: "subagent",
          parentThreadId: "t-main",
        });
        yield* seedThread({
          id: "t-delegated",
          projectId: p1,
          defaultProvider: "codex",
          delegatedFrom: { environmentId: "env-remote" },
        });
        yield* seedThread({
          id: "t-deleted",
          projectId: p1,
          defaultProvider: "codex",
          deletedAt: "2026-11-21T00:00:00.000Z",
        });
        yield* seedThread({ id: "t-other", projectId: p2, defaultProvider: "codex" });

        // User + assistant messages on t-main; system message should be ignored; subagent/deleted messages excluded.
        yield* seedMessage({
          id: "m-1",
          threadId: "t-main",
          role: "user",
          createdAt: "2026-11-20T10:00:00.000Z",
        });
        yield* seedMessage({
          id: "m-2",
          threadId: "t-main",
          role: "assistant",
          createdAt: "2026-11-20T10:05:00.000Z",
        });
        yield* seedMessage({
          id: "m-sys",
          threadId: "t-main",
          role: "system",
          createdAt: "2026-11-20T10:06:00.000Z",
        });
        yield* seedMessage({
          id: "m-sub",
          threadId: "t-sub",
          role: "assistant",
          createdAt: "2026-11-20T10:07:00.000Z",
        });
        yield* seedMessage({
          id: "m-del",
          threadId: "t-deleted",
          role: "user",
          createdAt: "2026-11-20T10:08:00.000Z",
        });
        yield* seedMessage({
          id: "m-other",
          threadId: "t-other",
          role: "user",
          createdAt: "2026-11-21T09:00:00.000Z",
        });

        // Main turn with cachedInputTokens + otherUsage (Claude native subagents)
        yield* seedTurn({
          id: "pt-1",
          threadId: "t-main",
          ordinal: 1,
          provider: "claudeAgent",
          runModel: "claude-opus-5-5",
          completedAt: "2026-11-20T10:05:00.000Z",
          turnTokenUsage: {
            usageScope: "main_agent",
            usageStatus: "complete",
            hasSubagents: true,
            inputTokens: 1000,
            cachedInputTokens: 800,
            cacheCreationTokens: 100,
            outputTokens: 200,
            reasoningTokens: 50,
            otherUsage: { inputTokens: 5000, outputTokens: 300 },
          },
        });

        // Turn without cachedInputTokens: must NOT enter cacheEligibleInputTokens
        yield* seedTurn({
          id: "pt-2",
          threadId: "t-other",
          ordinal: 1,
          provider: "codex",
          runModel: "gpt-6-astra",
          completedAt: "2026-11-21T09:01:00.000Z",
          turnTokenUsage: {
            usageScope: "main_agent",
            usageStatus: "complete",
            hasSubagents: false,
            inputTokens: 400,
            outputTokens: 100,
          },
        });

        // T3 child subagent turn contributes tokens and attributes session to parent t-main, not session count
        yield* seedTurn({
          id: "pt-sub",
          threadId: "t-sub",
          ordinal: 1,
          provider: "codex",
          runModel: "gpt-6-astra",
          completedAt: "2026-11-20T10:07:00.000Z",
          turnTokenUsage: {
            usageScope: "main_agent",
            usageStatus: "complete",
            hasSubagents: false,
            inputTokens: 2000,
            cachedInputTokens: 1000,
            outputTokens: 100,
          },
        });

        // Deleted thread turn must be completely excluded
        yield* seedTurn({
          id: "pt-del",
          threadId: "t-deleted",
          ordinal: 1,
          provider: "codex",
          runModel: "gpt-6-astra",
          completedAt: "2026-11-20T10:09:00.000Z",
          turnTokenUsage: {
            usageScope: "main_agent",
            usageStatus: "complete",
            hasSubagents: false,
            inputTokens: 999999,
            outputTokens: 999,
          },
        });

        const service = yield* WorkspaceUsageService.WorkspaceUsageService;
        const allStats = yield* service.readStats({ timeZone: "UTC" });

        assert.equal(allStats.sessions, 2);
        assert.equal(allStats.messages, 3);
        assert.equal(allStats.activeDays, 2);
        assert.equal(allStats.inputTokens, 3400);
        assert.equal(allStats.cachedInputTokens, 1800);
        assert.equal(allStats.cacheCreationTokens, 100);
        // Only pt-1 (1000) and pt-sub (2000) reported cachedInputTokens; pt-2 (400) did not; otherUsage excluded.
        assert.equal(allStats.cacheEligibleInputTokens, 3000);
        assert.equal(allStats.outputTokens, 400);
        assert.equal(allStats.reasoningTokens, 50);
        assert.equal(allStats.otherInputTokens, 5000);
        assert.equal(allStats.otherOutputTokens, 300);
        assert.equal(allStats.totalTokens, 3400 + 400 + 5000 + 300);

        assert.equal(allStats.models[0]?.model, "claude-opus-5-5");
        assert.equal(allStats.models[0]?.totalTokens, 6500);
        assert.equal(allStats.models[0]?.sessions, 1);
        assert.equal(allStats.models[1]?.model, "gpt-6-astra");
        assert.equal(allStats.models[1]?.totalTokens, 2600);
        assert.equal(allStats.models[1]?.sessions, 2);

        const p1Only = yield* service.readStats({ timeZone: "UTC", projectIds: [p1] });
        assert.equal(p1Only.sessions, 1);
        assert.equal(p1Only.messages, 2);
        assert.equal(p1Only.totalTokens, 6500 + 2100);

        const emptyProjects = yield* service.readStats({ timeZone: "UTC", projectIds: [] });
        assert.equal(emptyProjects.sessions, 0);
        assert.equal(emptyProjects.messages, 0);
        assert.equal(emptyProjects.totalTokens, 0);
        assert.deepEqual(emptyProjects.models, []);
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect("buckets timestamps in the requested timezone and resolves model fallbacks", () =>
    Effect.gen(function* () {
      const p1 = ProjectId.make("project-tz");
      yield* seedThread({
        id: "t-tz",
        projectId: p1,
        defaultProvider: "antigravity",
        modelSelectionModel: "gemini-pro-fallback",
      });
      // 2026-11-20T16:00:00Z is 2026-11-21 01:00:00 in Asia/Tokyo (+09:00)
      yield* seedMessage({
        id: "m-tz",
        threadId: "t-tz",
        role: "user",
        createdAt: "2026-11-20T16:00:00.000Z",
      });
      yield* seedTurn({
        id: "pt-tz-1",
        threadId: "t-tz",
        ordinal: 1,
        provider: "antigravity",
        completedAt: "2026-11-20T16:00:00.000Z",
        turnTokenUsage: {
          usageScope: "main_agent",
          usageStatus: "complete",
          hasSubagents: false,
          models: ["gemini-3-pro-from-usage"],
          inputTokens: 500,
          outputTokens: 100,
        },
      });
      yield* seedTurn({
        id: "pt-tz-2",
        threadId: "t-tz",
        ordinal: 2,
        provider: "antigravity",
        completedAt: "2026-11-20T16:10:00.000Z",
        turnTokenUsage: {
          usageScope: "main_agent",
          usageStatus: "complete",
          hasSubagents: false,
          inputTokens: 200,
          outputTokens: 50,
        },
      });

      const service = yield* WorkspaceUsageService.WorkspaceUsageService;
      const tokyoDay = yield* service.readStats({
        timeZone: "Asia/Tokyo",
        sinceDay: UsageDay.make("2026-11-21"),
        untilDay: UsageDay.make("2026-11-21"),
      });
      assert.equal(tokyoDay.sessions, 1);
      assert.equal(tokyoDay.messages, 1);
      assert.equal(tokyoDay.totalTokens, 850);
      assert.equal(tokyoDay.daily[0]?.day, "2026-11-21");
      assert.deepEqual(
        tokyoDay.models.map((entry) => entry.model),
        ["gemini-3-pro-from-usage", "gemini-pro-fallback"],
      );

      const utcPreviousDay = yield* service.readStats({
        timeZone: "Asia/Tokyo",
        sinceDay: UsageDay.make("2026-11-20"),
        untilDay: UsageDay.make("2026-11-20"),
      });
      assert.equal(utcPreviousDay.sessions, 0);
      assert.equal(utcPreviousDay.totalTokens, 0);

      const invalid = yield* Effect.flip(
        service.readStats({
          timeZone: "UTC",
          sinceDay: UsageDay.make("2026-11-22"),
          untilDay: UsageDay.make("2026-11-21"),
        }),
      );
      assert.instanceOf(invalid, WorkspaceUsageReadError);
      assert.equal(invalid.reason, "invalidWindow");
    }).pipe(Effect.provide(testLayer)),
  );
});
