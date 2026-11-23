import {
  MessageId,
  NodeId,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  TurnItemId,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  createLiveTpsTracker,
  estimateTextTokens,
  formatLiveTps,
  observeLiveTpsProjection,
  sampleLiveTps,
  selectActiveProcessingRunId,
  type LiveTpsProjectionSlice,
} from "./liveTps.ts";
import { v2Now, v2ThreadId } from "./orchestrationV2TestFixtures.ts";

const run1 = RunId.make("run-1");
const run2 = RunId.make("run-2");
const attempt1 = RunAttemptId.make("attempt-1");
const providerThread1 = ProviderThreadId.make("provider-thread-1");
const providerTurn1 = ProviderTurnId.make("provider-turn-1");

function makeRun(
  id: RunId,
  status: OrchestrationV2Run["status"],
  activeAttemptId: OrchestrationV2Run["activeAttemptId"] = null,
): Pick<OrchestrationV2Run, "id" | "status" | "activeAttemptId"> {
  return { id, status, activeAttemptId };
}

function makeAssistantItem(id: string, runId: RunId, text: string): OrchestrationV2TurnItem {
  return {
    id: TurnItemId.make(id),
    threadId: v2ThreadId,
    runId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "running",
    title: null,
    startedAt: v2Now,
    completedAt: null,
    updatedAt: v2Now,
    type: "assistant_message",
    messageId: MessageId.make(`msg-${id}`),
    text,
    streaming: true,
  };
}

function makeReasoningItem(id: string, runId: RunId, text: string): OrchestrationV2TurnItem {
  return {
    id: TurnItemId.make(id),
    threadId: v2ThreadId,
    runId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 2,
    status: "running",
    title: null,
    startedAt: v2Now,
    completedAt: null,
    updatedAt: v2Now,
    type: "reasoning",
    text,
    streaming: true,
  };
}

function makeAttempt(): Pick<OrchestrationV2RunAttempt, "id" | "runId" | "providerTurnId"> {
  return {
    id: attempt1,
    runId: run1,
    providerTurnId: providerTurn1,
  };
}

function makeProviderTurn(
  outputTokens: number,
  useTurnTokenUsage = false,
): Pick<OrchestrationV2ProviderTurn, "id" | "runAttemptId" | "tokenUsage" | "turnTokenUsage"> {
  return {
    id: providerTurn1,
    runAttemptId: attempt1,
    ...(useTurnTokenUsage
      ? {
          turnTokenUsage: {
            usageScope: "main_agent",
            hasSubagents: false,
            usageStatus: "complete",
            inputTokens: 100,
            outputTokens,
          },
        }
      : {
          tokenUsage: {
            usedTokens: 100 + outputTokens,
            outputTokens,
            updatedAt: DateTime.formatIso(v2Now),
          },
        }),
  };
}

function makeSlice(partial: Partial<LiveTpsProjectionSlice> = {}): LiveTpsProjectionSlice {
  return {
    runs: [makeRun(run1, "running", attempt1)],
    attempts: [],
    providerTurns: [],
    turnItems: [],
    ...partial,
  };
}

describe("estimateTextTokens", () => {
  it("estimates empty, ASCII, CJK, and mixed code accurately", () => {
    expect(estimateTextTokens("")).toBe(0);
    // 20 ASCII chars -> 5 tokens
    expect(estimateTextTokens("12345678901234567890")).toBe(5);
    // 4 CJK chars -> 4 tokens
    expect(estimateTextTokens("你好世界")).toBe(4);
    // Mixed 4 CJK (4) + 8 ASCII (2) -> 6 tokens
    expect(estimateTextTokens("你好世界abcd1234")).toBe(6);
    // Avoid unused import warnings while keeping shared contract references explicit
    expect(NodeId.make("n")).toBe("n");
    expect(ProviderInstanceId.make("codex")).toBe("codex");
    expect(providerThread1).toBe("provider-thread-1");
  });
});

describe("selectActiveProcessingRunId", () => {
  it("returns the newest active run and ignores waiting or terminal runs", () => {
    expect(selectActiveProcessingRunId([])).toBeNull();
    expect(selectActiveProcessingRunId([makeRun(run1, "completed")])).toBeNull();
    expect(selectActiveProcessingRunId([makeRun(run1, "waiting")])).toBeNull();
    expect(selectActiveProcessingRunId([makeRun(run1, "preparing")])).toBe(run1);
    expect(selectActiveProcessingRunId([makeRun(run1, "starting")])).toBe(run1);
    expect(
      selectActiveProcessingRunId([makeRun(run1, "completed"), makeRun(run2, "running")]),
    ).toBe(run2);
    expect(selectActiveProcessingRunId([makeRun(run1, "running"), makeRun(run2, "waiting")])).toBe(
      run1,
    );
  });
});

describe("live TPS tracker", () => {
  it("tracks steady streaming without startup spikes across warm-up and steady state", () => {
    let tracker = createLiveTpsTracker(run1, 0);
    // Initial empty observation at t = 0
    tracker = observeLiveTpsProjection(tracker, makeSlice(), 0);
    let sampled = sampleLiveTps(tracker, 0);
    expect(sampled.snapshot).toEqual({
      tps: null,
      isStreaming: false,
      totalTokens: 0,
      source: "estimated",
    });

    // Anchor chunk at t = 100ms (20 ASCII chars = 5 tokens)
    let text = "a".repeat(20);
    tracker = observeLiveTpsProjection(
      sampled.tracker,
      makeSlice({ turnItems: [makeAssistantItem("i1", run1, text)] }),
      100,
    );
    sampled = sampleLiveTps(tracker, 200);
    // Too early (< 250ms since anchor) to show unstable 1-chunk spike
    expect(sampled.snapshot.tps).toBeNull();

    // Stream 50 tok/s (20 ASCII chars = 5 tokens every 100ms) up to t = 3100ms
    tracker = sampled.tracker;
    for (let t = 200; t <= 3100; t += 100) {
      text += "a".repeat(20);
      tracker = observeLiveTpsProjection(
        tracker,
        makeSlice({ turnItems: [makeAssistantItem("i1", run1, text)] }),
        t,
      );
      if (t % 250 === 0 || t === 600 || t === 3100) {
        sampled = sampleLiveTps(tracker, t);
        tracker = sampled.tracker;
      }
    }

    const warmCheck = sampleLiveTps(tracker, 3100);
    expect(warmCheck.snapshot.isStreaming).toBe(true);
    expect(warmCheck.snapshot.source).toBe("estimated");
    expect(warmCheck.snapshot.tps).not.toBeNull();
    expect(warmCheck.snapshot.tps!).toBeGreaterThan(45);
    expect(warmCheck.snapshot.tps!).toBeLessThan(55);
  });

  it("seeds baseline when mounted mid-run so pre-existing text does not spike TPS", () => {
    let tracker = createLiveTpsTracker(run1, 1_000);
    const initialText = "x".repeat(2_000); // 500 pre-existing tokens
    tracker = observeLiveTpsProjection(
      tracker,
      makeSlice({ turnItems: [makeAssistantItem("i1", run1, initialText)] }),
      1_000,
    );
    const initialSample = sampleLiveTps(tracker, 1_250);
    expect(initialSample.snapshot).toEqual({
      tps: null,
      isStreaming: false,
      totalTokens: 500,
      source: "estimated",
    });

    // Subsequent chunks stream at 40 tok/s (16 chars = 4 tokens per 100ms)
    tracker = initialSample.tracker;
    let text = initialText;
    for (let t = 1_300; t <= 2_300; t += 100) {
      text += "x".repeat(16);
      tracker = observeLiveTpsProjection(
        tracker,
        makeSlice({ turnItems: [makeAssistantItem("i1", run1, text)] }),
        t,
      );
      if (t % 250 === 0) {
        const res = sampleLiveTps(tracker, t);
        tracker = res.tracker;
      }
    }
    const finalSample = sampleLiveTps(tracker, 2_300);
    expect(finalSample.snapshot.tps!).toBeGreaterThan(35);
    expect(finalSample.snapshot.tps!).toBeLessThan(48);
  });

  it("decays smoothly toward zero during tool-call pauses and recovers when streaming resumes", () => {
    let tracker = createLiveTpsTracker(run1, 0);
    tracker = observeLiveTpsProjection(tracker, makeSlice(), 0);
    let text = "a".repeat(20);
    tracker = observeLiveTpsProjection(
      tracker,
      makeSlice({ turnItems: [makeReasoningItem("r1", run1, text)] }),
      100,
    );
    for (let t = 200; t <= 1_000; t += 100) {
      text += "a".repeat(20);
      tracker = observeLiveTpsProjection(
        tracker,
        makeSlice({ turnItems: [makeReasoningItem("r1", run1, text)] }),
        t,
      );
    }
    let res = sampleLiveTps(tracker, 1_000);
    tracker = res.tracker;
    expect(res.snapshot.tps!).toBeGreaterThan(40);
    expect(res.snapshot.isStreaming).toBe(true);

    // Pause for > 2.5s rolling window + multiple decay ticks -> decays to 0
    for (let t = 3_750; t <= 6_000; t += 250) {
      res = sampleLiveTps(tracker, t);
      tracker = res.tracker;
    }
    expect(res.snapshot.isStreaming).toBe(false);
    expect(res.snapshot.tps).toBe(0);

    // Resume streaming at 60 tok/s across 100ms chunks with 250ms UI ticks
    let nextTick = 6_250;
    for (let t = 6_100; t <= 7_000; t += 100) {
      while (nextTick <= t) {
        res = sampleLiveTps(tracker, nextTick);
        tracker = res.tracker;
        nextTick += 250;
      }
      text += "a".repeat(24); // 60 tok/s
      tracker = observeLiveTpsProjection(
        tracker,
        makeSlice({ turnItems: [makeReasoningItem("r1", run1, text)] }),
        t,
      );
    }
    res = sampleLiveTps(tracker, 7_000);
    expect(res.snapshot.isStreaming).toBe(true);
    expect(res.snapshot.tps!).toBeGreaterThan(45);
  });

  it("uses provider-reported outputTokens without double counting streamed text", () => {
    let tracker = createLiveTpsTracker(run1, 0);
    tracker = observeLiveTpsProjection(
      tracker,
      makeSlice({ attempts: [makeAttempt()], providerTurns: [makeProviderTurn(0)] }),
      0,
    );
    // Anchor on step report (40 hidden output tokens)
    tracker = observeLiveTpsProjection(
      tracker,
      makeSlice({ attempts: [makeAttempt()], providerTurns: [makeProviderTurn(40)] }),
      1_000,
    );
    const singleReport = sampleLiveTps(tracker, 1_500);
    expect(singleReport.snapshot.source).toBe("reported");
    expect(singleReport.snapshot.tps).toBeGreaterThan(20);
    expect(singleReport.snapshot.tps).toBeLessThan(35);

    // Streamed text of 40 tokens + matching turnTokenUsage 42 tokens should use max (42), not sum (82)
    const afterTextAndUsage = observeLiveTpsProjection(
      singleReport.tracker,
      makeSlice({
        attempts: [makeAttempt()],
        providerTurns: [makeProviderTurn(42, true)],
        turnItems: [makeAssistantItem("a1", run1, "z".repeat(160))],
      }),
      1_750,
    );
    const afterSample = sampleLiveTps(afterTextAndUsage, 2_000);
    expect(afterSample.snapshot.totalTokens).toBe(42);
    expect(afterSample.snapshot.source).toBe("reported");
  });
});

describe("formatLiveTps", () => {
  it("formats null, fractional, and high-rate values stably", () => {
    expect(formatLiveTps(null)).toBe("--");
    expect(formatLiveTps(-3)).toBe("0.0");
    expect(formatLiveTps(0)).toBe("0.0");
    expect(formatLiveTps(42.36)).toBe("42.4");
    expect(formatLiveTps(99.94)).toBe("99.9");
    expect(formatLiveTps(100)).toBe("100");
    expect(formatLiveTps(245.7)).toBe("246");
  });
});
