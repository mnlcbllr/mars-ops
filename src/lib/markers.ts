// Map markers, drawn the same way on the 2D canvas and on 3D sprites.
// Each state has its own shape or line style, so none depends on colour alone.

import type { MissionResult, MissionScenario } from "./types";
import { INK_DARK, INK_LIGHT, ROUTE, WARNING } from "./theme";

export type MarkerKind =
  /** The base: a square. */
  | "base"
  /** A site in the plan: filled disc carrying its visit order. */
  | "visited"
  /** A selected candidate with no plan yet: ringed disc. */
  | "candidate"
  /** A selected candidate the plan left out: dashed ring, struck through. */
  | "left_out"
  /** A candidate the user has not selected: small faint ring. */
  | "unselected";

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
  selected: ReadonlySet<string>,
  result: MissionResult | null,
): Marker[] {
  const order = new Map(result?.stops.map((stop, i) => [stop.site_id, i + 1]));
  const sites = scenario.sites.map((site): Marker => {
    const position = { x_m: site.position.x_m, y_m: site.position.y_m };
    const visit = order.get(site.id);
    if (!selected.has(site.id)) return { kind: "unselected", id: site.id, ...position, glyph: "", label: site.id };
    if (visit !== undefined) return { kind: "visited", id: site.id, ...position, glyph: String(visit), label: site.id };
    if (result?.excluded.some((e) => e.site_id === site.id)) {
      return { kind: "left_out", id: site.id, ...position, glyph: "", label: `${site.id} left out` };
    }
    return { kind: "candidate", id: site.id, ...position, glyph: "", label: site.id };
  });
  const base: Marker = { kind: "base", id: "BASE", ...scenario.base, glyph: "B", label: "Base" };
  // Draw the base and visited sites last so they sit on top.
  const rank = (m: Marker) => (m.kind === "base" ? 3 : m.kind === "visited" ? 2 : m.kind === "unselected" ? 0 : 1);
  return [...sites, base].sort((a, b) => rank(a) - rank(b));
}

/** Radius of the marker body in CSS pixels (labels start beyond it). */
export function markerRadius(kind: MarkerKind): number {
  return kind === "unselected" ? 5 : kind === "visited" || kind === "base" ? 11 : 9;
}

/** Draw a marker centred on (x, y). */
export function drawMarker(ctx: CanvasRenderingContext2D, marker: Marker, x: number, y: number): void {
  const r = markerRadius(marker.kind);
  ctx.save();
  ctx.lineJoin = "round";

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
    ctx.globalAlpha = marker.kind === "unselected" ? 0.55 : 0.9;
    ctx.fill();
    ctx.globalAlpha = 1;

    ctx.beginPath();
    ctx.arc(x, y, r, 0, 2 * Math.PI);
    if (marker.kind === "visited") {
      ctx.fillStyle = ROUTE;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = INK_LIGHT;
      ctx.stroke();
    } else {
      ctx.lineWidth = marker.kind === "unselected" ? 1.5 : 2;
      ctx.strokeStyle = marker.kind === "left_out" ? WARNING : INK_LIGHT;
      ctx.globalAlpha = marker.kind === "unselected" ? 0.7 : 1;
      if (marker.kind === "left_out") ctx.setLineDash([4, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
      if (marker.kind === "left_out") {
        ctx.beginPath();
        ctx.moveTo(x - r * 0.6, y + r * 0.6);
        ctx.lineTo(x + r * 0.6, y - r * 0.6);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
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
    ctx.globalAlpha = marker.kind === "unselected" ? 0.75 : 1;
    ctx.strokeText(marker.label, x + r + 6, y + 0.5);
    ctx.fillStyle = INK_LIGHT;
    ctx.fillText(marker.label, x + r + 6, y + 0.5);
  }
  ctx.restore();
}
