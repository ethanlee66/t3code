import { observeResize } from "~/lib/observeResize";

export interface CosmicBackdropState {
  readonly tier: number;
  readonly progress: number;
  readonly thumbFraction: number;
  readonly hasLockedNote: boolean;
  readonly dragging: boolean;
}

export interface CosmicBackdropController {
  update: (next: CosmicBackdropState) => void;
  destroy: () => void;
}

const VERTEX_SHADER_SOURCE = `
attribute vec2 a_position;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER_SOURCE = `
precision highp float;

uniform vec2 u_resolution;
uniform float u_time;
uniform float u_rawTime;
uniform float u_tier;
uniform float u_progress;
uniform vec2 u_thumb;
uniform float u_drag;
uniform float u_surge;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash12(i);
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

const mat2 OCTAVE_ROT = mat2(0.80, -0.60, 0.60, 0.80);

float fbm(vec2 p) {
  float value = 0.0;
  float amp = 0.5;
  value += amp * vnoise(p);
  p = OCTAVE_ROT * p * 2.03 + vec2(17.1, 31.7);
  amp *= 0.5;
  value += amp * vnoise(p);
  p = OCTAVE_ROT * p * 2.01 + vec2(11.3, 23.9);
  amp *= 0.5;
  value += amp * vnoise(p);
  p = OCTAVE_ROT * p * 2.04 + vec2(5.7, 19.3);
  amp *= 0.5;
  value += amp * vnoise(p);
  return value;
}

float ridgedFbm(vec2 p) {
  float value = 0.0;
  float amp = 0.5;
  float n = 1.0 - abs(vnoise(p) * 2.0 - 1.0);
  value += amp * n * n;
  p = OCTAVE_ROT * p * 2.05 + vec2(13.4, 27.1);
  amp *= 0.5;
  n = 1.0 - abs(vnoise(p) * 2.0 - 1.0);
  value += amp * n * n;
  p = OCTAVE_ROT * p * 2.03 + vec2(29.8, 7.2);
  amp *= 0.5;
  n = 1.0 - abs(vnoise(p) * 2.0 - 1.0);
  value += amp * n * n;
  p = OCTAVE_ROT * p * 2.02 + vec2(3.1, 41.6);
  amp *= 0.5;
  n = 1.0 - abs(vnoise(p) * 2.0 - 1.0);
  value += amp * n * n;
  return value;
}

vec3 acesToneMap(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

vec3 starPlane(vec2 p, float scale, float density, float glowScale, float time, float warpStretch) {
  vec2 sp = p * scale;
  vec2 cell = floor(sp);
  vec2 local = fract(sp) - 0.5;
  vec2 rnd = hash22(cell);
  float exists = step(density, hash12(cell + vec2(42.7, 19.3)));
  vec2 offset = (rnd - 0.5) * 0.72;
  vec2 d = local - offset;
  d.x /= warpStretch;
  float dist2 = dot(d, d);
  float twinkle = 0.72 + 0.28 * sin(time * (1.2 + rnd.x * 2.4) + rnd.y * 6.28318);
  float psf = (glowScale / (dist2 + glowScale * 0.68)) * exp(-dist2 * 18.0);
  float temp = hash12(cell + vec2(8.1, 71.4));
  vec3 tint = mix(vec3(0.76, 0.89, 1.0), vec3(1.0, 0.96, 0.88), smoothstep(0.25, 0.75, temp));
  tint = mix(tint, vec3(0.90, 0.82, 1.0), smoothstep(0.78, 0.98, temp) * 0.75);
  return tint * psf * exists * twinkle;
}

void main() {
  vec2 uv = gl_FragCoord.xy / max(u_resolution, vec2(1.0, 1.0));
  float aspect = u_resolution.x / max(u_resolution.y, 1.0);
  vec2 st = (uv - 0.5) * vec2(aspect, 1.0);
  vec2 thumbSt = (u_thumb - 0.5) * vec2(aspect, 1.0);

  float w0 = clamp(1.0 - u_tier, 0.0, 1.0);
  float w1 = clamp(1.0 - abs(u_tier - 1.0), 0.0, 1.0);
  float w2 = clamp(1.0 - abs(u_tier - 2.0), 0.0, 1.0);
  float w3 = clamp(1.0 - abs(u_tier - 3.0), 0.0, 1.0);
  float w4 = clamp(u_tier - 3.0, 0.0, 1.0);

  vec2 deltaT = st - thumbSt;
  float distT = length(deltaT);
  float lensStrength = exp(-distT * distT * 3.6) * smoothstep(0.0, 2.5, u_tier) * (0.045 + 0.032 * u_drag + 0.038 * u_surge);
  vec2 perpT = vec2(-deltaT.y, deltaT.x);
  vec2 safeDirT = deltaT / max(distT, 0.0001);
  vec2 spaceP = st + perpT * lensStrength * 1.45 - safeDirT * lensStrength * 0.42;

  // Tier 0: Deep obsidian void with ultra-subtle cool cosmic dust
  vec3 c0 = vec3(0.012, 0.015, 0.028);
  if (w0 > 0.001) {
    float dust0 = fbm(spaceP * 1.15 + vec2(u_time * 0.025, -u_time * 0.018));
    c0 += vec3(0.06, 0.09, 0.17) * smoothstep(0.35, 0.85, dust0) * 0.65;
  }

  // Tier 1: Abyssal sapphire & glacial sky aurora curtains
  vec3 c1 = vec3(0.010, 0.017, 0.036);
  if (w1 > 0.001) {
    float fold = fbm(vec2(spaceP.x * 1.35 + u_time * 0.11, spaceP.y * 0.72 - u_time * 0.05));
    float curtainA = exp(-abs(spaceP.y - 0.08 + sin(spaceP.x * 2.15 + fold * 3.1 - u_time * 0.36) * 0.21) * 5.4);
    float curtainB = exp(-abs(spaceP.y - 0.15 + cos(spaceP.x * 1.65 - fold * 2.6 + u_time * 0.28) * 0.19) * 6.2);
    float ribbonFade = smoothstep(0.18, 0.82, fbm(spaceP * 0.85 + vec2(-u_time * 0.06, u_time * 0.04)));
    float skyMask = smoothstep(-0.34, 0.28, spaceP.y);
    c1 += vec3(0.05, 0.22, 0.64) * curtainA * (0.55 + 0.45 * ribbonFade) * skyMask;
    c1 += vec3(0.04, 0.56, 0.82) * (curtainA * 0.65 + curtainB * 0.72) * ribbonFade * skyMask;
    c1 += vec3(0.38, 0.82, 0.96) * pow(clamp(curtainA * curtainB * 1.7, 0.0, 1.0), 1.3) * 0.58 * skyMask;
  }

  // Tier 2: Two-stage Quilez domain-warped cobalt & indigo nebula clouds
  vec3 c2 = vec3(0.012, 0.012, 0.042);
  if (w2 > 0.001) {
    vec2 p2 = spaceP * 1.25;
    vec2 q = vec2(
      fbm(p2 + vec2(u_time * 0.09, u_time * 0.04)),
      fbm(p2 + vec2(5.2 - u_time * 0.07, 1.3 + u_time * 0.08))
    );
    vec2 r = vec2(
      fbm(p2 * 1.15 + 1.75 * q + vec2(1.7 + u_time * 0.13, 9.2)),
      fbm(p2 * 1.15 + 1.75 * q + vec2(8.3, 2.8 - u_time * 0.10))
    );
    float f = fbm(p2 * 1.1 + 1.65 * r);
    float voidMask = smoothstep(0.24, 0.78, f);
    c2 += mix(vec3(0.11, 0.10, 0.46), vec3(0.16, 0.28, 0.82), clamp(q.x * 1.2, 0.0, 1.0)) * voidMask * 0.92;
    c2 += vec3(0.24, 0.42, 0.92) * smoothstep(0.38, 0.88, r.y) * voidMask * 0.72;
    c2 += vec3(0.54, 0.58, 0.98) * pow(clamp(length(q) * 0.78, 0.0, 1.0), 2.1) * smoothstep(0.42, 0.86, f) * 0.65;
  }

  // Tier 3: Ridged multifractal royal violet plasma filaments
  vec3 c3 = vec3(0.016, 0.006, 0.036);
  if (w3 > 0.001) {
    vec2 swirl = vec2(
      fbm(spaceP * 1.15 + vec2(u_time * 0.14, -u_time * 0.10)),
      fbm(spaceP * 1.15 + vec2(3.7 - u_time * 0.11, 8.1 + u_time * 0.12))
    );
    vec2 flowP = spaceP * 1.45 + 0.68 * swirl;
    float ridgeA = ridgedFbm(flowP + vec2(u_time * 0.15, -u_time * 0.11));
    float ridgeB = ridgedFbm(flowP * 1.35 + vec2(-u_time * 0.13, u_time * 0.18 + 6.4));
    float veinA = pow(clamp(ridgeA, 0.0, 1.0), 2.45);
    float veinB = pow(clamp(ridgeB, 0.0, 1.0), 2.85);
    c3 += vec3(0.20, 0.08, 0.56) * smoothstep(0.26, 0.80, swirl.x) * 0.72;
    c3 += vec3(0.50, 0.18, 0.86) * veinA * 0.92;
    c3 += vec3(0.68, 0.34, 0.96) * veinB * 0.62;
    c3 += vec3(0.90, 0.82, 1.0) * smoothstep(0.24, 0.74, veinA * veinB * 1.8) * 0.85;
  }

  // Tier 4: Event-horizon 3-stage abyssal ultraviolet & starlight liquid turbulence
  vec3 c4 = vec3(0.007, 0.004, 0.018);
  if (w4 > 0.001) {
    vec2 p4 = spaceP * 1.22;
    vec2 wA = vec2(
      fbm(p4 + vec2(u_time * 0.17, -u_time * 0.12)),
      fbm(p4 + vec2(4.1 - u_time * 0.14, 7.6 + u_time * 0.15))
    );
    vec2 wB = vec2(
      fbm(p4 * 1.28 + 2.05 * wA + vec2(u_time * 0.21, 3.3)),
      fbm(p4 * 1.28 + 2.05 * wA + vec2(6.9, -u_time * 0.18))
    );
    float liquid = fbm(p4 * 1.38 + 1.9 * wB);
    float fil = pow(clamp(ridgedFbm(p4 * 1.55 + 1.35 * wB - vec2(u_time * 0.13, -u_time * 0.09)), 0.0, 1.0), 2.15);
    float ultraBoost = smoothstep(0.55, 1.0, u_progress);
    float riverMask = smoothstep(0.32, 0.82, liquid + fil * 0.34);
    float foldMix = smoothstep(0.20, 0.82, dot(wA, wB) * 0.95);
    vec3 abyssCurrent = mix(vec3(0.10, 0.14, 0.52), vec3(0.46, 0.18, 0.88), foldMix);
    float edgeSheen = smoothstep(0.44, 0.76, liquid) * (1.0 - smoothstep(0.76, 0.96, liquid));
    c4 += abyssCurrent * riverMask * (0.90 + 0.16 * ultraBoost);
    c4 += vec3(0.34, 0.58, 1.0) * edgeSheen * riverMask * 0.42;
    c4 += mix(vec3(0.70, 0.46, 0.98), vec3(0.95, 0.92, 1.0), smoothstep(0.26, 0.78, fil)) * fil * (0.68 + 0.24 * ultraBoost);
  }

  vec3 col = c0 * w0 + c1 * w1 + c2 * w2 + c3 * w3 + c4 * w4;

  // Multi-plane astronomical parallax starfield
  float warpStretch = 1.0 + w4 * 1.35 + u_surge * 0.9;
  float parallaxShift = u_progress - 0.5;
  vec3 stars = vec3(0.0);
  stars += starPlane(spaceP + vec2(parallaxShift * 0.08, 0.0), 9.5, 0.84, 0.00055, u_rawTime, 1.0) * 0.78;
  stars += starPlane(spaceP + vec2(parallaxShift * 0.16 + 11.4, 3.7), 6.2, 0.89, 0.00095, u_rawTime * 1.15, warpStretch) * 0.92;
  stars += starPlane(spaceP + vec2(parallaxShift * 0.26 + 27.9, -7.1), 3.9, 0.93, 0.00145, u_rawTime * 1.3, 1.0 + w4 * 1.85 + u_surge * 1.1) * 1.05;
  col += stars * (0.68 + 0.32 * (1.0 - w0 * 0.5));

  // Soft localized thumb optical spotlight (no geometric border rings)
  vec3 thumbTint =
    vec3(0.62, 0.70, 0.85) * w0 +
    vec3(0.22, 0.76, 0.96) * w1 +
    vec3(0.46, 0.56, 0.98) * w2 +
    vec3(0.68, 0.44, 0.98) * w3 +
    vec3(0.84, 0.78, 1.0) * w4;
  float thumbGlow = exp(-distT * distT * 4.4) * (0.26 + 0.20 * u_drag + 0.22 * u_surge + 0.12 * smoothstep(0.0, 4.0, u_tier));
  col += thumbTint * thumbGlow;

  // ACES filmic tone map, readability scrim under stop labels, and micro-grain dithering
  col = acesToneMap(col);
  float scrim = mix(0.42, 1.0, smoothstep(0.0, 0.46, uv.y));
  col *= scrim;
  col += (hash12(gl_FragCoord.xy + fract(u_rawTime) * 37.0) - 0.5) * (1.8 / 255.0);
  col = clamp(col, 0.0, 1.0);

  gl_FragColor = vec4(col, 1.0);
}
`;

interface FallbackStar {
  readonly x: number;
  readonly y: number;
  readonly r: number;
  readonly depth: number;
  readonly phase: number;
  readonly tint: string;
}

const FALLBACK_STARS: ReadonlyArray<FallbackStar> = [
  { x: 0.07, y: 0.18, r: 0.9, depth: 0.04, phase: 0.4, tint: "#bae6fd" },
  { x: 0.14, y: 0.34, r: 0.7, depth: 0.08, phase: 1.9, tint: "#ffffff" },
  { x: 0.22, y: 0.14, r: 1.0, depth: 0.12, phase: 3.1, tint: "#e9d5ff" },
  { x: 0.31, y: 0.28, r: 0.8, depth: 0.06, phase: 4.5, tint: "#fef3c7" },
  { x: 0.41, y: 0.2, r: 1.1, depth: 0.1, phase: 2.3, tint: "#ffffff" },
  { x: 0.53, y: 0.32, r: 0.75, depth: 0.14, phase: 5.2, tint: "#bae6fd" },
  { x: 0.64, y: 0.16, r: 0.95, depth: 0.05, phase: 1.1, tint: "#e9d5ff" },
  { x: 0.76, y: 0.3, r: 0.85, depth: 0.11, phase: 3.8, tint: "#ffffff" },
  { x: 0.87, y: 0.22, r: 1.05, depth: 0.07, phase: 2.7, tint: "#fef3c7" },
  { x: 0.94, y: 0.38, r: 0.7, depth: 0.13, phase: 0.9, tint: "#bae6fd" },
];

const TIER_PALETTES_2D: ReadonlyArray<readonly [string, string, string, string]> = [
  ["#04050a", "rgba(148, 163, 184, 0.14)", "rgba(56, 189, 248, 0.08)", "rgba(203, 213, 225, 0.22)"],
  ["#03050c", "rgba(37, 99, 235, 0.30)", "rgba(56, 189, 248, 0.30)", "rgba(186, 230, 253, 0.36)"],
  ["#040412", "rgba(59, 130, 246, 0.32)", "rgba(99, 102, 241, 0.36)", "rgba(165, 180, 252, 0.40)"],
  ["#070312", "rgba(79, 70, 229, 0.36)", "rgba(139, 92, 246, 0.40)", "rgba(196, 181, 253, 0.44)"],
  ["#04020b", "rgba(67, 56, 202, 0.38)", "rgba(124, 58, 237, 0.42)", "rgba(245, 243, 255, 0.48)"],
];

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function compileShader(
  gl: WebGLRenderingContext,
  type: number,
  source: string,
): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function drawCosmicFallback2D(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  phase: number,
  rawTime: number,
  tier: number,
  progress: number,
  thumbX: number,
  thumbYTop: number,
  drag: number,
  surge: number,
) {
  const paletteIndex = clamp(Math.round(tier), 0, 4);
  const palette = TIER_PALETTES_2D[paletteIndex] ?? TIER_PALETTES_2D[0]!;
  const [baseColor, cloudAColor, cloudBColor, thumbGlowColor] = palette;

  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = baseColor;
  ctx.fillRect(0, 0, width, height);

  ctx.globalCompositeOperation = "lighter";
  const c1x = width * (0.28 + Math.sin(phase * 0.45) * 0.08);
  const c1y = height * (0.36 + Math.cos(phase * 0.35) * 0.08);
  const gradA = ctx.createRadialGradient(c1x, c1y, 0, c1x, c1y, width * 0.45);
  gradA.addColorStop(0, cloudAColor);
  gradA.addColorStop(1, "rgba(0, 0, 0, 0)");
  ctx.fillStyle = gradA;
  ctx.fillRect(0, 0, width, height);

  const c2x = width * (0.72 + Math.cos(phase * 0.4) * 0.09);
  const c2y = height * (0.42 + Math.sin(phase * 0.5) * 0.09);
  const gradB = ctx.createRadialGradient(c2x, c2y, 0, c2x, c2y, width * 0.42);
  gradB.addColorStop(0, cloudBColor);
  gradB.addColorStop(1, "rgba(0, 0, 0, 0)");
  ctx.fillStyle = gradB;
  ctx.fillRect(0, 0, width, height);

  const tx = thumbX * width;
  const ty = thumbYTop * height;
  const gradThumb = ctx.createRadialGradient(
    tx,
    ty,
    0,
    tx,
    ty,
    width * (0.2 + drag * 0.06 + surge * 0.08),
  );
  gradThumb.addColorStop(0, thumbGlowColor);
  gradThumb.addColorStop(1, "rgba(0, 0, 0, 0)");
  ctx.globalAlpha = Math.min(1, 0.78 + drag * 0.12 + surge * 0.22);
  ctx.fillStyle = gradThumb;
  ctx.fillRect(0, 0, width, height);
  ctx.globalAlpha = 1;

  for (const star of FALLBACK_STARS) {
    const sx = ((star.x - (progress - 0.5) * star.depth + 1) % 1) * width;
    const sy = star.y * height;
    const alpha = 0.45 + 0.45 * (0.5 + 0.5 * Math.sin(rawTime * 1.6 + star.phase));
    ctx.globalAlpha = alpha;
    ctx.fillStyle = star.tint;
    ctx.beginPath();
    ctx.arc(sx, sy, star.r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  ctx.globalCompositeOperation = "source-over";
  const scrim = ctx.createLinearGradient(0, height * 0.42, 0, height);
  scrim.addColorStop(0, "rgba(2, 3, 8, 0)");
  scrim.addColorStop(1, "rgba(2, 3, 8, 0.72)");
  ctx.fillStyle = scrim;
  ctx.fillRect(0, 0, width, height);
}

const DEFAULT_BACKDROP_STATE: CosmicBackdropState = {
  tier: 2,
  progress: 0.5,
  thumbFraction: 0.5,
  hasLockedNote: false,
  dragging: false,
};

export function mountCosmicBackdrop(
  canvas: HTMLCanvasElement,
  initialState?: CosmicBackdropState,
): CosmicBackdropController {
  let initialized = Boolean(initialState);
  let targetState = initialState ?? DEFAULT_BACKDROP_STATE;
  let currentTier = targetState.tier;
  let currentProgress = targetState.progress;
  let currentThumbFraction = targetState.thumbFraction;
  let currentDrag = targetState.dragging ? 1 : 0;
  let currentSurge = 0;

  let cssWidth = Math.max(canvas.clientWidth || 384, 1);
  let cssHeight = Math.max(canvas.clientHeight || 88, 1);
  let phase = 0;
  let rawTime = 0;
  let lastTimestamp = 0;
  let rafId = 0;
  let destroyed = false;

  const mediaQuery =
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)")
      : null;
  let reducedMotion = mediaQuery?.matches ?? false;

  const syncSize = (): boolean => {
    const rect = canvas.getBoundingClientRect();
    const nextCssWidth = rect.width > 0 ? rect.width : canvas.clientWidth || 384;
    const nextCssHeight = rect.height > 0 ? rect.height : canvas.clientHeight || 88;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const nextPixelWidth = Math.max(1, Math.round(nextCssWidth * dpr));
    const nextPixelHeight = Math.max(1, Math.round(nextCssHeight * dpr));
    cssWidth = Math.max(nextCssWidth, 1);
    cssHeight = Math.max(nextCssHeight, 1);
    if (canvas.width !== nextPixelWidth || canvas.height !== nextPixelHeight) {
      canvas.width = nextPixelWidth;
      canvas.height = nextPixelHeight;
      return true;
    }
    return false;
  };

  syncSize();

  const gl = canvas.getContext("webgl", {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    powerPreference: "low-power",
    preserveDrawingBuffer: true,
  });

  let glProgram: WebGLProgram | null = null;
  let glVertexShader: WebGLShader | null = null;
  let glFragmentShader: WebGLShader | null = null;
  let glBuffer: WebGLBuffer | null = null;
  let glContextLost = gl ? gl.isContextLost() : false;
  let uResolution: WebGLUniformLocation | null = null;
  let uTime: WebGLUniformLocation | null = null;
  let uRawTime: WebGLUniformLocation | null = null;
  let uTier: WebGLUniformLocation | null = null;
  let uProgress: WebGLUniformLocation | null = null;
  let uThumb: WebGLUniformLocation | null = null;
  let uDrag: WebGLUniformLocation | null = null;
  let uSurge: WebGLUniformLocation | null = null;

  const initWebGL = () => {
    if (!gl || gl.isContextLost()) return;
    glProgram = null;
    glVertexShader = null;
    glFragmentShader = null;
    glBuffer = null;
    uResolution = null;
    uTime = null;
    uRawTime = null;
    uTier = null;
    uProgress = null;
    uThumb = null;
    uDrag = null;
    uSurge = null;

    glVertexShader = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER_SOURCE);
    glFragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER_SOURCE);
    if (glVertexShader && glFragmentShader) {
      const program = gl.createProgram();
      if (program) {
        gl.attachShader(program, glVertexShader);
        gl.attachShader(program, glFragmentShader);
        gl.linkProgram(program);
        if (gl.getProgramParameter(program, gl.LINK_STATUS)) {
          const buffer = gl.createBuffer();
          const aPosition = gl.getAttribLocation(program, "a_position");
          if (buffer && aPosition >= 0) {
            gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
            gl.bufferData(
              gl.ARRAY_BUFFER,
              new Float32Array([-1, -1, 3, -1, -1, 3]),
              gl.STATIC_DRAW,
            );
            gl.useProgram(program);
            gl.enableVertexAttribArray(aPosition);
            gl.vertexAttribPointer(aPosition, 2, gl.FLOAT, false, 0, 0);

            uResolution = gl.getUniformLocation(program, "u_resolution");
            uTime = gl.getUniformLocation(program, "u_time");
            uRawTime = gl.getUniformLocation(program, "u_rawTime");
            uTier = gl.getUniformLocation(program, "u_tier");
            uProgress = gl.getUniformLocation(program, "u_progress");
            uThumb = gl.getUniformLocation(program, "u_thumb");
            uDrag = gl.getUniformLocation(program, "u_drag");
            uSurge = gl.getUniformLocation(program, "u_surge");

            glProgram = program;
            glBuffer = buffer;
          } else {
            if (buffer) gl.deleteBuffer(buffer);
            gl.deleteProgram(program);
          }
        } else {
          gl.deleteProgram(program);
        }
      }
    }
    if (!glProgram) {
      if (glVertexShader) {
        gl.deleteShader(glVertexShader);
        glVertexShader = null;
      }
      if (glFragmentShader) {
        gl.deleteShader(glFragmentShader);
        glFragmentShader = null;
      }
    }
  };

  if (gl) {
    initWebGL();
  }

  const ctx2d = !glProgram ? canvas.getContext("2d", { alpha: false }) : null;

  const renderFrame = () => {
    if (!initialized) return;
    const thumbX = cssWidth > 24 ? (12 + currentThumbFraction * (cssWidth - 24)) / cssWidth : 0.5;
    const trackCenterPx = targetState.hasLockedNote ? 54 : 30;
    const thumbYTop = trackCenterPx / Math.max(cssHeight, 1);
    const thumbYGl = 1.0 - thumbYTop;

    if (gl && glProgram && !glContextLost) {
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.useProgram(glProgram);
      if (uResolution) gl.uniform2f(uResolution, canvas.width, canvas.height);
      if (uTime) gl.uniform1f(uTime, phase);
      if (uRawTime) gl.uniform1f(uRawTime, rawTime);
      if (uTier) gl.uniform1f(uTier, currentTier);
      if (uProgress) gl.uniform1f(uProgress, currentProgress);
      if (uThumb) gl.uniform2f(uThumb, thumbX, thumbYGl);
      if (uDrag) gl.uniform1f(uDrag, currentDrag);
      if (uSurge) gl.uniform1f(uSurge, currentSurge);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      return;
    }

    if (ctx2d) {
      drawCosmicFallback2D(
        ctx2d,
        canvas.width,
        canvas.height,
        phase,
        rawTime,
        currentTier,
        currentProgress,
        thumbX,
        thumbYTop,
        currentDrag,
        currentSurge,
      );
    }
  };

  const snapStateToTarget = () => {
    currentTier = targetState.tier;
    currentProgress = targetState.progress;
    currentThumbFraction = targetState.thumbFraction;
    currentDrag = targetState.dragging ? 1 : 0;
    currentSurge = 0;
  };

  const scheduleNextFrame = () => {
    if (
      !initialized ||
      destroyed ||
      reducedMotion ||
      document.hidden ||
      glContextLost ||
      rafId !== 0
    ) {
      return;
    }
    rafId = window.requestAnimationFrame(tick);
  };

  const cancelScheduledFrame = () => {
    if (rafId !== 0) {
      window.cancelAnimationFrame(rafId);
      rafId = 0;
    }
  };

  const tick = (timestamp: number) => {
    rafId = 0;
    if (!initialized || destroyed || reducedMotion || document.hidden) return;
    const dt = lastTimestamp > 0 ? Math.min((timestamp - lastTimestamp) / 1000, 0.05) : 1 / 60;
    lastTimestamp = timestamp;

    const tierRate = targetState.dragging ? 20 : 4.2;
    const posRate = targetState.dragging ? 24 : 7.0;
    const tierAlpha = 1 - Math.exp(-dt * tierRate);
    const posAlpha = 1 - Math.exp(-dt * posRate);
    currentTier = lerp(currentTier, targetState.tier, tierAlpha);
    currentProgress = lerp(currentProgress, targetState.progress, posAlpha);
    currentThumbFraction = lerp(currentThumbFraction, targetState.thumbFraction, posAlpha);
    currentDrag = lerp(currentDrag, targetState.dragging ? 1 : 0, 1 - Math.exp(-dt * 14));

    const travelEnergy = Math.min(
      1,
      Math.abs(targetState.thumbFraction - currentThumbFraction) * 2.6 +
        Math.abs(targetState.tier - currentTier) * 0.45,
    );
    currentSurge = lerp(currentSurge, travelEnergy, 1 - Math.exp(-dt * 12));

    const speed = 0.25 + currentTier * 0.28 + currentDrag * 0.22 + currentSurge * 0.95;
    phase += dt * speed;
    rawTime += dt;

    syncSize();
    renderFrame();
    scheduleNextFrame();
  };

  const handleVisibilityChange = () => {
    if (document.hidden) {
      cancelScheduledFrame();
      lastTimestamp = 0;
    } else if (!reducedMotion) {
      lastTimestamp = 0;
      scheduleNextFrame();
    }
  };

  const handleMotionChange = () => {
    reducedMotion = mediaQuery?.matches ?? false;
    if (reducedMotion) {
      cancelScheduledFrame();
      snapStateToTarget();
      renderFrame();
    } else {
      lastTimestamp = 0;
      scheduleNextFrame();
    }
  };

  const handleContextLost = (event: Event) => {
    event.preventDefault();
    glContextLost = true;
    cancelScheduledFrame();
  };

  const handleContextRestored = () => {
    glContextLost = false;
    initWebGL();
    if (initialized) {
      renderFrame();
      if (!reducedMotion && !document.hidden) {
        scheduleNextFrame();
      }
    }
  };

  const stopObservingResize = observeResize(canvas, () => {
    if (syncSize() && (reducedMotion || rafId === 0)) {
      renderFrame();
    }
  });
  if (gl) {
    canvas.addEventListener("webglcontextlost", handleContextLost);
    canvas.addEventListener("webglcontextrestored", handleContextRestored);
  }
  document.addEventListener("visibilitychange", handleVisibilityChange);
  mediaQuery?.addEventListener("change", handleMotionChange);

  if (initialized) {
    if (reducedMotion) {
      snapStateToTarget();
      renderFrame();
    } else {
      renderFrame();
      scheduleNextFrame();
    }
  }

  return {
    update(next) {
      targetState = next;
      if (!initialized) {
        initialized = true;
        snapStateToTarget();
        syncSize();
        renderFrame();
        if (!reducedMotion && !document.hidden) {
          scheduleNextFrame();
        }
        return;
      }
      if (reducedMotion) {
        snapStateToTarget();
        syncSize();
        renderFrame();
      } else if (rafId === 0 && !document.hidden) {
        scheduleNextFrame();
      }
    },
    destroy() {
      destroyed = true;
      cancelScheduledFrame();
      stopObservingResize();
      if (gl) {
        canvas.removeEventListener("webglcontextlost", handleContextLost);
        canvas.removeEventListener("webglcontextrestored", handleContextRestored);
        if (!gl.isContextLost()) {
          if (glBuffer) gl.deleteBuffer(glBuffer);
          if (glProgram) gl.deleteProgram(glProgram);
          if (glVertexShader) gl.deleteShader(glVertexShader);
          if (glFragmentShader) gl.deleteShader(glFragmentShader);
        }
      }
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      mediaQuery?.removeEventListener("change", handleMotionChange);
    },
  };
}
