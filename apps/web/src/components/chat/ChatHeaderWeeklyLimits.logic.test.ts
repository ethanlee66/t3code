import { ProviderDriverKind, type ServerProviderUsageWindow } from "@t3tools/contracts";
import { collectLimitPools, type LimitAccount } from "@t3tools/shared/usageLimits";
import { describe, expect, it } from "vite-plus/test";

import { weeklyLimitSummaries } from "./ChatHeaderWeeklyLimits.logic";

const now = Date.parse("2026-11-23T12:00:00.000Z");

const account = (
  driver: string,
  windows: ReadonlyArray<Pick<ServerProviderUsageWindow, "id" | "kind" | "usedPercent">>,
): LimitAccount => ({
  key: driver,
  driver: ProviderDriverKind.make(driver),
  displayName: null,
  email: undefined,
  plan: undefined,
  accentColor: undefined,
  environments: [],
  sourceLabel: null,
  redeem: null,
  limits: {
    checkedAt: "2026-11-23T11:00:00.000Z",
    windows: windows.map((window) => ({ ...window, label: window.id })),
  },
});

describe("weeklyLimitSummaries", () => {
  it("keeps weekly windows per provider, skipping Antigravity's shared quota, and reports the tightest one", () => {
    const pools = collectLimitPools(
      [
        account("claudeAgent", [
          { id: "five_hour", kind: "session", usedPercent: 95 },
          { id: "seven_day", kind: "weekly", usedPercent: 40 },
          { id: "seven_day_fable", kind: "weekly", usedPercent: 70 },
        ]),
        account("cursor", [{ id: "totalPercentUsed", kind: "monthly", usedPercent: 10 }]),
        account("antigravity", [
          { id: "gemini-weekly", kind: "weekly", usedPercent: 8 },
          { id: "3p-weekly", kind: "weekly", usedPercent: 100 },
        ]),
      ],
      now,
    );

    expect(
      weeklyLimitSummaries(pools).map((summary) => ({
        driver: summary.driver,
        windows: summary.windows.map((window) => window.id),
        remainingPercent: summary.remainingPercent,
      })),
    ).toEqual([
      { driver: "claudeAgent", windows: ["seven_day", "seven_day_fable"], remainingPercent: 30 },
      { driver: "antigravity", windows: ["gemini-weekly"], remainingPercent: 92 },
    ]);
  });
});
