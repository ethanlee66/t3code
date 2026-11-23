import type { RunId, ScopedThreadRef } from "@t3tools/contracts";
import {
  createLiveTpsTracker,
  formatLiveTps,
  observeLiveTpsProjection,
  sampleLiveTps,
  type LiveTpsSnapshot,
} from "@t3tools/client-runtime/state/live-tps";
import { useGT, useLocale } from "gt-react";
import { ZapIcon } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentThreadDetails } from "~/state/threads";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const TPS_REFRESH_INTERVAL_MS = 250;

const INITIAL_LIVE_TPS_SNAPSHOT: LiveTpsSnapshot = {
  tps: null,
  isStreaming: false,
  totalTokens: 0,
  source: "estimated",
};

function ComposerTpsBadgeActive(props: {
  readonly threadRef: ScopedThreadRef;
  readonly activeRunId: RunId;
}) {
  const { activeRunId } = props;
  const { environmentId, threadId } = props.threadRef;
  const gt = useGT();
  const locale = useLocale();
  const [snapshot, setSnapshot] = useState<LiveTpsSnapshot>(INITIAL_LIVE_TPS_SNAPSHOT);
  const trackerRef = useRef<ReturnType<typeof createLiveTpsTracker> | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- imperatively subscribes to live projection deltas at a 250ms cadence without per-chunk React re-renders
  useEffect(() => {
    const atom = environmentThreadDetails.threadAtom({ environmentId, threadId });
    const nowMs = Date.now();
    const initial = observeLiveTpsProjection(
      createLiveTpsTracker(activeRunId, nowMs),
      appAtomRegistry.get(atom)?.projection ?? null,
      nowMs,
    );
    trackerRef.current = initial;

    const refresh = () => {
      if (document.hidden || trackerRef.current === null) return;
      const sampled = sampleLiveTps(trackerRef.current, Date.now());
      trackerRef.current = sampled.tracker;
      const next = sampled.snapshot;
      setSnapshot((previous) =>
        formatLiveTps(previous.tps) === formatLiveTps(next.tps) &&
        previous.isStreaming === next.isStreaming &&
        previous.totalTokens === next.totalTokens &&
        previous.source === next.source
          ? previous
          : next,
      );
    };

    const unsubscribe = appAtomRegistry.subscribe(atom, (thread) => {
      if (trackerRef.current === null) return;
      trackerRef.current = observeLiveTpsProjection(
        trackerRef.current,
        thread?.projection ?? null,
        Date.now(),
      );
    });

    const interval = window.setInterval(refresh, TPS_REFRESH_INTERVAL_MS);
    const handleVisibilityChange = () => {
      if (!document.hidden) refresh();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      unsubscribe();
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      trackerRef.current = null;
    };
  }, [activeRunId, environmentId, threadId]);

  const formattedTps = formatLiveTps(snapshot.tps);
  const ariaLabel =
    snapshot.tps !== null
      ? gt("Live speed: {tps} tokens per second", { tps: formattedTps })
      : gt("Measuring token speed");

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            data-composer-tps-badge="true"
            role="status"
            aria-live="off"
            aria-label={ariaLabel}
            className={cn(
              "pointer-events-auto absolute bottom-full end-3 z-20 mb-1.5",
              "inline-flex items-center gap-1 select-none font-mono text-xs leading-none tabular-nums whitespace-nowrap",
              "transition-[opacity,translate] duration-180 ease-out starting:translate-y-0.5 starting:opacity-0 motion-reduce:transition-none",
            )}
          />
        }
      >
        <ZapIcon
          aria-hidden
          className={cn(
            "size-3 shrink-0 transition-colors duration-200",
            snapshot.isStreaming ? "text-primary" : "text-muted-foreground/70",
          )}
        />
        <span
          className={cn(
            "font-medium transition-colors duration-200",
            snapshot.isStreaming ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {formattedTps}
        </span>
        <span className="text-muted-foreground/80">tok/s</span>
      </TooltipTrigger>
      <TooltipPopup side="top">
        <div className="flex flex-col gap-0.5 text-xs">
          <span className="font-medium text-foreground">
            {snapshot.tps !== null
              ? gt("Live output speed: {tps} tok/s", { tps: formattedTps })
              : gt("Waiting for first token")}
          </span>
          {snapshot.totalTokens > 0 ? (
            <span className="text-muted-foreground tabular-nums">
              {snapshot.source === "reported"
                ? gt("{tokens} output tokens (reported)", {
                    tokens: snapshot.totalTokens.toLocaleString(locale),
                  })
                : gt("~{tokens} output tokens (estimated)", {
                    tokens: snapshot.totalTokens.toLocaleString(locale),
                  })}
            </span>
          ) : null}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}

export const ComposerTpsBadge = memo(function ComposerTpsBadge(props: {
  readonly threadRef: ScopedThreadRef;
  readonly activeRunId: RunId | null;
}) {
  if (props.activeRunId === null) return null;
  const runKey = `${props.threadRef.environmentId}:${props.threadRef.threadId}:${props.activeRunId}`;
  return (
    <ComposerTpsBadgeActive
      key={runKey}
      threadRef={props.threadRef}
      activeRunId={props.activeRunId}
    />
  );
});
