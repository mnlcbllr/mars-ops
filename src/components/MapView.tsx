import { useCallback, useEffect, useRef, useState } from "react";
import { Maximize, Minus, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { drawMarker, type Marker } from "@/lib/markers";
import { INK_DARK, INK_LIGHT, MAP_BACKGROUND, ROUTE } from "@/lib/theme";
import type { LocalPoint, PlannedLeg } from "@/lib/types";
import { fitView, scaleBar, toLocal, toScreen, zoomAt, type Size, type View } from "@/lib/view2d";
import { fmt } from "@/lib/format";

interface MapViewProps {
  /** Ground size of the region, metres. */
  extent: Size;
  /** Base layer image covering the whole region. */
  base: HTMLCanvasElement;
  /** Slope-limit / unknown overlay covering the whole region, if shown. */
  hazard: HTMLCanvasElement | null;
  markers: Marker[];
  legs: PlannedLeg[];
  selectedLeg: number | null;
  inspected: LocalPoint | null;
  placingBase: boolean;
  onPick: (point: LocalPoint) => void;
  onSelectLeg: (index: number | null) => void;
}

const FIT_PADDING = 28;
/** Screen pixels per metre at the closest zoom: one DTM cell is about 8 px. */
const MAX_SCALE = 8;
const CLICK_SLOP_PX = 4;
const LEG_HIT_PX = 8;

function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const [dx, dy] = [bx - ax, by - ay];
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0 ? 0 : Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / lengthSq));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** North-up 2D map: pan, zoom, click to inspect. */
export function MapView(props: MapViewProps) {
  const { extent, base, hazard, markers, legs, selectedLeg, inspected, placingBase, onPick, onSelectLeg } = props;
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  const [view, setView] = useState<View | null>(null);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ x: number; y: number; view: View; moved: boolean } | null>(null);

  const fitted = size.width > 0 && size.height > 0 ? fitView(extent, size, FIT_PADDING) : null;
  const minScale = fitted ? fitted.scale * 0.5 : 0.01;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const observer = new ResizeObserver(() => setSize({ width: host.clientWidth, height: host.clientHeight }));
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  // First layout: show the whole region.
  useEffect(() => {
    if (!view && fitted) setView(fitted);
  }, [view, fitted]);

  const zoomBy = useCallback(
    (factor: number, sx = size.width / 2, sy = size.height / 2) =>
      setView((v) => (v ? zoomAt(v, size, sx, sy, factor, minScale, MAX_SCALE) : v)),
    [size, minScale],
  );

  // Wheel zoom needs a non-passive listener to stop the page from scrolling.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = host.getBoundingClientRect();
      zoomBy(Math.exp(-event.deltaY * 0.0015), event.clientX - rect.left, event.clientY - rect.top);
    };
    host.addEventListener("wheel", onWheel, { passive: false });
    return () => host.removeEventListener("wheel", onWheel);
  }, [zoomBy]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !view || size.width === 0) return;
    const dpr = window.devicePixelRatio || 1;
    const [pw, ph] = [Math.round(size.width * dpr), Math.round(size.height * dpr)];
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = MAP_BACKGROUND;
    ctx.fillRect(0, 0, size.width, size.height);

    const [x0, y0] = toScreen(view, size, 0, extent.height);
    const [w, h] = [extent.width * view.scale, extent.height * view.scale];
    // Magnified source pixels stay sharp; smoothing is only for shrinking.
    ctx.imageSmoothingQuality = "high";
    ctx.imageSmoothingEnabled = w * dpr < base.width;
    ctx.drawImage(base, x0, y0, w, h);
    if (hazard) {
      ctx.imageSmoothingEnabled = w * dpr < hazard.width;
      ctx.drawImage(hazard, x0, y0, w, h);
    }
    ctx.strokeStyle = "rgba(240, 239, 236, 0.35)";
    ctx.lineWidth = 1;
    ctx.strokeRect(x0 - 0.5, y0 - 0.5, w + 1, h + 1);

    const trace = (leg: PlannedLeg) => {
      ctx.beginPath();
      leg.path.forEach((p, i) => {
        const [sx, sy] = toScreen(view, size, p.x_m, p.y_m);
        if (i === 0) ctx.moveTo(sx, sy);
        else ctx.lineTo(sx, sy);
      });
    };
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    // Casings first, so one leg's outline never covers another leg's line.
    legs.forEach((leg, i) => {
      trace(leg);
      ctx.strokeStyle = i === selectedLeg ? INK_LIGHT : INK_DARK;
      ctx.lineWidth = i === selectedLeg ? 8 : 6;
      ctx.stroke();
    });
    legs.forEach((leg, i) => {
      trace(leg);
      ctx.strokeStyle = ROUTE;
      ctx.lineWidth = i === selectedLeg ? 4 : 3;
      ctx.stroke();
    });
    // One arrowhead per leg, at its midpoint, pointing the way of travel.
    for (const leg of legs) {
      const points = leg.path.map((p) => toScreen(view, size, p.x_m, p.y_m));
      const lengths = points.slice(1).map((p, i) => Math.hypot(p[0] - points[i]![0], p[1] - points[i]![1]));
      const total = lengths.reduce((a, b) => a + b, 0);
      if (total < 40) continue;
      let walked = 0;
      for (let i = 0; i < lengths.length; i++) {
        if (walked + lengths[i]! >= total / 2 && lengths[i]! > 0) {
          const [a, b] = [points[i]!, points[i + 1]!];
          const angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
          ctx.save();
          ctx.translate((a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
          ctx.rotate(angle);
          ctx.beginPath();
          ctx.moveTo(7, 0);
          ctx.lineTo(-5, -6);
          ctx.lineTo(-5, 6);
          ctx.closePath();
          ctx.fillStyle = INK_LIGHT;
          ctx.strokeStyle = INK_DARK;
          ctx.lineWidth = 1.5;
          ctx.fill();
          ctx.stroke();
          ctx.restore();
          break;
        }
        walked += lengths[i]!;
      }
    }

    for (const marker of markers) {
      const [sx, sy] = toScreen(view, size, marker.x_m, marker.y_m);
      drawMarker(ctx, marker, sx, sy);
    }

    if (inspected) {
      const [sx, sy] = toScreen(view, size, inspected.x_m, inspected.y_m);
      for (const [color, width] of [[INK_DARK, 4], [INK_LIGHT, 1.5]] as const) {
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.beginPath();
        ctx.arc(sx, sy, 7, 0, 2 * Math.PI);
        ctx.moveTo(sx - 13, sy);
        ctx.lineTo(sx - 4, sy);
        ctx.moveTo(sx + 4, sy);
        ctx.lineTo(sx + 13, sy);
        ctx.moveTo(sx, sy - 13);
        ctx.lineTo(sx, sy - 4);
        ctx.moveTo(sx, sy + 4);
        ctx.lineTo(sx, sy + 13);
        ctx.stroke();
      }
    }
  }, [view, size, extent, base, hazard, markers, legs, selectedLeg, inspected]);

  const legAt = (sx: number, sy: number): number | null => {
    if (!view) return null;
    let best: { index: number; distance: number } | null = null;
    legs.forEach((leg, index) => {
      for (let i = 1; i < leg.path.length; i++) {
        const [ax, ay] = toScreen(view, size, leg.path[i - 1]!.x_m, leg.path[i - 1]!.y_m);
        const [bx, by] = toScreen(view, size, leg.path[i]!.x_m, leg.path[i]!.y_m);
        const distance = distanceToSegment(sx, sy, ax, ay, bx, by);
        if (distance <= LEG_HIT_PX && (!best || distance < best.distance)) best = { index, distance };
      }
    });
    return best ? (best as { index: number }).index : null;
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !view) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, y: event.clientY, view, moved: false };
    setDragging(true);
  };
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const [dx, dy] = [event.clientX - d.x, event.clientY - d.y];
    if (!d.moved && Math.hypot(dx, dy) < CLICK_SLOP_PX) return;
    d.moved = true;
    setView({ ...d.view, cx: d.view.cx - dx / d.view.scale, cy: d.view.cy + dy / d.view.scale });
  };
  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    setDragging(false);
    if (!d || d.moved || !view) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const [sx, sy] = [event.clientX - rect.left, event.clientY - rect.top];
    const [x_m, y_m] = toLocal(view, size, sx, sy);
    if (!placingBase) onSelectLeg(legAt(sx, sy));
    onPick({ x_m, y_m });
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const pan = (dx: number, dy: number) =>
      setView((v) => (v ? { ...v, cx: v.cx + dx / v.scale, cy: v.cy + dy / v.scale } : v));
    const actions: Record<string, () => void> = {
      ArrowLeft: () => pan(-80, 0),
      ArrowRight: () => pan(80, 0),
      ArrowUp: () => pan(0, 80),
      ArrowDown: () => pan(0, -80),
      "+": () => zoomBy(1.5),
      "=": () => zoomBy(1.5),
      "-": () => zoomBy(1 / 1.5),
      "0": () => fitted && setView(fitted),
    };
    const action = actions[event.key];
    if (action) {
      event.preventDefault();
      action();
    }
  };

  const bar = view ? scaleBar(view.scale, 140) : null;

  return (
    <div
      ref={hostRef}
      tabIndex={0}
      role="application"
      aria-label="Map of the region. Arrow keys pan, plus and minus zoom, zero shows the whole region."
      className={`absolute inset-0 touch-none outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset ${
        placingBase ? "cursor-crosshair" : dragging ? "cursor-grabbing" : "cursor-grab"
      }`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => {
        drag.current = null;
        setDragging(false);
      }}
      onKeyDown={onKeyDown}
    >
      <canvas ref={canvasRef} className="block size-full" />

      <div
        className="absolute top-3 right-3 flex flex-col gap-1"
        onPointerDown={(event) => event.stopPropagation()}
        onPointerUp={(event) => event.stopPropagation()}
      >
        <Button variant="secondary" size="icon-sm" aria-label="Zoom in" title="Zoom in (+)" onClick={() => zoomBy(1.5)}>
          <Plus />
        </Button>
        <Button variant="secondary" size="icon-sm" aria-label="Zoom out" title="Zoom out (−)" onClick={() => zoomBy(1 / 1.5)}>
          <Minus />
        </Button>
        <Button
          variant="secondary"
          size="icon-sm"
          aria-label="Show the whole region"
          title="Show the whole region (0)"
          onClick={() => fitted && setView(fitted)}
        >
          <Maximize />
        </Button>
      </div>

      {bar && (
        <div className="pointer-events-none absolute right-3 bottom-3 flex items-end gap-3 text-xs font-medium text-foreground">
          <div className="flex flex-col items-center rounded-md bg-background/80 px-2 py-1 backdrop-blur-sm">
            <span>{fmt(bar.metres)} m</span>
            <div className="mt-0.5 h-1.5 border-x-2 border-b-2 border-foreground" style={{ width: bar.px }} />
          </div>
          <div
            className="flex flex-col items-center rounded-md bg-background/80 px-1.5 py-1 leading-none backdrop-blur-sm"
            aria-label="North is up"
          >
            <svg width="12" height="16" viewBox="0 0 12 16" aria-hidden="true">
              <path d="M6 0 L11 13 L6 10 L1 13 Z" fill="currentColor" />
            </svg>
            <span className="mt-0.5">N</span>
          </div>
        </div>
      )}
    </div>
  );
}
