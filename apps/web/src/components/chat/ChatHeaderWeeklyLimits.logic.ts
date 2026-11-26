import {
  displayLimitWindows,
  type LimitPool,
  type LimitPoolWindow,
} from "@t3tools/shared/usageLimits";

export interface WeeklyLimitSummary {
  readonly driver: LimitPool["driver"];
  readonly windows: readonly LimitPoolWindow[];
  /** The tightest weekly window, since that is the one that blocks the provider first. */
  readonly remainingPercent: number;
}

export function weeklyLimitSummaries(pools: readonly LimitPool[]): readonly WeeklyLimitSummary[] {
  return pools.flatMap((pool) => {
    const windows = displayLimitWindows(pool).filter((window) => window.kind === "weekly");
    if (windows.length === 0) return [];
    const remainingPercent = Math.min(...windows.map((window) => window.remainingPercent));
    return [{ driver: pool.driver, windows, remainingPercent }];
  });
}
