import type {
  ServerProvider,
  UsageDay,
  WorkspaceUsageDailyTotals,
  WorkspaceUsageModelTotals,
  WorkspaceUsageStats,
} from "@t3tools/contracts";

import { getTriggerDisplayModelName } from "./providerIconUtils";

export interface MergedWorkspaceUsageStats {
  readonly sessions: number;
  readonly messages: number;
  readonly activeDays: number;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheCreationTokens: number;
  readonly cacheEligibleInputTokens: number;
  readonly cacheHitRate: number | null;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly otherInputTokens: number;
  readonly otherOutputTokens: number;
  readonly totalTokens: number;
  readonly models: readonly WorkspaceUsageModelTotals[];
  readonly daily: readonly WorkspaceUsageDailyTotals[];
}

export interface ActivityHeatmapCell {
  readonly day: UsageDay;
  readonly messages: number;
  readonly turns: number;
  readonly totalTokens: number;
  readonly level: 0 | 1 | 2 | 3 | 4;
  readonly isFuture: boolean;
}

const DAY_MS = 86_400_000;

export function mergeWorkspaceUsageStats(
  entries: readonly WorkspaceUsageStats[],
): MergedWorkspaceUsageStats {
  let sessions = 0;
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
      sessions: number;
    }
  >();

  const dailyMap = new Map<
    string,
    { day: UsageDay; messages: number; turns: number; totalTokens: number }
  >();

  for (const entry of entries) {
    sessions += entry.sessions;
    messages += entry.messages;
    inputTokens += entry.inputTokens;
    cachedInputTokens += entry.cachedInputTokens;
    cacheCreationTokens += entry.cacheCreationTokens;
    cacheEligibleInputTokens += entry.cacheEligibleInputTokens;
    outputTokens += entry.outputTokens;
    reasoningTokens += entry.reasoningTokens;
    otherInputTokens += entry.otherInputTokens;
    otherOutputTokens += entry.otherOutputTokens;
    totalTokens += entry.totalTokens;

    for (const model of entry.models) {
      const key = `${model.driver}\0${model.model}`;
      const existing = modelMap.get(key);
      if (existing === undefined) {
        modelMap.set(key, { ...model });
      } else {
        existing.inputTokens += model.inputTokens;
        existing.cachedInputTokens += model.cachedInputTokens;
        existing.cacheCreationTokens += model.cacheCreationTokens;
        existing.cacheEligibleInputTokens += model.cacheEligibleInputTokens;
        existing.outputTokens += model.outputTokens;
        existing.reasoningTokens += model.reasoningTokens;
        existing.otherInputTokens += model.otherInputTokens;
        existing.otherOutputTokens += model.otherOutputTokens;
        existing.totalTokens += model.totalTokens;
        existing.turns += model.turns;
        existing.sessions += model.sessions;
      }
    }

    for (const dayEntry of entry.daily) {
      const existing = dailyMap.get(dayEntry.day);
      if (existing === undefined) {
        dailyMap.set(dayEntry.day, { ...dayEntry });
      } else {
        existing.messages += dayEntry.messages;
        existing.turns += dayEntry.turns;
        existing.totalTokens += dayEntry.totalTokens;
      }
    }
  }

  const models = [...modelMap.values()].toSorted(
    (left, right) =>
      right.totalTokens - left.totalTokens ||
      right.turns - left.turns ||
      left.model.localeCompare(right.model),
  );
  const daily = [...dailyMap.values()].toSorted((left, right) => left.day.localeCompare(right.day));
  const activeDays = daily.filter(
    (dayEntry) => dayEntry.messages > 0 || dayEntry.turns > 0 || dayEntry.totalTokens > 0,
  ).length;
  const cacheHitRate =
    cacheEligibleInputTokens > 0 ? Math.min(1, cachedInputTokens / cacheEligibleInputTokens) : null;

  return {
    sessions,
    messages,
    activeDays,
    inputTokens,
    cachedInputTokens,
    cacheCreationTokens,
    cacheEligibleInputTokens,
    cacheHitRate,
    outputTokens,
    reasoningTokens,
    otherInputTokens,
    otherOutputTokens,
    totalTokens,
    models,
    daily,
  };
}

function parseDayUtcMs(day: string): number {
  const [year = 1970, month = 1, dayOfMonth = 1] = day
    .split("-")
    .map((part) => Number.parseInt(part, 10));
  return Date.UTC(year, month - 1, dayOfMonth);
}

function formatUtcDay(ms: number): UsageDay {
  return new Date(ms).toISOString().slice(0, 10) as UsageDay;
}

export function buildActivityHeatmapGrid(
  daily: readonly WorkspaceUsageDailyTotals[],
  todayDay: UsageDay,
  weeks = 26,
): readonly ActivityHeatmapCell[] {
  const todayMs = parseDayUtcMs(todayDay);
  const todayWeekday = new Date(todayMs).getUTCDay();
  const endOfWeekMs = todayMs + (6 - todayWeekday) * DAY_MS;
  const totalCells = weeks * 7;
  const startMs = endOfWeekMs - (totalCells - 1) * DAY_MS;

  const byDay = new Map(daily.map((entry) => [entry.day, entry] as const));
  const useTokenIntensity = daily.some((entry) => entry.totalTokens > 0);
  const metricOf = (entry: WorkspaceUsageDailyTotals | undefined) => {
    if (entry === undefined) return 0;
    if (useTokenIntensity) {
      return entry.totalTokens > 0
        ? entry.totalTokens
        : entry.messages > 0 || entry.turns > 0
          ? 1
          : 0;
    }
    return entry.messages > 0 ? entry.messages : entry.turns;
  };

  let maxMetric = 0;
  for (let index = 0; index < totalCells; index += 1) {
    const cellMs = startMs + index * DAY_MS;
    if (cellMs > todayMs) continue;
    const day = formatUtcDay(cellMs);
    maxMetric = Math.max(maxMetric, metricOf(byDay.get(day)));
  }

  const cells: ActivityHeatmapCell[] = [];
  for (let index = 0; index < totalCells; index += 1) {
    const cellMs = startMs + index * DAY_MS;
    const day = formatUtcDay(cellMs);
    const isFuture = cellMs > todayMs;
    const entry = isFuture ? undefined : byDay.get(day);
    const value = isFuture ? 0 : metricOf(entry);
    let level: 0 | 1 | 2 | 3 | 4 = 0;
    if (!isFuture && value > 0 && maxMetric > 0) {
      const ratio = value / maxMetric;
      level = ratio >= 0.75 ? 4 : ratio >= 0.5 ? 3 : ratio >= 0.25 ? 2 : 1;
    }
    cells.push({
      day,
      messages: entry?.messages ?? 0,
      turns: entry?.turns ?? 0,
      totalTokens: entry?.totalTokens ?? 0,
      level,
      isFuture,
    });
  }
  return cells;
}

export function resolveOverviewModelLabel(
  driver: string,
  model: string,
  providers: readonly ServerProvider[],
): string {
  const orderedProviders = [
    ...providers.filter((provider) => provider.driver === driver),
    ...providers.filter((provider) => provider.driver !== driver),
  ];
  for (const provider of orderedProviders) {
    const match = provider.models.find(
      (candidate) => candidate.slug === model || candidate.aliases?.includes(model),
    );
    if (match !== undefined) {
      return getTriggerDisplayModelName(match, provider.driver);
    }
  }
  return model;
}
