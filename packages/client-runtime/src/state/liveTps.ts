import type {
  OrchestrationV2ProviderTurn,
  OrchestrationV2Run,
  OrchestrationV2RunAttempt,
  OrchestrationV2TurnItem,
  RunAttemptId,
  RunId,
} from "@t3tools/contracts";

/** Rolling lookback window used to compute smooth live output throughput. */
const LIVE_TPS_WINDOW_MS = 2_500;
/** Minimum elapsed time from a generation burst's first token before emitting a live rate. */
const LIVE_TPS_MIN_ELAPSED_MS = 250;
/** Threshold after the last token delta during which streaming is treated as active. */
const LIVE_TPS_ACTIVE_THRESHOLD_MS = 1_200;

export type LiveTpsSource = "estimated" | "reported";

export interface LiveTpsSample {
  readonly timestampMs: number;
  readonly tokens: number;
}

export interface LiveTpsItemCounter {
  readonly length: number;
  readonly tokens: number;
}

export interface LiveTpsSnapshot {
  readonly tps: number | null;
  readonly isStreaming: boolean;
  readonly totalTokens: number;
  readonly source: LiveTpsSource;
}

export interface LiveTpsTracker {
  readonly runId: RunId;
  readonly initialized: boolean;
  readonly startedAtMs: number;
  readonly firstDeltaAtMs: number | null;
  readonly burstStartAtMs: number | null;
  readonly lastDeltaAtMs: number | null;
  readonly anchorTokens: number;
  readonly itemCounters: ReadonlyMap<string, LiveTpsItemCounter>;
  readonly streamedTokens: number;
  readonly reportedOutputTokens: number;
  readonly totalTokens: number;
  readonly samples: ReadonlyArray<LiveTpsSample>;
  readonly smoothedTps: number | null;
}

export interface LiveTpsProjectionSlice {
  readonly runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "activeAttemptId">>;
  readonly attempts: ReadonlyArray<
    Pick<OrchestrationV2RunAttempt, "id" | "runId" | "providerTurnId">
  >;
  readonly providerTurns: ReadonlyArray<
    Pick<OrchestrationV2ProviderTurn, "id" | "runAttemptId" | "tokenUsage" | "turnTokenUsage">
  >;
  readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
}

/**
 * Estimate output tokens for mixed ASCII/CJK text in linear time without tokenizer overhead.
 * CJK/kana/hangul/fullwidth characters typically map to ~1 token each, Latin/ASCII ~0.25 tokens/char.
 */
export function estimateTextTokens(text: string): number {
  let tokens = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (
      (code >= 0x3000 && code <= 0x9fff) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xff00 && code <= 0xffef)
    ) {
      tokens += 1;
    } else if (code <= 0x7f) {
      tokens += 0.25;
    } else {
      tokens += 0.5;
    }
  }
  return tokens;
}

/**
 * Pick the newest actively executing run (`preparing`, `starting`, or `running`).
 * Paused (`waiting`), queued, or terminal runs return null so TPS never measures wait time.
 */
export function selectActiveProcessingRunId(
  runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "status">>,
): RunId | null {
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const run = runs[index];
    if (!run) continue;
    if (run.status === "preparing" || run.status === "starting" || run.status === "running") {
      return run.id;
    }
  }
  return null;
}

export function createLiveTpsTracker(runId: RunId, nowMs: number): LiveTpsTracker {
  return {
    runId,
    initialized: false,
    startedAtMs: nowMs,
    firstDeltaAtMs: null,
    burstStartAtMs: null,
    lastDeltaAtMs: null,
    anchorTokens: 0,
    itemCounters: new Map(),
    streamedTokens: 0,
    reportedOutputTokens: 0,
    totalTokens: 0,
    samples: [],
    smoothedTps: null,
  };
}

function turnItemTokenText(item: OrchestrationV2TurnItem): string | null {
  switch (item.type) {
    case "assistant_message":
    case "reasoning":
      return item.text;
    case "proposed_plan":
      return item.markdown;
    default:
      return null;
  }
}

function measureStreamedItemTokens(
  runId: RunId,
  turnItems: ReadonlyArray<OrchestrationV2TurnItem>,
  previousCounters: ReadonlyMap<string, LiveTpsItemCounter>,
): {
  readonly itemCounters: Map<string, LiveTpsItemCounter>;
  readonly streamedTokens: number;
  readonly countersChanged: boolean;
} {
  const nextCounters = new Map<string, LiveTpsItemCounter>();
  let streamedTokens = 0;
  let countersChanged = false;

  for (const item of turnItems) {
    if (item.runId !== runId) continue;
    const text = turnItemTokenText(item);
    if (text === null) continue;

    const previous = previousCounters.get(item.id);
    let counter: LiveTpsItemCounter;
    if (previous !== undefined && text.length === previous.length) {
      counter = previous;
    } else if (previous !== undefined && text.length > previous.length) {
      countersChanged = true;
      counter = {
        length: text.length,
        tokens: previous.tokens + estimateTextTokens(text.slice(previous.length)),
      };
    } else {
      countersChanged = true;
      counter = {
        length: text.length,
        tokens: estimateTextTokens(text),
      };
    }

    nextCounters.set(item.id, counter);
    streamedTokens += counter.tokens;
  }

  if (nextCounters.size !== previousCounters.size) {
    countersChanged = true;
  }

  return { itemCounters: nextCounters, streamedTokens, countersChanged };
}

function readReportedOutputTokens(runId: RunId, projection: LiveTpsProjectionSlice): number {
  const run = projection.runs.find((candidate) => candidate.id === runId);
  const attemptIds = new Set<RunAttemptId>();
  const providerTurnIds = new Set<string>();

  if (run?.activeAttemptId != null) {
    attemptIds.add(run.activeAttemptId);
  }
  for (const attempt of projection.attempts) {
    if (attempt.runId !== runId) continue;
    attemptIds.add(attempt.id);
    if (attempt.providerTurnId !== null) {
      providerTurnIds.add(attempt.providerTurnId);
    }
  }

  if (attemptIds.size === 0 && providerTurnIds.size === 0) {
    return 0;
  }

  let reported = 0;
  for (const turn of projection.providerTurns) {
    const matchesAttempt = turn.runAttemptId !== null && attemptIds.has(turn.runAttemptId);
    const matchesTurnId = providerTurnIds.has(turn.id);
    if (!matchesAttempt && !matchesTurnId) continue;
    const turnOutput = turn.turnTokenUsage?.outputTokens ?? 0;
    const liveOutput = turn.tokenUsage?.outputTokens ?? 0;
    reported += Math.max(turnOutput, liveOutput);
  }
  return reported;
}

function pruneSamples(
  samples: ReadonlyArray<LiveTpsSample>,
  nowMs: number,
): ReadonlyArray<LiveTpsSample> {
  const cutoff = nowMs - LIVE_TPS_WINDOW_MS;
  let dropCount = 0;
  while (dropCount < samples.length && samples[dropCount]!.timestampMs <= cutoff) {
    dropCount += 1;
  }
  return dropCount === 0 ? samples : samples.slice(dropCount);
}

/**
 * Fold a thread projection snapshot into the tracker without side effects.
 * The first projection seeds a baseline so switching into an already-running thread never spikes.
 */
export function observeLiveTpsProjection(
  tracker: LiveTpsTracker,
  projection: LiveTpsProjectionSlice | null,
  nowMs: number,
): LiveTpsTracker {
  if (projection === null) return tracker;

  const { itemCounters, streamedTokens, countersChanged } = measureStreamedItemTokens(
    tracker.runId,
    projection.turnItems,
    tracker.itemCounters,
  );
  const reportedOutputTokens = readReportedOutputTokens(tracker.runId, projection);
  const nextTotal = Math.max(tracker.totalTokens, streamedTokens, reportedOutputTokens);

  if (!tracker.initialized) {
    return {
      ...tracker,
      initialized: true,
      itemCounters,
      streamedTokens,
      reportedOutputTokens,
      totalTokens: nextTotal,
    };
  }

  const delta = nextTotal - tracker.totalTokens;
  if (delta <= 0) {
    if (
      !countersChanged &&
      streamedTokens === tracker.streamedTokens &&
      reportedOutputTokens === tracker.reportedOutputTokens
    ) {
      return tracker;
    }
    return {
      ...tracker,
      itemCounters,
      streamedTokens,
      reportedOutputTokens,
    };
  }

  const pruned = pruneSamples(tracker.samples, nowMs);
  const isResumedBurstAfterPause =
    pruned.length === 0 &&
    tracker.lastDeltaAtMs !== null &&
    nowMs - tracker.lastDeltaAtMs >= LIVE_TPS_WINDOW_MS;

  if (tracker.firstDeltaAtMs === null || isResumedBurstAfterPause) {
    // Anchor generation start on the first observed token of a burst; excluding it from the sample
    // window prevents 1-frame spikes before real inter-chunk intervals accumulate, and re-anchors
    // cleanly after a >2.5s tool pause so resumed streaming recovers immediately.
    return {
      ...tracker,
      firstDeltaAtMs: tracker.firstDeltaAtMs ?? nowMs,
      burstStartAtMs: nowMs,
      lastDeltaAtMs: nowMs,
      anchorTokens: delta,
      itemCounters,
      streamedTokens,
      reportedOutputTokens,
      totalTokens: nextTotal,
      samples: [],
    };
  }

  return {
    ...tracker,
    lastDeltaAtMs: nowMs,
    itemCounters,
    streamedTokens,
    reportedOutputTokens,
    totalTokens: nextTotal,
    samples: [...pruned, { timestampMs: nowMs, tokens: delta }],
  };
}

function buildSnapshot(
  tracker: LiveTpsTracker,
  tps: number | null,
  nowMs: number,
): LiveTpsSnapshot {
  const source: LiveTpsSource =
    tracker.reportedOutputTokens > 0 && tracker.reportedOutputTokens >= tracker.streamedTokens * 0.5
      ? "reported"
      : "estimated";
  const isStreaming =
    tracker.lastDeltaAtMs !== null && nowMs - tracker.lastDeltaAtMs <= LIVE_TPS_ACTIVE_THRESHOLD_MS;

  return {
    tps,
    isStreaming,
    totalTokens: Math.round(tracker.totalTokens),
    source,
  };
}

/**
 * Sample smoothed real-time TPS over the rolling window for display on a UI tick.
 */
export function sampleLiveTps(
  tracker: LiveTpsTracker,
  nowMs: number,
): { readonly tracker: LiveTpsTracker; readonly snapshot: LiveTpsSnapshot } {
  const activeSamples = pruneSamples(tracker.samples, nowMs);

  let rawTps: number | null;
  if (tracker.firstDeltaAtMs === null || tracker.burstStartAtMs === null) {
    rawTps = null;
  } else {
    const burstElapsedMs = Math.max(0, nowMs - tracker.burstStartAtMs);
    if (burstElapsedMs < LIVE_TPS_MIN_ELAPSED_MS) {
      rawTps = tracker.smoothedTps;
    } else if (activeSamples.length > 0) {
      const windowSec = Math.min(LIVE_TPS_WINDOW_MS, burstElapsedMs) / 1_000;
      let windowTokens = 0;
      for (const sample of activeSamples) {
        windowTokens += sample.tokens;
      }
      rawTps = windowTokens / windowSec;
    } else if (
      tracker.lastDeltaAtMs === tracker.burstStartAtMs &&
      tracker.anchorTokens >= 8 &&
      burstElapsedMs <= LIVE_TPS_WINDOW_MS
    ) {
      // Non-streaming step report or single large block: divide by elapsed time since tracking began.
      rawTps = tracker.anchorTokens / Math.max(0.5, (nowMs - tracker.startedAtMs) / 1_000);
    } else {
      rawTps = 0;
    }
  }

  let nextSmoothed: number | null;
  if (rawTps === null) {
    nextSmoothed = null;
  } else if (rawTps === 0) {
    nextSmoothed =
      tracker.smoothedTps !== null && tracker.smoothedTps >= 0.1 ? tracker.smoothedTps * 0.5 : 0;
  } else if (tracker.smoothedTps === null) {
    nextSmoothed = rawTps;
  } else {
    nextSmoothed = tracker.smoothedTps * 0.55 + rawTps * 0.45;
  }

  const nextTracker: LiveTpsTracker = {
    ...tracker,
    samples: activeSamples,
    smoothedTps: nextSmoothed,
  };

  return {
    tracker: nextTracker,
    snapshot: buildSnapshot(nextTracker, nextSmoothed, nowMs),
  };
}

export function formatLiveTps(tps: number | null): string {
  if (tps === null) return "--";
  const clamped = Math.max(0, tps);
  return clamped >= 100 ? String(Math.round(clamped)) : clamped.toFixed(1);
}
