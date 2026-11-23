import type { EnvironmentThread } from "@t3tools/client-runtime/state/models";
import {
  EnvironmentId,
  MessageId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ThreadProjection,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({
  atom: null as unknown as Atom.Writable<EnvironmentThread | null>,
}));

vi.mock(import("../../state/threads"), () => {
  state.atom = Atom.make<EnvironmentThread | null>(null).pipe(Atom.keepAlive);
  return {
    environmentThreadDetails: {
      threadAtom: () => state.atom,
    },
  } as never;
});

import "~/index.css";

import { act, fakeTimers, render } from "../../../test/render";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { makeThreadProjectionFixture } from "../../test-fixtures";
import { ComposerBanner } from "./ComposerBanner";
import { ComposerStashBadge } from "./ComposerStashBadge";
import { ComposerTpsBadge } from "./ComposerTpsBadge";

const environmentId = EnvironmentId.make("env-1");
const threadId = ThreadId.make("thread-1");
const run1 = RunId.make("run-1");
const threadRef: ScopedThreadRef = { environmentId, threadId };
const baseNow = DateTime.makeUnsafe("2026-06-20T00:00:00.000Z");

function makeProjection(text: string): OrchestrationV2ThreadProjection {
  const base = makeThreadProjectionFixture();
  return {
    ...base,
    thread: { ...base.thread, id: threadId },
    turnItems:
      text.length === 0
        ? []
        : [
            {
              id: TurnItemId.make("item-assistant-1"),
              threadId,
              runId: run1,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 1,
              status: "running",
              title: null,
              startedAt: baseNow,
              completedAt: null,
              updatedAt: baseNow,
              type: "assistant_message",
              messageId: MessageId.make("msg-1"),
              text,
              streaming: true,
            },
          ],
  };
}

function DockHarness(props: { readonly activeRunId: RunId | null; readonly stashCount?: number }) {
  return (
    <form className="relative mx-auto mt-16 w-full max-w-2xl">
      <ComposerTpsBadge threadRef={threadRef} activeRunId={props.activeRunId} />
      <ComposerBanner.Dock data-testid="dock">
        <ComposerBanner.Column />
        <ComposerStashBadge
          count={props.stashCount ?? 0}
          menuOpen={false}
          pulseKey={0}
          onToggleMenu={() => {}}
        />
      </ComposerBanner.Dock>
      <div className="h-20 rounded-2xl border border-border bg-card" />
    </form>
  );
}

it("stays hidden while idle, tracks live streaming TPS, and hides when the run ends", async () => {
  appAtomRegistry.set(state.atom, {
    environmentId,
    projection: makeProjection(""),
  });
  await using screen = await render(<DockHarness activeRunId={null} />);

  expect(screen.container.querySelector('[data-composer-tps-badge="true"]')).toBeNull();
  expect(getComputedStyle(screen.getByTestId("dock").element()).display).toBe("none");

  using _timers = fakeTimers();

  await screen.rerender(<DockHarness activeRunId={run1} />);
  const badge = page.getByRole("status");
  await expect.element(badge).toBeVisible();
  expect(badge.element().textContent).toContain("--");
  expect(badge.element().textContent).toContain("tok/s");

  // Stream initial anchor chunk, then sustain steady streaming deltas over fake timer ticks.
  let text = "a".repeat(20);
  await act(async () => {
    appAtomRegistry.set(state.atom, { environmentId, projection: makeProjection(text) });
    await vi.advanceTimersByTimeAsync(100);
  });

  for (let step = 0; step < 5; step += 1) {
    text += "a".repeat(40); // 10 tokens per 250ms -> ~40 tok/s
    await act(async () => {
      appAtomRegistry.set(state.atom, { environmentId, projection: makeProjection(text) });
      await vi.advanceTimersByTimeAsync(250);
    });
  }

  expect(badge.element().textContent).toMatch(/\d+\.\d+\s*tok\/s/);

  await screen.rerender(<DockHarness activeRunId={null} />);
  await expect.element(badge).not.toBeInTheDocument();
  expect(getComputedStyle(screen.getByTestId("dock").element()).display).toBe("none");
});

it("renders without a background or border and floats cleanly above ComposerStashBadge", async () => {
  appAtomRegistry.set(state.atom, {
    environmentId,
    projection: makeProjection(""),
  });
  await using screen = await render(<DockHarness activeRunId={run1} stashCount={2} />);

  const tps = screen.container.querySelector('[data-composer-tps-badge="true"]');
  const stash = screen.container.querySelector('[data-prompt-stash-badge="true"]');
  expect(tps).not.toBeNull();
  expect(stash).not.toBeNull();

  const style = getComputedStyle(tps!);
  expect(style.backgroundColor).toBe("rgba(0, 0, 0, 0)");
  expect(style.borderTopWidth).toBe("0px");

  const tpsRect = tps!.getBoundingClientRect();
  const stashRect = stash!.getBoundingClientRect();
  expect(tpsRect.bottom).toBeLessThanOrEqual(stashRect.top + 1);
});
