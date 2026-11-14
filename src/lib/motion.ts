/**
 * Shared motion timing/easing for MARS-OPS UI and 3D transitions.
 * Durations are guidelines (ms). Respect prefers-reduced-motion.
 */

export const DURATION = {
  control: 140,
  panel: 240,
  insight: 280,
  routeDraw: 700,
  destination: 1200,
  overview: 1400,
  number: 320,
} as const;

export const EASE = {
  standard: "cubic-bezier(0.2, 0, 0, 1)",
  emphasized: "cubic-bezier(0.2, 0, 0, 1.2)",
  out: "cubic-bezier(0, 0, 0, 1)",
  inOut: "cubic-bezier(0.4, 0, 0.2, 1)",
} as const;

export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function motionMs(ms: number): number {
  return prefersReducedMotion() ? 0 : ms;
}

export function clamp01(t: number): number {
  return Math.min(1, Math.max(0, t));
}

export function easeInOutCubic(t: number): number {
  const x = clamp01(t);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

export function easeOutCubic(t: number): number {
  const x = clamp01(t);
  return 1 - Math.pow(1 - x, 3);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
