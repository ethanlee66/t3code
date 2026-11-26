import {
  ProviderDriverKind,
  ProviderInstanceId,
  UsageDay,
  type ServerProvider,
  type WorkspaceUsageStats,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildActivityHeatmapGrid,
  mergeWorkspaceUsageStats,
  resolveOverviewModelLabel,
} from "./DraftHeroOverviewCard.logic";

describe("mergeWorkspaceUsageStats", () => {
  it("merges totals, models, daily buckets, and cache hit rate across environments", () => {
    const envA: WorkspaceUsageStats = {
      readAt: "2026-11-26T12:00:00Z",
      timeZone: "UTC",
      sessions: 5,
      messages: 40,
      activeDays: 2,
      inputTokens: 1000,
      cachedInputTokens: 900,
      cacheCreationTokens: 50,
      cacheEligibleInputTokens: 1000,
      outputTokens: 200,
      reasoningTokens: 30,
      otherInputTokens: 500,
      otherOutputTokens: 100,
      totalTokens: 1800,
      models: [
        {
          driver: "claudeAgent",
          model: "claude-opus-5-5",
          inputTokens: 1000,
          cachedInputTokens: 900,
          cacheCreationTokens: 50,
          cacheEligibleInputTokens: 1000,
          outputTokens: 200,
          reasoningTokens: 30,
          otherInputTokens: 500,
          otherOutputTokens: 100,
          totalTokens: 1800,
          turns: 8,
          sessions: 5,
        },
      ],
      daily: [
        { day: UsageDay.make("2026-11-24"), messages: 10, turns: 3, totalTokens: 600 },
        { day: UsageDay.make("2026-11-26"), messages: 30, turns: 5, totalTokens: 1200 },
      ],
    };
    const envB: WorkspaceUsageStats = {
      readAt: "2026-11-26T12:00:00Z",
      timeZone: "UTC",
      sessions: 3,
      messages: 20,
      activeDays: 2,
      inputTokens: 2000,
      cachedInputTokens: 1000,
      cacheCreationTokens: 0,
      cacheEligibleInputTokens: 1000,
      outputTokens: 100,
      reasoningTokens: 0,
      otherInputTokens: 0,
      otherOutputTokens: 0,
      totalTokens: 2100,
      models: [
        {
          driver: "claudeAgent",
          model: "claude-opus-5-5",
          inputTokens: 1000,
          cachedInputTokens: 1000,
          cacheCreationTokens: 0,
          cacheEligibleInputTokens: 1000,
          outputTokens: 50,
          reasoningTokens: 0,
          otherInputTokens: 0,
          otherOutputTokens: 0,
          totalTokens: 1050,
          turns: 4,
          sessions: 2,
        },
        {
          driver: "codex",
          model: "gpt-6-astra",
          inputTokens: 1000,
          cachedInputTokens: 0,
          cacheCreationTokens: 0,
          cacheEligibleInputTokens: 0,
          outputTokens: 50,
          reasoningTokens: 0,
          otherInputTokens: 0,
          otherOutputTokens: 0,
          totalTokens: 1050,
          turns: 3,
          sessions: 1,
        },
      ],
      daily: [
        { day: UsageDay.make("2026-11-25"), messages: 5, turns: 2, totalTokens: 900 },
        { day: UsageDay.make("2026-11-26"), messages: 15, turns: 5, totalTokens: 1200 },
      ],
    };

    const merged = mergeWorkspaceUsageStats([envA, envB]);
    expect(merged.sessions).toBe(8);
    expect(merged.messages).toBe(60);
    expect(merged.activeDays).toBe(3);
    expect(merged.totalTokens).toBe(3900);
    expect(merged.cacheHitRate).toBeCloseTo(1900 / 2000, 5);
    expect(merged.models.map((entry) => [entry.model, entry.totalTokens, entry.sessions])).toEqual([
      ["claude-opus-5-5", 2850, 7],
      ["gpt-6-astra", 1050, 1],
    ]);
    expect(merged.daily.map((entry) => [entry.day, entry.totalTokens, entry.messages])).toEqual([
      ["2026-11-24", 600, 10],
      ["2026-11-25", 900, 5],
      ["2026-11-26", 2400, 45],
    ]);
  });

  it("returns null cacheHitRate when cacheEligibleInputTokens is 0", () => {
    const merged = mergeWorkspaceUsageStats([]);
    expect(merged.cacheHitRate).toBeNull();
    expect(merged.activeDays).toBe(0);
  });
});

describe("buildActivityHeatmapGrid", () => {
  it("builds a column-major 26x7 grid ending on the week containing todayDay", () => {
    // 2026-11-26 is Thursday (UTC day index 4), so Friday & Saturday in final week are future cells.
    const today = UsageDay.make("2026-11-26");
    const grid = buildActivityHeatmapGrid(
      [
        { day: UsageDay.make("2026-11-24"), messages: 5, turns: 1, totalTokens: 100 },
        { day: UsageDay.make("2026-11-25"), messages: 12, turns: 4, totalTokens: 400 },
        { day: UsageDay.make("2026-11-26"), messages: 1, turns: 0, totalTokens: 0 },
      ],
      today,
      26,
    );

    expect(grid).toHaveLength(26 * 7);
    expect(grid.slice(-2).every((cell) => cell.isFuture)).toBe(true);
    const todayCell = grid[grid.length - 3]!;
    expect(todayCell.day).toBe("2026-11-26");
    expect(todayCell.isFuture).toBe(false);
    expect(todayCell.level).toBe(1);

    const peakCell = grid.find((cell) => cell.day === "2026-11-25")!;
    expect(peakCell.level).toBe(4);

    const quarterCell = grid.find((cell) => cell.day === "2026-11-24")!;
    expect(quarterCell.level).toBe(2);
  });
});

describe("resolveOverviewModelLabel", () => {
  it("resolves display model names from matching driver catalogs and falls back to raw slug", () => {
    const providers = [
      {
        instanceId: ProviderInstanceId.make("antigravity"),
        driver: ProviderDriverKind.make("antigravity"),
        models: [
          {
            slug: "gemini-4-neon",
            name: "Gemini 4 Neon",
            shortName: "Gemini 4 Neon",
          },
        ],
      },
    ] as unknown as ServerProvider[];

    expect(resolveOverviewModelLabel("antigravity", "gemini-4-neon", providers)).toBe(
      "Gemini 4 Neon",
    );
    expect(resolveOverviewModelLabel("codex", "unknown-slug", providers)).toBe("unknown-slug");
  });
});
