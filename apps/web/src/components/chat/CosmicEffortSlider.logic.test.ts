import { describe, expect, it } from "vite-plus/test";

import {
  indexFromTrackRatio,
  progressToTrackPercent,
  ratioFromPointerX,
  resolveCosmicDepthProfile,
  resolveCosmicDepthTier,
  stopCenterPercent,
} from "./CosmicEffortSlider.logic";

describe("CosmicEffortSlider.logic", () => {
  it("maps Antigravity 4-level thinking scale to tiers 1..4 and exact centers", () => {
    const options = [{ id: "low" }, { id: "medium" }, { id: "high" }, { id: "extra" }];
    expect(
      options.map((opt, index) => resolveCosmicDepthTier(opt.id, index, options.length, false)),
    ).toEqual([1, 2, 3, 4]);
    expect(options.map((_, index) => stopCenterPercent(index, options.length))).toEqual([
      12.5, 37.5, 62.5, 87.5,
    ]);
  });

  it("gives every named level from off through ultra its own tier", () => {
    const options = [
      { id: "off" },
      { id: "low" },
      { id: "medium" },
      { id: "high" },
      { id: "xhigh" },
      { id: "max" },
      { id: "ultra" },
    ];
    expect(
      options.map((opt, index) => resolveCosmicDepthTier(opt.id, index, options.length, true)),
    ).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(resolveCosmicDepthProfile({ options, activeIndex: 0 }).intensity).toBe(0.12);
    expect(resolveCosmicDepthProfile({ options, activeIndex: 6 })).toEqual({
      tier: 6,
      progress: 1,
      intensity: 1,
    });
  });

  it("maps boolean thinking options to dormant (0) and supernova (3)", () => {
    const options = [{ id: "false" }, { id: "true" }];
    expect(resolveCosmicDepthProfile({ options, activeIndex: 0 }).tier).toBe(0);
    expect(resolveCosmicDepthProfile({ options, activeIndex: 1 }).tier).toBe(3);
  });

  it("maps arbitrary custom ACP ids monotonically across tiers", () => {
    const custom = [{ id: "tier_a" }, { id: "tier_b" }, { id: "tier_c" }, { id: "tier_d" }];
    expect(
      custom.map((opt, index) => resolveCosmicDepthTier(opt.id, index, custom.length, false)),
    ).toEqual([1, 2, 3, 4]);

    const offCustom = [
      { id: "none" },
      { id: "step_1" },
      { id: "step_2" },
      { id: "step_3" },
      { id: "step_4" },
    ];
    expect(
      offCustom.map((opt, index) => resolveCosmicDepthTier(opt.id, index, offCustom.length, true)),
    ).toEqual([0, 1, 2, 3, 4]);
  });

  it("handles unlisted prompt-injected ultrathink and single-option edge cases", () => {
    const options = [{ id: "low" }, { id: "medium" }, { id: "high" }];
    expect(resolveCosmicDepthProfile({ options, activeIndex: -1, fallbackTier: 6 })).toEqual({
      tier: 6,
      progress: 1,
      intensity: 1,
    });

    const single = [{ id: "custom" }];
    expect(stopCenterPercent(0, 1)).toBe(50);
    expect(progressToTrackPercent(0.25, 1)).toBe(50);
    expect(indexFromTrackRatio(0.9, 1)).toBe(0);
    expect(ratioFromPointerX(120, { left: 100, width: 40 }, 1)).toBe(0.5);
    expect(resolveCosmicDepthProfile({ options: single, activeIndex: 0 })).toEqual({
      tier: 2,
      progress: 0.5,
      intensity: 0.63,
    });
  });

  it("converts horizontal pointer X coordinates and track ratios accurately including clamping", () => {
    const rect = { left: 100, width: 320 };
    // 4 options -> each column 80px -> centers at 140, 220, 300, 380.
    expect(ratioFromPointerX(90, rect, 4)).toBe(0);
    expect(ratioFromPointerX(140, rect, 4)).toBe(0);
    expect(ratioFromPointerX(260, rect, 4)).toBe(0.5);
    expect(ratioFromPointerX(380, rect, 4)).toBe(1);
    expect(ratioFromPointerX(460, rect, 4)).toBe(1);

    expect(indexFromTrackRatio(-0.2, 4)).toBe(0);
    expect(indexFromTrackRatio(0.33, 4)).toBe(1);
    expect(indexFromTrackRatio(0.67, 4)).toBe(2);
    expect(indexFromTrackRatio(1.4, 4)).toBe(3);

    expect(progressToTrackPercent(0, 4)).toBe(12.5);
    expect(progressToTrackPercent(1, 4)).toBe(87.5);
  });
});
