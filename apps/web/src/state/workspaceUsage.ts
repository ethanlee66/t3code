import { useAtomValue } from "@effect/atom-react";
import {
  AuthOrchestrationReadScope,
  type EnvironmentId,
  type ProjectId,
  type ScopedProjectRef,
  type UsageDay,
  type WorkspaceUsageStats,
  type WorkspaceUsageStatsInput,
} from "@t3tools/contracts";
import { makeWindow } from "@t3tools/shared/usageFormat";
import { AsyncResult, Atom } from "effect/reactivity";
import { useState } from "react";

import {
  mergeWorkspaceUsageStats,
  type MergedWorkspaceUsageStats,
} from "../components/chat/DraftHeroOverviewCard.logic";
import { useNowMinute } from "../hooks/useNowMinute";
import { environmentPresentations } from "./presentation";
import { serverEnvironment } from "./server";
import { environmentSession, sessionHasScope } from "./session";

export type WorkspaceUsageRange = "all" | "30d" | "7d";

interface EnvironmentWorkspaceUsageStatus {
  readonly environmentId: EnvironmentId;
  readonly isPending: boolean;
  readonly hasError: boolean;
  readonly stats: WorkspaceUsageStats | null;
}

interface WorkspaceUsageQuerySpec {
  readonly timeZone: string;
  readonly sinceDay?: UsageDay;
  readonly untilDay?: UsageDay;
  readonly projectIdsByEnv: ReadonlyArray<
    readonly [EnvironmentId, ReadonlyArray<ProjectId>]
  > | null;
}

const EMPTY_STATUSES_ATOM = Atom.make<readonly EnvironmentWorkspaceUsageStatus[]>([]);

const workspaceUsageByQueryAtom = Atom.family((queryKey: string) =>
  Atom.make((get): readonly EnvironmentWorkspaceUsageStatus[] => {
    const spec = JSON.parse(queryKey) as WorkspaceUsageQuerySpec;
    const projectMap = spec.projectIdsByEnv === null ? null : new Map(spec.projectIdsByEnv);
    const presentations = get(environmentPresentations.presentationsAtom);

    const statuses: EnvironmentWorkspaceUsageStatus[] = [];
    for (const [environmentId, presentation] of presentations) {
      if (presentation.connection.phase !== "connected") continue;
      const sessionResult = get(environmentSession.sessionStateAtom(environmentId));
      if (!sessionHasScope(sessionResult, AuthOrchestrationReadScope)) continue;

      const projectIds = projectMap?.get(environmentId);
      if (projectMap !== null && (projectIds === undefined || projectIds.length === 0)) continue;

      const input: WorkspaceUsageStatsInput = {
        timeZone: spec.timeZone,
        ...(spec.sinceDay === undefined ? {} : { sinceDay: spec.sinceDay }),
        ...(spec.untilDay === undefined ? {} : { untilDay: spec.untilDay }),
        ...(projectIds === undefined ? {} : { projectIds }),
      };
      const result = get(serverEnvironment.workspaceUsageStats({ environmentId, input }));
      statuses.push({
        environmentId,
        isPending: result.waiting,
        hasError: result._tag === "Failure",
        stats: AsyncResult.getOrElse(result, () => null),
      });
    }
    return statuses;
  }).pipe(Atom.withLabel(`web-workspace-usage:${queryKey}`)),
);

function buildProjectIdsByEnv(
  selectedProjectRefs: readonly ScopedProjectRef[] | null,
): ReadonlyArray<readonly [EnvironmentId, ReadonlyArray<ProjectId>]> | null {
  if (selectedProjectRefs === null) return null;
  const grouped = new Map<EnvironmentId, Set<ProjectId>>();
  for (const ref of selectedProjectRefs) {
    let set = grouped.get(ref.environmentId);
    if (set === undefined) {
      set = new Set();
      grouped.set(ref.environmentId, set);
    }
    set.add(ref.projectId);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([environmentId, projectIds]) => [
      environmentId,
      [...projectIds].toSorted((left, right) => left.localeCompare(right)),
    ]);
}

function buildQuerySpec(
  range: WorkspaceUsageRange,
  selectedProjectRefs: readonly ScopedProjectRef[] | null,
  nowMs: number,
): { readonly todayDay: UsageDay; readonly queryKey: string } {
  const window = makeWindow(range === "7d" ? 7 : 30, new Date(nowMs), "day");
  const spec: WorkspaceUsageQuerySpec = {
    timeZone: window.timeZone,
    ...(range === "all" ? {} : { sinceDay: window.sinceDay, untilDay: window.untilDay }),
    projectIdsByEnv: buildProjectIdsByEnv(selectedProjectRefs),
  };
  return {
    todayDay: window.untilDay,
    queryKey: JSON.stringify(spec),
  };
}

export interface WorkspaceUsageView {
  readonly todayDay: UsageDay;
  readonly merged: MergedWorkspaceUsageStats;
  readonly isPending: boolean;
  readonly isRefreshing: boolean;
  readonly hasError: boolean;
}

export function useWorkspaceUsageStats({
  range,
  selectedProjectRefs,
  enabled = true,
}: {
  readonly range: WorkspaceUsageRange;
  readonly selectedProjectRefs: readonly ScopedProjectRef[] | null;
  readonly enabled?: boolean;
}): WorkspaceUsageView {
  // Re-evaluate local calendar day boundaries across midnight while staying stable within a minute.
  const nowMinute = useNowMinute();
  const nowMs = Date.parse(`${nowMinute}:00Z`);
  const { todayDay, queryKey } = buildQuerySpec(range, selectedProjectRefs, nowMs);
  const statuses = useAtomValue(
    enabled ? workspaceUsageByQueryAtom(queryKey) : EMPTY_STATUSES_ATOM,
  );

  const answered = statuses.flatMap((entry) => (entry.stats === null ? [] : [entry.stats]));
  const mergedCurrent = mergeWorkspaceUsageStats(answered);

  const [derived, setDerived] = useState<{
    readonly statuses: typeof statuses;
    readonly merged: MergedWorkspaceUsageStats;
  }>(() => ({ statuses, merged: mergedCurrent }));
  let currentMerged = derived.merged;
  if (derived.statuses !== statuses) {
    currentMerged = mergedCurrent;
    setDerived({ statuses, merged: mergedCurrent });
  }

  const answeredCount = answered.length;
  const stillReporting = statuses.filter((entry) => entry.stats === null && !entry.hasError).length;
  const isWaiting = statuses.some((entry) => entry.isPending);
  const hasError =
    answeredCount === 0 && stillReporting === 0 && statuses.some((entry) => entry.hasError);

  const [lastAnswered, setLastAnswered] = useState<{
    readonly queryKey: string;
    readonly merged: MergedWorkspaceUsageStats;
  } | null>(null);
  if (
    answeredCount > 0 &&
    (lastAnswered?.merged !== currentMerged || lastAnswered.queryKey !== queryKey)
  ) {
    setLastAnswered({ queryKey, merged: currentMerged });
  }

  const isPending = answeredCount === 0 && stillReporting > 0 && lastAnswered === null;
  const isRefreshing =
    isWaiting || (answeredCount === 0 && stillReporting > 0 && lastAnswered !== null);
  const merged =
    answeredCount > 0
      ? currentMerged
      : lastAnswered !== null && stillReporting > 0
        ? lastAnswered.merged
        : currentMerged;

  return {
    todayDay,
    merged,
    isPending,
    isRefreshing,
    hasError,
  };
}
