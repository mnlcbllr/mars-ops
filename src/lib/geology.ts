import type { LocalPoint } from "./types";

type Ring = [number, number][];
export interface GeologicUnit {
  symbol: string;
  name: string;
  color: string;
  /** Polygons in local metres, with the exterior ring first and any holes after it. */
  polygons: Ring[][];
}

export function geologyAt(units: GeologicUnit[], point: LocalPoint): GeologicUnit | undefined {
  const inside = (ring: Ring) => {
    let hit = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [x, y] = ring[i]!;
      const [px, py] = ring[j]!;
      if ((y > point.y_m) !== (py > point.y_m)
        && point.x_m < ((px - x) * (point.y_m - y)) / (py - y) + x) hit = !hit;
    }
    return hit;
  };
  return units.find((unit) => unit.polygons.some(([outer, ...holes]) => outer && inside(outer) && !holes.some(inside)));
}

export function drawGeology(ctx: CanvasRenderingContext2D, units: GeologicUnit[], dx: number, dy: number) {
  const height = ctx.canvas.height;
  ctx.save();
  ctx.lineWidth = 4;
  for (const unit of units) {
    ctx.beginPath();
    for (const polygon of unit.polygons) {
      for (const ring of polygon) {
        ring.forEach(([x, y], index) => {
          if (index === 0) ctx.moveTo(x / dx, height - y / dy);
          else ctx.lineTo(x / dx, height - y / dy);
        });
        ctx.closePath();
      }
    }
    ctx.fillStyle = unit.color;
    ctx.strokeStyle = unit.color;
    ctx.globalAlpha = 0.25;
    ctx.fill("evenodd");
    ctx.globalAlpha = 0.85;
    ctx.stroke();
  }
  ctx.restore();
}
