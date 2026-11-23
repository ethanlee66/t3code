export type CosmicDepthTier = 0 | 1 | 2 | 3 | 4;

export interface CosmicDepthProfile {
  readonly tier: CosmicDepthTier;
  readonly progress: number;
  readonly intensity: number;
}

const TIER_0_IDS = new Set(["off", "none", "false", "disabled"]);
const TIER_1_IDS = new Set(["minimal", "min", "low"]);
const TIER_2_IDS = new Set(["medium", "med", "balanced", "default", "auto", "normal"]);
const TIER_3_IDS = new Set(["high", "true", "on"]);
const TIER_4_IDS = new Set([
  "xhigh",
  "extra",
  "extra_high",
  "extra-high",
  "super-high",
  "max",
  "ultra",
  "ultrathink",
  "ultracode",
]);

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function isOffOptionId(optionId: string | undefined): boolean {
  if (!optionId) return false;
  return TIER_0_IDS.has(optionId.trim().toLowerCase());
}

export function resolveCosmicDepthTier(
  optionId: string,
  index: number,
  count: number,
  startsAtOff: boolean,
): CosmicDepthTier {
  const normalized = optionId.trim().toLowerCase();
  if (TIER_0_IDS.has(normalized)) return 0;
  if (TIER_1_IDS.has(normalized)) return 1;
  if (TIER_2_IDS.has(normalized)) return 2;
  if (TIER_3_IDS.has(normalized)) return 3;
  if (TIER_4_IDS.has(normalized)) return 4;

  if (startsAtOff) {
    if (index <= 0 || count <= 1) return 0;
    const ratio = (index - 1) / Math.max(count - 2, 1);
    return Math.min(4, Math.max(1, 1 + Math.round(ratio * 3))) as CosmicDepthTier;
  }

  if (count <= 1) return 2;
  const ratio = index / Math.max(count - 1, 1);
  return Math.min(4, Math.max(1, 1 + Math.round(ratio * 3))) as CosmicDepthTier;
}

export function resolveCosmicDepthProfile(input: {
  readonly options: ReadonlyArray<{ readonly id: string }>;
  readonly activeIndex: number;
  readonly fallbackTier?: CosmicDepthTier;
  readonly continuousProgress?: number;
}): CosmicDepthProfile {
  const { options, activeIndex, fallbackTier, continuousProgress } = input;
  const count = options.length;
  const startsAtOff = isOffOptionId(options[0]?.id);

  let tier: CosmicDepthTier;
  let progress: number;

  if (activeIndex < 0 || activeIndex >= count) {
    tier = fallbackTier ?? 2;
    const fallbackProgress = tier === 4 ? 1 : tier === 0 ? 0 : 0.5;
    progress = continuousProgress !== undefined ? clamp01(continuousProgress) : fallbackProgress;
  } else {
    tier = resolveCosmicDepthTier(options[activeIndex]!.id, activeIndex, count, startsAtOff);
    const stopProgress = count <= 1 ? 0.5 : activeIndex / (count - 1);
    progress = continuousProgress !== undefined ? clamp01(continuousProgress) : stopProgress;
  }

  let intensity: number;
  if (tier === 0) intensity = 0.12;
  else if (tier === 1) intensity = 0.35 + progress * 0.1;
  else if (tier === 2) intensity = 0.58 + progress * 0.1;
  else if (tier === 3) intensity = 0.8 + progress * 0.1;
  else intensity = 1;

  return { tier, progress, intensity };
}

export function stopCenterPercent(index: number, count: number): number {
  if (count <= 1) return 50;
  return ((index + 0.5) / count) * 100;
}

export function progressToTrackPercent(progress: number, count: number): number {
  if (count <= 1) return 50;
  const clamped = clamp01(progress);
  return ((0.5 + clamped * (count - 1)) / count) * 100;
}

export function indexFromTrackRatio(ratio: number, count: number): number {
  if (count <= 1) return 0;
  return Math.round(clamp01(ratio) * (count - 1));
}

export function ratioFromPointerX(
  clientX: number,
  rect: { readonly left: number; readonly width: number },
  count: number,
): number {
  if (count <= 1 || rect.width <= 0) return 0.5;
  const firstCenter = rect.left + rect.width / (2 * count);
  const lastCenter = rect.left + rect.width - rect.width / (2 * count);
  const span = lastCenter - firstCenter;
  if (span <= 0) return 0.5;
  return clamp01((clientX - firstCenter) / span);
}
