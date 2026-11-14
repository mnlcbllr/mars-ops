import type { MissionResult, PlannedLeg, ScientificSite } from "./types";

export const LEG_PREVIEW_MS = 2800;

export function routeSteps(result: MissionResult | null, sites: ScientificSite[]) {
  const visits = new Map(result?.stops.map((stop, index) => [stop.site_id, { stop, number: index + 1 }]));
  const byId = new Map(sites.map((site) => [site.id, site]));
  return (result?.legs ?? []).map((leg, index) => ({
    index, leg, site: byId.get(leg.to), visit: visits.get(leg.to),
    label: leg.to === "BASE" ? "Return to base" : byId.get(leg.to)?.name ?? leg.to,
  }));
}

/** The replay follows the existing route geometry, never a straight-line shortcut between stops. */
export function legTrack(leg: PlannedLeg) {
  const distances = [0];
  for (let i = 1; i < leg.path.length; i++) {
    const a = leg.path[i - 1]!;
    const b = leg.path[i]!;
    distances.push(distances[i - 1]! + Math.hypot(b.x_m - a.x_m, b.y_m - a.y_m));
  }
  return (progress: number) => {
    if (!leg.path.length) return null;
    const distance = Math.min(1, Math.max(0, progress)) * distances.at(-1)!;
    let lo = 0;
    let hi = leg.path.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (distances[mid]! < distance) lo = mid + 1;
      else hi = mid;
    }
    const right = lo;
    const left = Math.max(0, right - 1);
    const a = leg.path[left]!;
    const b = leg.path[right]!;
    const ea = leg.elevation_m[left];
    const eb = leg.elevation_m[right];
    if (ea === undefined || eb === undefined || !Number.isFinite(ea) || !Number.isFinite(eb)) return null;
    const span = distances[right]! - distances[left]!;
    const t = span > 0 ? (distance - distances[left]!) / span : 0;
    return { x_m: a.x_m + (b.x_m - a.x_m) * t, y_m: a.y_m + (b.y_m - a.y_m) * t, elevation_m: ea + (eb - ea) * t };
  };
}
