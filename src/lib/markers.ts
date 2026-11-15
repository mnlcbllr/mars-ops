// Map markers, drawn on 3D sprites.
// Each state has its own shape or line style, so none depends on colour alone.

import type { MissionResult, MissionScenario } from "./types";
import { INK_DARK, INK_LIGHT, ROUTE, WARNING } from "./theme";

export type MarkerKind =
  /** The base: a square. */
  | "base"
  /** A site in the plan: filled disc carrying its visit order. */
  | "visited"
  /** A candidate with no plan yet: ringed disc. */
  | "candidate"
  /** A candidate the plan left out: dashed ring, struck through. */
  | "left_out"
  /** The right-click target point: a crosshair reticle, transient while the menu is open. */
  | "target";

export interface Marker {
  kind: MarkerKind;
  id: string;
  x_m: number;
  y_m: number;
  /** Text inside the marker (visit order, or "B"). */
  glyph: string;
  /** Text beside the marker. */
  label: string;
}

/** Markers for the current scenario and, if there is one, its plan. */
export function markersFor(
  scenario: MissionScenario,
  result: MissionResult | null,
  completed: readonly string[] = [],
): Marker[] {
  const order = new Map(result?.stops.map((stop, i) => [stop.site_id, i + 1]));
  const done = new Set(completed);
  const sites = scenario.sites.map((site): Marker => {
    const position = { x_m: site.position.x_m, y_m: site.position.y_m };
    // Completed work wins over the remaining plan, so a finished stop never
    // still reads as a future visit.
    if (done.has(site.id)) return { kind: "visited", id: site.id, ...position, glyph: "", label: `${site.id} complete` };
    const visit = order.get(site.id);
    if (visit !== undefined) return { kind: "visited", id: site.id, ...position, glyph: String(visit), label: site.id };
    if (result?.excluded.some((e) => e.site_id === site.id)) {
      return { kind: "left_out", id: site.id, ...position, glyph: "", label: `${site.id} left out` };
    }
    return { kind: "candidate", id: site.id, ...position, glyph: "", label: site.id };
  });
  const base: Marker = { kind: "base", id: "BASE", ...scenario.base, glyph: "B", label: "Base" };
  // Draw the base and visited sites last so they sit on top.
  const rank = (m: Marker) => (m.kind === "base" ? 3 : m.kind === "visited" ? 2 : 1);
  return [...sites, base].sort((a, b) => rank(a) - rank(b));
}

/** Radius of the marker body in CSS pixels (labels start beyond it). */
export function markerRadius(kind: MarkerKind): number {
  return kind === "visited" || kind === "base" ? 11 : kind === "target" ? 10 : 9;
}

/** Draw a marker centred on (x, y). */
export function drawMarker(ctx: CanvasRenderingContext2D, marker: Marker, x: number, y: number): void {
  const r = markerRadius(marker.kind);
  ctx.save();
  ctx.lineJoin = "round";

  if (marker.kind === "target") {
    // Crosshair reticle: dark underlay keeps it readable on bright imagery.
    const inner = r * 0.45;
    for (const [color, width] of [[INK_DARK, 4.5], [INK_LIGHT, 2]] as const) {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.arc(x, y, inner, 0, 2 * Math.PI);
      ctx.moveTo(x - r - 3, y);
      ctx.lineTo(x - inner, y);
      ctx.moveTo(x + inner, y);
      ctx.lineTo(x + r + 3, y);
      ctx.moveTo(x, y - r - 3);
      ctx.lineTo(x, y - inner);
      ctx.moveTo(x, y + inner);
      ctx.lineTo(x, y + r + 3);
      ctx.stroke();
    }
    ctx.restore();
    return;
  }

  if (marker.kind === "base") {
    ctx.fillStyle = INK_DARK;
    ctx.fillRect(x - r - 2, y - r - 2, 2 * r + 4, 2 * r + 4);
    ctx.fillStyle = INK_LIGHT;
    ctx.fillRect(x - r, y - r, 2 * r, 2 * r);
  } else {
    // Dark ring keeps the marker readable on bright imagery.
    ctx.beginPath();
    ctx.arc(x, y, r + 2, 0, 2 * Math.PI);
    ctx.fillStyle = INK_DARK;
    ctx.fill();

    ctx.beginPath();
    ctx.arc(x, y, r, 0, 2 * Math.PI);
    if (marker.kind === "visited") {
      ctx.fillStyle = ROUTE;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = INK_LIGHT;
      ctx.stroke();
    } else {
      ctx.lineWidth = 2;
      ctx.strokeStyle = marker.kind === "left_out" ? WARNING : INK_LIGHT;
      if (marker.kind === "left_out") ctx.setLineDash([4, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
      if (marker.kind === "left_out") {
        ctx.beginPath();
        ctx.moveTo(x - r * 0.6, y + r * 0.6);
        ctx.lineTo(x + r * 0.6, y - r * 0.6);
        ctx.stroke();
      }
    }
  }

  if (marker.glyph) {
    ctx.font = "700 12px 'Geist Variable', system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = marker.kind === "base" ? INK_DARK : "#ffffff";
    ctx.fillText(marker.glyph, x, y + 0.5);
  }

  if (marker.label) {
    ctx.font = "600 12px 'Geist Variable', system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = INK_DARK;
    ctx.strokeText(marker.label, x + r + 6, y + 0.5);
    ctx.fillStyle = INK_LIGHT;
    ctx.fillText(marker.label, x + r + 6, y + 0.5);
  }
  ctx.restore();
}
