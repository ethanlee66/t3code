import type { EnvironmentId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { collectLimitAccounts, collectLimitPools } from "@t3tools/shared/usageLimits";
import { formatResetsIn } from "@t3tools/shared/usageLimitsCopy";
import { useGT, useMessages } from "gt-react";
import { useState } from "react";

import { environmentPresentations } from "../../state/presentation";
import { providerClients } from "../settings/providerDriverMeta";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { type WeeklyLimitSummary, weeklyLimitSummaries } from "./ChatHeaderWeeklyLimits.logic";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";

/** Weekly quota left per provider signed in on the thread's environment. */
export function ChatHeaderWeeklyLimits({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const presentation = useAtomValue(environmentPresentations.presentationsWithProvidersAtom).get(
    environmentId,
  );
  const navigate = useNavigate();
  // Refreshed when a tooltip opens, so countdowns are current without a ticking timer.
  const [now, setNow] = useState(() => Date.now());
  if (presentation === undefined) return null;
  const summaries = weeklyLimitSummaries(
    collectLimitPools(collectLimitAccounts(new Map([[environmentId, presentation]])), now),
  );
  if (summaries.length === 0) return null;
  return (
    <div className="hidden shrink-0 items-center gap-0.5 md:flex">
      {summaries.map((summary) => (
        <WeeklyLimitChip
          key={summary.driver}
          summary={summary}
          now={now}
          onTooltipOpen={() => setNow(Date.now())}
          onOpen={() => void navigate({ to: "/usage" })}
        />
      ))}
    </div>
  );
}

function remainingTone(remainingPercent: number) {
  if (remainingPercent <= 10) return "text-destructive";
  if (remainingPercent <= 25) return "text-warning-foreground";
  return undefined;
}

function WeeklyLimitChip({
  summary,
  now,
  onTooltipOpen,
  onOpen,
}: {
  readonly summary: WeeklyLimitSummary;
  readonly now: number;
  readonly onTooltipOpen: () => void;
  readonly onOpen: () => void;
}) {
  const gt = useGT();
  const label = providerClients.get(summary.driver)?.label ?? String(summary.driver);
  const remaining = summary.remainingPercent;
  return (
    <Tooltip onOpenChange={(open) => open && onTooltipOpen()}>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={gt("{provider} weekly limit: {percent}% left", {
              provider: label,
              percent: remaining,
            })}
            onClick={onOpen}
            className="inline-flex h-6 cursor-pointer items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground tabular-nums transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          />
        }
      >
        <ProviderInstanceIcon
          driverKind={summary.driver}
          displayName={label}
          indicatorBackground="var(--background)"
          className="size-3.5"
          iconClassName="size-3.5"
        />
        <span className={remainingTone(remaining)}>{remaining}%</span>
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        <WeeklyLimitDetails label={label} summary={summary} now={now} />
      </TooltipPopup>
    </Tooltip>
  );
}

function WeeklyLimitDetails({
  label,
  summary,
  now,
}: {
  readonly label: string;
  readonly summary: WeeklyLimitSummary;
  readonly now: number;
}) {
  const gt = useGT();
  const m = useMessages();
  return (
    <div className="flex flex-col gap-1 text-xs">
      <span className="font-medium">{gt("{provider} weekly limits", { provider: label })}</span>
      {summary.windows.map((window) => {
        const nextReset = window.resets[0]?.member.window;
        const resetsIn = nextReset ? formatResetsIn(nextReset, now, m) : null;
        return (
          <div key={window.id} className="flex justify-between gap-4 tabular-nums">
            {summary.windows.length > 1 ? (
              <span className="text-muted-foreground">{window.label}</span>
            ) : null}
            <span>
              {gt("{percent}% left", { percent: window.remainingPercent })}
              {resetsIn ? ` · ${resetsIn}` : null}
            </span>
          </div>
        );
      })}
    </div>
  );
}
