import { useAtomValue } from "@effect/atom-react";
import { isProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import { pickableProjectGroups } from "@t3tools/client-runtime/state/project-grouping";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import { refreshUsageLimits } from "@t3tools/client-runtime/state/usage";
import { isTriagePrompt } from "@t3tools/shared/triagePrompt";
import {
  formatCount,
  formatDayShort,
  formatPercent,
  formatTokens,
} from "@t3tools/shared/usageFormat";
import {
  collectHttpQuotaSources,
  collectLimitAccounts,
  collectLimitPools,
  displayLimitWindows,
  remainingPercent,
} from "@t3tools/shared/usageLimits";
import {
  collectLimitNotices,
  cursorUsageWindowDetails,
  formatDuration,
  formatResetsIn,
} from "@t3tools/shared/usageLimitsCopy";
import { Link } from "@tanstack/react-router";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { msg, T, useGT, useLocale, useMessages } from "gt-react";
import { BarChart3Icon, ChevronDownIcon, ChevronUpIcon, CpuIcon, LayersIcon } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { type DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useNowMinute } from "~/hooks/useNowMinute";
import { useScratchProject } from "~/hooks/useScratchProject";
import { cn } from "~/lib/utils";
import { useProjects } from "~/state/entities";
import { useEnvironments } from "~/state/environments";
import { environmentPresentations } from "~/state/presentation";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { useWorkspaceUsageStats, type WorkspaceUsageRange } from "~/state/workspaceUsage";
import { useSortedProjectGroups } from "../CommandPaletteLookups";
import { ProjectFavicon } from "../ProjectFavicon";
import { providerClients } from "../settings/providerDriverMeta";
import { Button } from "../ui/button";
import { RefreshIcon } from "../ui/refresh-icon";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SharedTooltipTrigger } from "../ui/shared-tooltip";
import { Skeleton } from "../ui/skeleton";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { barColor, PaceIcon } from "../usage/UsageLimits";
import { PROVIDER_PRESENTATION } from "../usage/usageProviders";
import {
  buildActivityHeatmapGrid,
  resolveOverviewModelLabel,
  type MergedWorkspaceUsageStats,
} from "./DraftHeroOverviewCard.logic";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";

const STORAGE_KEY = "t3code:draft-hero-overview:v1";
const ALL_PROJECTS_VALUE = "__all__";
const HEATMAP_WEEKS = 26;

const OverviewTabSchema = Schema.Literals(["overview", "models", "quota"]);
type OverviewTab = typeof OverviewTabSchema.Type;

const OverviewRangeSchema = Schema.Literals(["all", "30d", "7d"]);

const OverviewPreferencesSchema = Schema.Struct({
  expanded: Schema.Boolean,
  tab: OverviewTabSchema,
  range: OverviewRangeSchema,
});
type OverviewPreferences = typeof OverviewPreferencesSchema.Type;

const DEFAULT_PREFERENCES: OverviewPreferences = {
  expanded: true,
  tab: "overview",
  range: "all",
};

const TAB_OPTIONS: ReadonlyArray<{ readonly value: OverviewTab; readonly label: string }> = [
  { value: "overview", label: msg("Overview") },
  { value: "models", label: msg("Models") },
  { value: "quota", label: msg("Model quota") },
];

const RANGE_OPTIONS: ReadonlyArray<{
  readonly value: WorkspaceUsageRange;
  readonly label: string;
}> = [
  { value: "all", label: msg("All", { $context: "all time range" }) },
  { value: "30d", label: msg("30 days") },
  { value: "7d", label: msg("7 days") },
];

function isOverviewTab(value: string | undefined): value is OverviewTab {
  return value === "overview" || value === "models" || value === "quota";
}

function isOverviewRange(value: string | undefined): value is WorkspaceUsageRange {
  return value === "all" || value === "30d" || value === "7d";
}

function driverBarColor(driver: string): string {
  const presentation = Object.values(PROVIDER_PRESENTATION).find(
    (entry) => entry.driverKind === driver,
  );
  return presentation?.color ?? "var(--primary)";
}

function heatmapCellClass(level: 0 | 1 | 2 | 3 | 4, isFuture: boolean): string {
  if (isFuture) return "invisible";
  switch (level) {
    case 0:
      return "bg-foreground/6";
    case 1:
      return "bg-primary/25";
    case 2:
      return "bg-primary/45";
    case 3:
      return "bg-primary/70";
    case 4:
      return "bg-primary";
  }
}

function StatTile({
  label,
  value,
  loading,
  refreshing,
  tooltip,
}: {
  readonly label: string;
  readonly value: string;
  readonly loading: boolean;
  readonly refreshing: boolean;
  readonly tooltip?: string;
}) {
  const content = (
    <div className="min-w-0 rounded-lg border border-border/50 bg-background/55 px-3 py-2">
      <div className="truncate text-2xs text-muted-foreground">{label}</div>
      {loading ? (
        <Skeleton className="mt-1 h-4 w-14" />
      ) : (
        <div
          className={cn(
            "mt-0.5 truncate text-sm font-semibold text-foreground tabular-nums transition-opacity",
            refreshing && "opacity-65",
          )}
        >
          {value}
        </div>
      )}
    </div>
  );
  if (!tooltip || loading) return content;
  return (
    <Tooltip>
      <TooltipTrigger render={content} />
      <TooltipPopup side="top">{tooltip}</TooltipPopup>
    </Tooltip>
  );
}

function OverviewTabContent({
  merged,
  todayDay,
  providers,
  isPending,
  isRefreshing,
  hasError,
}: {
  readonly merged: MergedWorkspaceUsageStats;
  readonly todayDay: Parameters<typeof buildActivityHeatmapGrid>[1];
  readonly providers: readonly ServerProvider[];
  readonly isPending: boolean;
  readonly isRefreshing: boolean;
  readonly hasError: boolean;
}) {
  const gt = useGT();
  const locale = useLocale();
  const topModel = merged.models[0];
  const topModelLabel = topModel
    ? resolveOverviewModelLabel(topModel.driver, topModel.model, providers)
    : "–";
  const topModelTooltip = topModel
    ? gt("{model} · {tokens} tokens", {
        model: topModel.model,
        tokens: formatTokens(topModel.totalTokens),
      })
    : undefined;
  const cacheRateLabel = merged.cacheHitRate === null ? "–" : formatPercent(merged.cacheHitRate);
  const tokensTooltip =
    merged.totalTokens > 0
      ? gt("Input {input} · Cached {cached} · Output {output}", {
          input: formatTokens(merged.inputTokens),
          cached: formatTokens(merged.cachedInputTokens),
          output: formatTokens(merged.outputTokens),
        })
      : undefined;
  const cells = buildActivityHeatmapGrid(merged.daily, todayDay, HEATMAP_WEEKS);

  return (
    <div className="flex flex-col gap-3">
      {hasError ? (
        <p className="text-xs text-muted-foreground">
          <T>Could not load workspace usage statistics.</T>
        </p>
      ) : null}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <StatTile
          label={gt("Sessions")}
          value={formatCount(merged.sessions, locale)}
          loading={isPending}
          refreshing={isRefreshing}
        />
        <StatTile
          label={gt("Messages")}
          value={formatCount(merged.messages, locale)}
          loading={isPending}
          refreshing={isRefreshing}
        />
        <StatTile
          label={gt("Total tokens")}
          value={formatTokens(merged.totalTokens)}
          loading={isPending}
          refreshing={isRefreshing}
          {...(tokensTooltip ? { tooltip: tokensTooltip } : {})}
        />
        <StatTile
          label={gt("Active days")}
          value={formatCount(merged.activeDays, locale)}
          loading={isPending}
          refreshing={isRefreshing}
        />
        <StatTile
          label={gt("Cache hit rate")}
          value={cacheRateLabel}
          loading={isPending}
          refreshing={isRefreshing}
        />
        <StatTile
          label={gt("Most used model")}
          value={topModelLabel}
          loading={isPending}
          refreshing={isRefreshing}
          {...(topModelTooltip ? { tooltip: topModelTooltip } : {})}
        />
      </div>

      {isPending ? (
        <Skeleton className="h-[7.25rem] w-full" />
      ) : (
        <div
          aria-label={gt("Recent 26-week activity heatmap")}
          className={cn(
            "grid grid-flow-col grid-cols-26 grid-rows-7 gap-0.5 transition-opacity sm:gap-0.75",
            isRefreshing && "opacity-70",
          )}
        >
          {cells.map((cell) =>
            cell.isFuture ? (
              <span key={cell.day} aria-hidden className="block aspect-square w-full invisible" />
            ) : (
              <SharedTooltipTrigger
                key={cell.day}
                render={
                  <span
                    aria-label={gt("{date}: {tokens} tokens, {messages} messages", {
                      date: formatDayShort(cell.day, locale),
                      tokens: formatTokens(cell.totalTokens),
                      messages: formatCount(cell.messages, locale),
                    })}
                    className={cn(
                      "block aspect-square w-full rounded-xs transition-colors",
                      heatmapCellClass(cell.level, false),
                    )}
                  />
                }
                label={gt("{date} · {tokens} tokens · {messages} messages", {
                  date: formatDayShort(cell.day, locale),
                  tokens: formatTokens(cell.totalTokens),
                  messages: formatCount(cell.messages, locale),
                })}
              />
            ),
          )}
        </div>
      )}
    </div>
  );
}

function ModelsTabContent({
  merged,
  providers,
  isPending,
  isRefreshing,
}: {
  readonly merged: MergedWorkspaceUsageStats;
  readonly providers: readonly ServerProvider[];
  readonly isPending: boolean;
  readonly isRefreshing: boolean;
}) {
  const gt = useGT();
  const locale = useLocale();

  if (isPending) {
    return (
      <div className="flex flex-col gap-2">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
      </div>
    );
  }

  if (merged.models.length === 0) {
    return (
      <div className="flex min-h-40 items-center justify-center text-xs text-muted-foreground">
        <T>No model activity in this window.</T>
      </div>
    );
  }

  const peakTokens = merged.models.reduce((max, model) => Math.max(max, model.totalTokens), 0);

  return (
    <div
      className={cn(
        "flex max-h-56 flex-col gap-2 overflow-y-auto pr-0.5 transition-opacity",
        isRefreshing && "opacity-65",
      )}
    >
      {merged.models.map((entry) => {
        const displayName = resolveOverviewModelLabel(entry.driver, entry.model, providers);
        const share = merged.totalTokens > 0 ? entry.totalTokens / merged.totalTokens : 0;
        const barWidth = peakTokens > 0 ? Math.max(4, (entry.totalTokens / peakTokens) * 100) : 0;
        const driverKind = isProviderDriverKind(entry.driver) ? entry.driver : null;
        const driverLabel = driverKind
          ? (providerClients.get(driverKind)?.label ?? entry.driver)
          : entry.driver;
        const cacheRate =
          entry.cacheEligibleInputTokens > 0
            ? formatPercent(Math.min(1, entry.cachedInputTokens / entry.cacheEligibleInputTokens))
            : null;
        return (
          <div
            key={`${entry.driver}:${entry.model}`}
            className="flex flex-col gap-1.5 rounded-lg border border-border/50 bg-background/55 px-3 py-2"
          >
            <div className="flex items-center justify-between gap-3 text-xs">
              <div className="flex min-w-0 items-center gap-2">
                {driverKind ? (
                  <ProviderInstanceIcon
                    driverKind={driverKind}
                    displayName={driverLabel}
                    iconClassName="size-3.5"
                  />
                ) : (
                  <CpuIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                )}
                <span className="truncate font-medium text-foreground">{displayName}</span>
                <span className="hidden shrink-0 text-muted-foreground tabular-nums sm:inline">
                  {gt("{count, plural, one {{formatted} session} other {{formatted} sessions}}", {
                    count: entry.sessions,
                    formatted: formatCount(entry.sessions, locale),
                  })}
                </span>
              </div>
              <div className="flex shrink-0 items-baseline gap-2 tabular-nums">
                <span className="font-semibold text-foreground">
                  {formatTokens(entry.totalTokens)}
                </span>
                <span className="w-11 text-end text-muted-foreground">
                  {merged.totalTokens > 0 ? formatPercent(share) : "–"}
                </span>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <div className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
                {entry.totalTokens > 0 ? (
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${barWidth}%`,
                      backgroundColor: driverBarColor(entry.driver),
                    }}
                  />
                ) : null}
              </div>
              <span className="shrink-0 text-2xs text-muted-foreground tabular-nums">
                {cacheRate
                  ? gt("Cache {rate}", { rate: cacheRate })
                  : gt("{count, plural, one {{formatted} turn} other {{formatted} turns}}", {
                      count: entry.turns,
                      formatted: formatCount(entry.turns, locale),
                    })}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function QuotaTabContent({ now }: { readonly now: number }) {
  const gt = useGT();
  const m = useMessages();
  const presentations = useAtomValue(environmentPresentations.presentationsWithProvidersAtom);
  const pools = collectLimitPools(collectLimitAccounts(presentations), now);
  const quotaSources = collectHttpQuotaSources(presentations);
  const notices = collectLimitNotices(presentations, m);

  if (pools.length === 0 && quotaSources.length === 0 && notices.length === 0) {
    return (
      <div className="flex min-h-40 flex-col items-center justify-center gap-2 text-center text-xs text-muted-foreground">
        <p>
          <T>No provider reports subscription quota yet.</T>
        </p>
        <Button size="xs" variant="outline" render={<Link to="/usage" />}>
          <T>Open usage</T>
        </Button>
      </div>
    );
  }

  return (
    <div className="flex max-h-56 flex-col gap-2.5 overflow-y-auto pr-0.5">
      {pools.map((pool) => {
        const color = barColor(pool.driver);
        const label = providerClients.get(pool.driver)?.label ?? String(pool.driver);
        const windows = displayLimitWindows(pool);
        return (
          <div
            key={pool.driver}
            className="flex flex-col gap-1.5 rounded-lg border border-border/50 bg-background/55 px-3 py-2"
          >
            <div className="flex items-center gap-2 text-xs font-medium text-foreground">
              <ProviderInstanceIcon
                driverKind={pool.driver}
                displayName={label}
                iconClassName="size-3.5"
              />
              <span>{label}</span>
            </div>
            <div className="grid grid-cols-[minmax(0,7rem)_minmax(4rem,1fr)_auto] items-center gap-x-2.5 gap-y-1 text-xs">
              {windows.map((window) => {
                const details =
                  pool.driver === "cursor"
                    ? cursorUsageWindowDetails(window.id, pool, m)
                    : undefined;
                const nextRefill = window.resets.find(
                  (reset) => reset.at > now && reset.restoresPercent > 0,
                );
                const singleWindow = window.members.length === 1 ? window.members[0]?.window : null;
                const resetsText = singleWindow
                  ? formatResetsIn(singleWindow, now, m)
                  : nextRefill
                    ? formatDuration(nextRefill.at - now, m)
                    : null;
                return (
                  <div key={`${window.kind}:${window.id}`} className="contents">
                    <span className="truncate text-muted-foreground">
                      {details?.label ?? window.label}
                    </span>
                    <div className="h-1.5 min-w-0 overflow-hidden rounded-full bg-muted">
                      {window.remainingPercent > 0 ? (
                        <div
                          className="h-full rounded-full"
                          style={{
                            width: `${window.remainingPercent}%`,
                            backgroundColor: color,
                          }}
                        />
                      ) : null}
                    </div>
                    <span className="flex items-center gap-1.5 whitespace-nowrap text-foreground tabular-nums">
                      <span>{gt("{remaining}%", { remaining: window.remainingPercent })}</span>
                      {window.pace ? <PaceIcon pace={window.pace} /> : null}
                      {resetsText ? (
                        <span className="text-2xs text-muted-foreground">{resetsText}</span>
                      ) : null}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}

      {quotaSources.map((source) => (
        <div
          key={source.key}
          className="flex flex-col gap-1.5 rounded-lg border border-border/50 bg-background/55 px-3 py-2"
        >
          <div className="text-xs font-medium text-foreground">{source.label}</div>
          {source.quotaAccounts?.map((account) => (
            <div key={account.id} className="flex flex-col gap-1">
              {account.windows.map((window) => {
                const remaining = remainingPercent(window);
                const resetsText = formatResetsIn(window, now, m);
                return (
                  <div
                    key={window.id}
                    className="flex items-center justify-between gap-3 text-xs text-muted-foreground"
                  >
                    <span className="truncate">
                      {account.label} · {window.label}
                    </span>
                    <span className="shrink-0 tabular-nums">
                      {gt("{remaining}% left", { remaining })}
                      {resetsText ? ` · ${resetsText}` : ""}
                    </span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      ))}

      {notices.map((notice) => (
        <p key={notice} className="text-xs text-warning-foreground">
          {notice}
        </p>
      ))}
    </div>
  );
}

export function DraftHeroOverviewCard({ draftId }: { readonly draftId: DraftId | null }) {
  const gt = useGT();
  const m = useMessages();
  const projects = useProjects();
  const { environments } = useEnvironments();
  const { scratchWorkspaceRootFor } = useScratchProject();
  const isTriageDraftPrompt = useComposerDraftStore((store) =>
    draftId ? isTriagePrompt(store.getComposerDraft(draftId)?.prompt ?? "") : false,
  );
  const [preferences, setPreferences] = useLocalStorage(
    STORAGE_KEY,
    DEFAULT_PREFERENCES,
    OverviewPreferencesSchema,
  );
  const [selectedProjectKey, setSelectedProjectKey] = useState(ALL_PROJECTS_VALUE);
  const [isRefreshingLimits, setIsRefreshingLimits] = useState(false);
  const refreshingLimitsRef = useRef(false);
  const nowMinute = useNowMinute();
  const now = Date.parse(`${nowMinute}:00Z`);

  const presentations = useAtomValue(environmentPresentations.presentationsWithProvidersAtom);
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });

  const environmentLabelById = new Map(
    environments.map((environment) => [environment.environmentId, environment.label] as const),
  );
  const projectGroups = useSortedProjectGroups(environmentLabelById);
  const selectableGroups = pickableProjectGroups(projectGroups).filter(
    (group) =>
      !group.isScratch &&
      !group.memberProjects.every((project) =>
        isScratchProject(project, scratchWorkspaceRootFor(project.environmentId)),
      ),
  );
  const selectedGroup =
    selectedProjectKey === ALL_PROJECTS_VALUE
      ? null
      : (selectableGroups.find((group) => group.projectKey === selectedProjectKey) ?? null);
  const effectiveProjectKey = selectedGroup ? selectedGroup.projectKey : ALL_PROJECTS_VALUE;

  const { todayDay, merged, isPending, isRefreshing, hasError } = useWorkspaceUsageStats({
    range: preferences.range,
    selectedProjectRefs: selectedGroup ? selectedGroup.memberProjectRefs : null,
    enabled:
      !isTriageDraftPrompt &&
      projects.length > 0 &&
      preferences.expanded &&
      preferences.tab !== "quota",
  });

  const connectedLimitsEnvironments = [...presentations]
    .filter(
      ([, presentation]) =>
        presentation.connection.phase === "connected" && presentation.serverConfig !== null,
    )
    .map(([environmentId]) => environmentId)
    .sort()
    .join(",");

  const refreshLimits = (automatic = false) =>
    settlePromise(() =>
      Promise.all(
        Array.from(presentations, ([environmentId, presentation]) => {
          if (presentation.connection.phase === "connected" && presentation.serverConfig !== null) {
            return refreshUsageLimits(
              environmentId,
              () => refreshProviders({ environmentId, input: {} }),
              automatic,
            );
          }
        }),
      ),
    ).then((result) => {
      if (!AsyncResult.isSuccess(result)) throw Cause.squash(result.cause);
    });

  const autoRefreshLimits = useEffectEvent(() => {
    void refreshLimits(true);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refreshes provider limits when the quota tab opens or connected environments change
  useEffect(() => {
    if (preferences.expanded && preferences.tab === "quota" && connectedLimitsEnvironments) {
      autoRefreshLimits();
    }
  }, [preferences.expanded, preferences.tab, connectedLimitsEnvironments]);

  if (isTriageDraftPrompt || projects.length === 0) {
    return null;
  }

  const allProviders = [...presentations.values()].flatMap(
    (presentation) => presentation.serverConfig?.providers ?? [],
  );

  if (!preferences.expanded) {
    return (
      <div className="pointer-events-auto flex justify-center [@media(max-height:34rem)]:hidden">
        <Button
          size="xs"
          variant="ghost-muted"
          onClick={() => setPreferences({ ...preferences, expanded: true })}
        >
          <BarChart3Icon aria-hidden />
          <T>Overview</T>
          <ChevronDownIcon aria-hidden />
        </Button>
      </div>
    );
  }

  const showingQuota = preferences.tab === "quota";

  const handleRefreshLimits = () => {
    if (refreshingLimitsRef.current) return;
    refreshingLimitsRef.current = true;
    setIsRefreshingLimits(true);
    void refreshLimits(false).finally(() => {
      refreshingLimitsRef.current = false;
      setIsRefreshingLimits(false);
    });
  };

  return (
    <section
      aria-label={gt("Workspace overview")}
      className="pointer-events-auto w-full rounded-xl border border-border/75 bg-card/85 p-3 shadow-xs backdrop-blur-xs [@media(max-height:34rem)]:hidden"
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <ToggleGroup
          aria-label={gt("Workspace overview tab")}
          variant="segmented"
          value={[preferences.tab]}
          onValueChange={(next) => {
            const value = next[0];
            if (isOverviewTab(value)) setPreferences({ ...preferences, tab: value });
          }}
        >
          {TAB_OPTIONS.map((option) => (
            <Toggle key={option.value} value={option.value}>
              {m(option.label)}
            </Toggle>
          ))}
        </ToggleGroup>

        <div className="ms-auto flex flex-wrap items-center gap-1">
          {showingQuota ? (
            <>
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label={gt("Refresh model quota")}
                aria-busy={isRefreshingLimits}
                disabled={isRefreshingLimits}
                onClick={handleRefreshLimits}
              >
                <RefreshIcon size="xs" refreshing={isRefreshingLimits} />
              </Button>
              <Button size="xs" variant="ghost-muted" render={<Link to="/usage" />}>
                <T>Details</T>
              </Button>
            </>
          ) : (
            <>
              <Select
                value={effectiveProjectKey}
                onValueChange={(value) => {
                  if (typeof value === "string") setSelectedProjectKey(value);
                }}
              >
                <SelectTrigger
                  aria-label={gt("Filter by project")}
                  size="compact"
                  variant="default"
                  className="w-auto min-w-24 max-w-36"
                >
                  <SelectValue>
                    {selectedGroup ? (
                      <span className="flex min-w-0 items-center gap-1.5">
                        <ProjectFavicon project={selectedGroup} className="size-3.5 shrink-0" />
                        <span className="truncate">{selectedGroup.displayName}</span>
                      </span>
                    ) : (
                      <span className="truncate">
                        <T>All projects</T>
                      </span>
                    )}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false} className="w-56">
                  <SelectItem value={ALL_PROJECTS_VALUE}>
                    <span className="flex min-w-0 items-center gap-2">
                      <LayersIcon className="size-3.5 shrink-0" aria-hidden />
                      <span className="truncate">
                        <T>All projects</T>
                      </span>
                    </span>
                  </SelectItem>
                  {selectableGroups.map((group) => (
                    <SelectItem key={group.projectKey} value={group.projectKey}>
                      <span className="flex min-w-0 items-center gap-2">
                        <ProjectFavicon project={group} className="size-3.5 shrink-0" />
                        <span className="truncate">{group.displayName}</span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>

              <ToggleGroup
                aria-label={gt("Time range")}
                variant="segmented"
                value={[preferences.range]}
                onValueChange={(next) => {
                  const value = next[0];
                  if (isOverviewRange(value)) setPreferences({ ...preferences, range: value });
                }}
              >
                {RANGE_OPTIONS.map((option) => (
                  <Toggle key={option.value} value={option.value}>
                    {m(option.label)}
                  </Toggle>
                ))}
              </ToggleGroup>
            </>
          )}

          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label={gt("Hide overview")}
            onClick={() => setPreferences({ ...preferences, expanded: false })}
          >
            <ChevronUpIcon aria-hidden />
          </Button>
        </div>
      </div>

      <div className="mt-3">
        {preferences.tab === "overview" ? (
          <OverviewTabContent
            merged={merged}
            todayDay={todayDay}
            providers={allProviders}
            isPending={isPending}
            isRefreshing={isRefreshing}
            hasError={hasError}
          />
        ) : preferences.tab === "models" ? (
          <ModelsTabContent
            merged={merged}
            providers={allProviders}
            isPending={isPending}
            isRefreshing={isRefreshing}
          />
        ) : (
          <QuotaTabContent now={now} />
        )}
      </div>
    </section>
  );
}
