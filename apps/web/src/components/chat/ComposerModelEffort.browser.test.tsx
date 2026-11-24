import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderOptionSelection,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { useState } from "react";
import { expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { act, render } from "../../../test/render";
import {
  ComposerEffortColumn,
  ComposerPickerFooter,
  describeComposerEffort,
} from "./ComposerModelEffort";
import type { TraitsSelectionInput } from "./TraitsPicker";

// Shaped like Devin over ACP: its session mode comes first, and its reasoning id is its own.
const models: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "fusion",
    name: "Fusion (Claude Opus 5.5 Medium + SWE-2 High)",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [
        {
          id: "mode",
          label: "Session Mode",
          type: "select",
          currentValue: "bypass",
          options: [
            { id: "code", label: "Code" },
            { id: "plan", label: "Plan" },
            { id: "bypass", label: "Bypass Permissions" },
          ],
        },
        {
          id: "thought_level",
          label: "Thinking",
          type: "select",
          role: "reasoning",
          currentValue: "medium",
          options: [
            { id: "low", label: "Low" },
            { id: "medium", label: "Medium" },
            { id: "high", label: "High" },
          ],
        },
        {
          id: "speed",
          label: "Speed",
          type: "select",
          currentValue: "standard",
          options: [
            { id: "standard", label: "Standard" },
            { id: "fast", label: "Fast" },
          ],
        },
        { id: "auto_approve", label: "Auto-approve tools", type: "boolean", currentValue: false },
      ],
    }),
  },
];

function traitsInput(
  modelOptions: ReadonlyArray<ProviderOptionSelection>,
  onModelOptionsChange: (next: ReadonlyArray<ProviderOptionSelection> | undefined) => void,
): TraitsSelectionInput {
  return {
    provider: ProviderDriverKind.make("acpRegistry"),
    instanceId: ProviderInstanceId.make("devin"),
    models,
    model: "fusion",
    modelOptions,
    onModelOptionsChange,
  };
}

function Column() {
  const [options, setOptions] = useState<ReadonlyArray<ProviderOptionSelection>>([]);
  const traits = traitsInput(options, (next) => setOptions(next ?? []));
  return (
    <>
      <div data-model-picker-effort>
        <ComposerEffortColumn traits={traits} />
      </div>
      <p role="status">{describeComposerEffort(traits, "bars", "sm").suffix}</p>
    </>
  );
}

it("draws an agent's reasoning as bars and keeps its mode out of the levels", async () => {
  await using screen = await render(<Column />, { router: false }); // no routes involved
  const status = screen.getByRole("status");
  expect(status.element().querySelector("[data-composer-effort-glyph]")).not.toBeNull();
  await expect.element(status).toHaveTextContent("");

  const levels = screen.getByRole("radiogroup", { name: "Thinking" });
  await expect.element(levels.getByRole("radio")).toHaveLength(3);
  await expect.element(screen.getByRole("radio", { name: "Plan" })).not.toBeInTheDocument();

  // Up and Down walk from the levels through the option rows without opening their menus.
  await userEvent.tab();
  await expect.element(screen.getByRole("radio", { name: "Medium" })).toHaveFocus();
  await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}");
  const speed = screen.getByRole("button", { name: "Speed: Standard" });
  await expect.element(speed).toHaveFocus();
  await expect.element(page.getByRole("menuitemradio")).not.toBeInTheDocument();
  await userEvent.keyboard("{ArrowRight}");
  await expect.element(page.getByRole("menuitemradio", { name: "Standard" })).toHaveFocus();
  await userEvent.keyboard("{ArrowLeft}");
  await expect.element(page.getByRole("menuitemradio")).not.toBeInTheDocument();
  await expect.element(speed).toHaveFocus();

  await userEvent.click(screen.getByText("Auto-approve tools"));
  await expect
    .element(screen.getByRole("switch", { name: "Auto-approve tools" }))
    .toHaveAttribute("aria-checked", "true");

  await userEvent.click(screen.getByRole("button", { name: "Session Mode: Bypass Permissions" }));
  await userEvent.click(page.getByRole("menuitemradio", { name: "Plan" }));
  await expect
    .element(screen.getByRole("button", { name: "Session Mode: Plan" }))
    .toBeInTheDocument();
  await expect.element(page.getByRole("menuitemradio")).not.toBeInTheDocument();
});

it("focuses a reasoning level by its first letter without selecting it", async () => {
  await using screen = await render(<Column />, { router: false }); // no routes involved
  await userEvent.tab();
  await expect.element(screen.getByRole("radio", { name: "Medium" })).toHaveFocus();
  await userEvent.keyboard("l");
  await expect.element(screen.getByRole("radio", { name: "Low" })).toHaveFocus();
  await expect
    .element(screen.getByRole("radio", { name: "Medium" }))
    .toHaveAttribute("aria-checked", "true");
  for (const key of ["{Control>}h{/Control}", "{Meta>}h{/Meta}", "{Alt>}h{/Alt}", "{Delete}"]) {
    await userEvent.keyboard(key);
    await expect.element(screen.getByRole("radio", { name: "Low" })).toHaveFocus();
  }
  await userEvent.keyboard("H");
  await expect.element(screen.getByRole("radio", { name: "High" })).toHaveFocus();
  // Wraps past the last level back to the first match.
  await userEvent.keyboard("m");
  await expect.element(screen.getByRole("radio", { name: "Medium" })).toHaveFocus();
  await userEvent.keyboard("h{Enter}");
  await expect
    .element(screen.getByRole("radio", { name: "High" }))
    .toHaveAttribute("aria-checked", "true");
});

const thinkingModels: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "orchestrator-neon",
    name: "Orchestrator (Neon)",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [
        {
          id: "thinking_level",
          label: "Thinking Level",
          type: "select",
          role: "reasoning",
          currentValue: "medium",
          promptInjectedValues: ["ultrathink"],
          options: [
            { id: "low", label: "Low" },
            { id: "medium", label: "Medium" },
            { id: "high", label: "High" },
            { id: "extra", label: "Extra" },
            { id: "ultrathink", label: "Ultrathink" },
          ],
        },
        {
          id: "cyber_access",
          label: "Cyber Access",
          type: "select",
          currentValue: "standard",
          options: [
            { id: "standard", label: "Standard" },
            { id: "extended", label: "Extended" },
          ],
        },
      ],
    }),
  },
];

function ThinkingSliderColumn(props: { promptUltrathink?: "none" | "body" }) {
  const [options, setOptions] = useState<ReadonlyArray<ProviderOptionSelection>>([]);
  const traits: TraitsSelectionInput = {
    provider: ProviderDriverKind.make("antigravity"),
    instanceId: ProviderInstanceId.make("antigravity"),
    models: thinkingModels,
    model: "orchestrator-neon",
    ...(props.promptUltrathink ? { promptUltrathink: props.promptUltrathink } : {}),
    modelOptions: options,
    onModelOptionsChange: (next) => setOptions(next ?? []),
  };
  return (
    <div data-model-picker-effort className="w-96">
      <ComposerEffortColumn traits={traits} />
    </div>
  );
}

function ThinkingPickerFooterHarness() {
  const [options, setOptions] = useState<ReadonlyArray<ProviderOptionSelection>>([]);
  const traits: TraitsSelectionInput = {
    provider: ProviderDriverKind.make("antigravity"),
    instanceId: ProviderInstanceId.make("antigravity"),
    models: thinkingModels,
    model: "orchestrator-neon",
    modelOptions: options,
    onModelOptionsChange: (next) => setOptions(next ?? []),
  };
  return (
    <>
      <p role="status">{describeComposerEffort(traits, "label", "sm").suffix}</p>
      <ComposerPickerFooter
        traits={traits}
        runtimeMode="full-access"
        runtimeModeOptions={[]}
        onRuntimeModeChange={() => {}}
      />
    </>
  );
}

it("updates cosmic tier during horizontal drag and commits on release", async () => {
  await using screen = await render(<ThinkingSliderColumn />, { router: false }); // no routes involved
  const chamber = screen.container.querySelector<HTMLElement>(".cosmic-effort-chamber")!;
  const backdropCanvas = chamber.querySelector<HTMLCanvasElement>("[data-cosmic-backdrop] canvas")!;
  expect(backdropCanvas).not.toBeNull();
  expect(backdropCanvas.width).toBeGreaterThan(0);
  expect(backdropCanvas.height).toBeGreaterThan(0);
  const track = screen.getByRole("slider", { name: "Thinking Level" });
  expect(chamber).toHaveAttribute("data-cosmic-tier", "2");
  await expect.element(track).toHaveAttribute("aria-orientation", "horizontal");
  await expect.element(track).toHaveAttribute("aria-valuetext", "Medium");

  const trackEl = track.element();
  const rect = trackEl.getBoundingClientRect();
  const centerY = rect.top + rect.height / 2;
  const leftX = rect.left + rect.width * 0.125;
  const rightX = rect.left + rect.width * 0.875;

  await act(() => {
    trackEl.dispatchEvent(
      new PointerEvent("pointerdown", {
        pointerId: 1,
        button: 0,
        clientX: leftX,
        clientY: centerY,
        bubbles: true,
      }),
    );
  });
  await expect.element(chamber).toHaveAttribute("data-cosmic-tier", "1");
  expect(chamber).not.toHaveAttribute("data-dragging");
  await expect
    .element(screen.getByRole("radio", { name: "Medium" }))
    .toHaveAttribute("aria-checked", "true");

  await act(() => {
    window.dispatchEvent(
      new PointerEvent("pointermove", {
        pointerId: 1,
        clientX: rightX,
        clientY: centerY,
        bubbles: true,
      }),
    );
  });
  await expect.element(chamber).toHaveAttribute("data-dragging", "");
  await expect.element(chamber).toHaveAttribute("data-cosmic-tier", "4");

  await act(() => {
    window.dispatchEvent(
      new PointerEvent("pointerup", {
        pointerId: 1,
        clientX: rightX,
        clientY: centerY,
        bubbles: true,
      }),
    );
  });
  await expect
    .element(screen.getByRole("radio", { name: "Extra" }))
    .toHaveAttribute("aria-checked", "true");
  expect(chamber).toHaveAttribute("data-cosmic-tier", "4");
  expect(chamber).not.toHaveAttribute("data-dragging");

  const indicator = chamber.querySelector<HTMLElement>(".cosmic-option-indicator")!;
  expect(indicator).not.toBeNull();
  expect(indicator.style.transform).toMatch(/^translate3d\(300%, 0(?:px)?, 0(?:px)?\)$/);

  await userEvent.click(screen.getByRole("radio", { name: "Low" }));
  await expect
    .element(screen.getByRole("radio", { name: "Low" }))
    .toHaveAttribute("aria-checked", "true");
  expect(chamber).toHaveAttribute("data-cosmic-tier", "1");
  expect(indicator.style.transform).toMatch(/^translate3d\(0(?:%|px)?, 0(?:px)?, 0(?:px)?\)$/);

  await userEvent.keyboard("{ArrowRight}{ArrowRight}{Enter}");
  await expect
    .element(screen.getByRole("radio", { name: "High" }))
    .toHaveAttribute("aria-checked", "true");
  expect(chamber).toHaveAttribute("data-cosmic-tier", "3");
});

it("locks dragging and shows the ultra tier when ultrathink is in the prompt body", async () => {
  await using screen = await render(<ThinkingSliderColumn promptUltrathink="body" />, {
    router: false,
  }); // no routes involved
  const chamber = screen.container.querySelector<HTMLElement>(".cosmic-effort-chamber")!;
  const track = screen.getByRole("slider", { name: "Thinking Level" });
  expect(chamber).toHaveAttribute("data-cosmic-tier", "6");
  await expect.element(track).toHaveAttribute("aria-disabled", "true");

  const trackEl = track.element();
  const rect = trackEl.getBoundingClientRect();
  await act(() => {
    trackEl.dispatchEvent(
      new PointerEvent("pointerdown", {
        pointerId: 2,
        button: 0,
        clientX: rect.left + rect.width * 0.125,
        clientY: rect.top + rect.height / 2,
        bubbles: true,
      }),
    );
  });
  await act(() => {
    window.dispatchEvent(
      new PointerEvent("pointerup", {
        pointerId: 2,
        clientX: rect.left + rect.width * 0.125,
        clientY: rect.top + rect.height / 2,
        bubbles: true,
      }),
    );
  });
  expect(chamber).toHaveAttribute("data-cosmic-tier", "6");
  await expect.element(screen.getByRole("radio", { name: "Low" })).toBeDisabled();
});

it("puts the thinking slider in the picker footer and keeps other options in its row", async () => {
  await using screen = await render(<ThinkingPickerFooterHarness />, { router: false }); // no routes involved
  await expect.element(screen.getByRole("slider", { name: "Thinking Level" })).toBeVisible();
  const band = document.querySelector("[data-model-picker-effort]");
  expect(band?.textContent).not.toContain("Cyber Access");

  const status = screen.getByRole("status");
  await expect.element(status).toHaveTextContent("Medium");
  expect(status.element().querySelector(".cosmic-trigger-dot")).not.toBeNull();
  await userEvent.click(screen.getByRole("radio", { name: "Extra" }));
  await expect.element(status).toHaveTextContent("Extra");

  await userEvent.click(screen.getByRole("button", { name: "Cyber Access: Standard" }));
  await userEvent.click(page.getByRole("menuitemradio", { name: "Extended" }));
  await expect
    .element(screen.getByRole("button", { name: "Cyber Access: Extended" }))
    .toBeInTheDocument();
});
