import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { Line2 } from "three/addons/lines/Line2.js";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { ArrowRight, Crosshair, Globe2, Minus, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import atlasUrl from "@/assets/mars-trek-moc-atlas.jpg";
import { globePatchGrid, globePoint, isInsideGlobePatch, localGlobePoint, patchCameraAltitude, ROUTE_LIFT_M } from "@/lib/marsGlobe";
import type { Marker } from "@/lib/markers";
import { legTrack, LEG_PREVIEW_MS } from "@/lib/routeTour";
import { ROUTE } from "@/lib/theme";
import type { GridGeoreference, LatLon, PlannedLeg } from "@/lib/types";

const FOV = 38;
const MAX_DISTANCE = 9;
const SITE_RADIUS = 1.012;

type GlobeStage = {
  renderer: THREE.WebGLRenderer;
  patch: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  routes: THREE.Group;
  invalidate: () => void;
  overview: () => void;
  explore: () => void;
  zoom: (factor: number) => void;
  orbit: (azimuth: number, polar: number) => void;
};

interface Props {
  center: LatLon;
  geo: GridGeoreference;
  texture: HTMLCanvasElement;
  markers: Marker[];
  legs: PlannedLeg[];
  selectedLeg: number | null;
  playing: boolean;
  /** A completed solver run can focus the surface without leaving the globe. */
  focusSignal: number | undefined;
  onSelectSite: (id: string) => void;
  onOpen: (view: "2d" | "3d") => void;
}

export function MarsGlobe({ center, geo, texture, markers, legs, selectedLeg, playing, focusSignal, onSelectSite, onOpen }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const pinRef = useRef<HTMLButtonElement>(null);
  const markerRefs = useRef(new Map<string, HTMLButtonElement>());
  const cursorRef = useRef<HTMLSpanElement>(null);
  const cursor = useRef<THREE.Vector3 | null>(null);
  const stage = useRef<GlobeStage | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "fallback">("loading");
  const [detail, setDetail] = useState(false);
  const { lat_deg, lon_east_deg } = center;
  const displayed = markers.filter((marker) => marker.kind !== "unselected" && isInsideGlobePatch(geo, marker));
  const markerPoints = useRef<{ id: string; position: THREE.Vector3 }[]>([]);
  markerPoints.current = displayed.map((marker) => ({
    id: marker.id, position: new THREE.Vector3(...localGlobePoint(geo, marker, ROUTE_LIFT_M)),
  }));

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    } catch {
      setStatus("fallback");
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.domElement.className = "block size-full touch-none cursor-grab active:cursor-grabbing";
    renderer.domElement.setAttribute("aria-hidden", "true");
    host.append(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(FOV, 1, 0.01, 30);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enablePan = false;
    controls.minDistance = 1 + 200 / geo.radius_m;
    controls.maxDistance = MAX_DISTANCE;
    controls.enableZoom = false; // zoom by altitude above the surface, not distance from the planet centre

    const geometry = new THREE.SphereGeometry(1, 192, 128);
    const material = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const mars = new THREE.Mesh(geometry, material);
    scene.add(mars);

    const grid = globePatchGrid(geo);
    const patchGeometry = new THREE.BufferGeometry();
    patchGeometry.setAttribute("position", new THREE.Float32BufferAttribute(grid.positions, 3));
    patchGeometry.setAttribute("uv", new THREE.Float32BufferAttribute(grid.uvs, 2));
    patchGeometry.setIndex(grid.indices);
    const patchMaterial = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
    const patch = new THREE.Mesh(patchGeometry, patchMaterial);
    patch.visible = false;
    scene.add(patch);

    const routes = new THREE.Group();
    scene.add(routes);
    const site = new THREE.Vector3(...globePoint(lat_deg, lon_east_deg, SITE_RADIUS));
    const direction = site.clone().normalize();
    const projected = new THREE.Vector3();
    const position = new THREE.Spherical();
    let cancelled = false;
    let frame = 0;
    let aspect = 1;
    let textureReady = false;
    let detailLast = false;

    const project = (element: HTMLElement | null | undefined, point: THREE.Vector3, visible: boolean) => {
      if (!element) return;
      projected.copy(point).project(camera);
      const onScreen = Math.abs(projected.x) < 0.98 && Math.abs(projected.y) < 0.95 && Math.abs(projected.z) < 1;
      element.style.visibility = visible && onScreen ? "visible" : "hidden";
      element.style.left = `${(projected.x + 1) * 50}%`;
      element.style.top = `${(1 - projected.y) * 50}%`;
    };

    const invalidate = () => {
      if (cancelled || frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (!textureReady) return;
        const altitude = camera.position.length() - 1;
        const close = altitude <= patchCameraAltitude(geo, aspect, FOV) * 10;
        const facing = direction.dot(camera.position) > 1;
        if (close !== detailLast) {
          detailLast = close;
          setDetail(close);
        }
        const near = Math.max(0.000001, Math.min(0.05, altitude / 20));
        if (near !== camera.near) {
          camera.near = near;
          camera.updateProjectionMatrix();
        }
        controls.rotateSpeed = THREE.MathUtils.clamp(altitude * 1.8, 0.00015, 0.7);
        patch.visible = Boolean(patch.material.map);
        routes.visible = close && facing;
        renderer.render(scene, camera);
        project(pinRef.current, site, !close && facing);
        for (const marker of markerPoints.current) project(markerRefs.current.get(marker.id), marker.position, close && facing);
        if (cursor.current) project(cursorRef.current, cursor.current, close && facing);
        else if (cursorRef.current) cursorRef.current.style.visibility = "hidden";
      });
    };

    const centerAt = (distance: number) => {
      camera.position.copy(direction).multiplyScalar(distance);
      controls.update();
      invalidate();
    };
    const overview = () => {
      const halfFov = Math.atan(Math.tan(THREE.MathUtils.degToRad(FOV / 2)) * Math.min(1, aspect));
      centerAt(Math.min(MAX_DISTANCE, 1 / Math.sin(halfFov * 0.79)));
    };
    const explore = () => centerAt(1 + patchCameraAltitude(geo, aspect, FOV));
    stage.current = {
      renderer, patch, routes, invalidate, overview, explore,
      zoom: (factor) => {
        const distance = camera.position.length();
        const next = 1 + (distance - 1) * factor;
        camera.position.setLength(THREE.MathUtils.clamp(next, controls.minDistance, MAX_DISTANCE));
        controls.update();
        invalidate();
      },
      orbit: (azimuth, polar) => {
        position.setFromVector3(camera.position);
        const scale = Math.min(1, Math.max(0.0005, position.radius - 1));
        position.theta += azimuth * scale;
        position.phi = THREE.MathUtils.clamp(position.phi + polar * scale, 0.035, Math.PI - 0.035);
        camera.position.setFromSpherical(position);
        controls.update();
        invalidate();
      },
    };
    controls.addEventListener("change", invalidate);
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const pixels = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? host.clientHeight : 1);
      stage.current?.zoom(Math.exp(THREE.MathUtils.clamp(pixels * 0.002, -0.6, 0.6)));
    };
    renderer.domElement.addEventListener("wheel", onWheel, { passive: false });
    const resize = () => {
      if (!host.clientWidth || !host.clientHeight) return;
      renderer.setSize(host.clientWidth, host.clientHeight, false);
      aspect = host.clientWidth / host.clientHeight;
      camera.aspect = aspect;
      camera.updateProjectionMatrix();
      invalidate();
    };
    resize();
    overview();
    const observer = new ResizeObserver(resize);
    observer.observe(host);

    const atlas = new THREE.TextureLoader().load(atlasUrl, (loaded) => {
      if (cancelled) { loaded.dispose(); return; }
      loaded.colorSpace = THREE.SRGBColorSpace;
      loaded.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
      material.map = loaded;
      material.needsUpdate = true;
      textureReady = true;
      setStatus("ready");
      invalidate();
    }, undefined, () => {
      if (!cancelled) setStatus("fallback");
    });
    const onContextLost = () => { if (!cancelled) setStatus("fallback"); };
    renderer.domElement.addEventListener("webglcontextlost", onContextLost);

    return () => {
      cancelled = true;
      stage.current = null;
      observer.disconnect();
      cancelAnimationFrame(frame);
      renderer.domElement.removeEventListener("webglcontextlost", onContextLost);
      renderer.domElement.removeEventListener("wheel", onWheel);
      controls.dispose();
      geometry.dispose();
      material.dispose();
      patchGeometry.dispose();
      patchMaterial.dispose();
      atlas.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    };
  }, [geo, lat_deg, lon_east_deg]);

  useEffect(() => {
    const s = stage.current;
    if (!s) return;
    const map = new THREE.CanvasTexture(texture);
    map.colorSpace = THREE.SRGBColorSpace;
    map.anisotropy = Math.min(8, s.renderer.capabilities.getMaxAnisotropy());
    s.patch.material.map = map;
    s.patch.material.needsUpdate = true;
    s.invalidate();
    return () => {
      s.patch.material.map = null;
      map.dispose();
    };
  }, [geo, lat_deg, lon_east_deg, texture]);

  useEffect(() => {
    const s = stage.current;
    if (!s) return;
    const lines: Line2[] = [];
    legs.forEach((leg, index) => {
      if (leg.path.length < 2) return;
      const positions = leg.path.flatMap((p) => localGlobePoint(geo, p, ROUTE_LIFT_M));
      const geometry = new LineGeometry().setPositions(positions);
      const active = index === selectedLeg;
      const line = new Line2(geometry, new LineMaterial({
        color: active ? 0xffe3a0 : ROUTE, linewidth: active ? 5 : 3,
      }));
      line.renderOrder = active ? 2 : 1;
      s.routes.add(line);
      lines.push(line);
    });
    s.invalidate();
    return () => {
      for (const line of lines) {
        s.routes.remove(line);
        line.geometry.dispose();
        line.material.dispose();
      }
    };
  }, [geo, lat_deg, lon_east_deg, legs, selectedLeg]);

  useEffect(() => {
    stage.current?.invalidate();
  }, [markers, status]);

  useEffect(() => {
    if (focusSignal !== undefined && legs.length > 0) stage.current?.explore();
  }, [focusSignal, legs.length]);

  useEffect(() => {
    if (playing || selectedLeg !== null) stage.current?.explore();
  }, [playing, selectedLeg]);

  const activeLeg = selectedLeg === null ? undefined : legs[selectedLeg];
  useEffect(() => {
    const s = stage.current;
    if (!s || !playing || !activeLeg) return;
    const track = legTrack(activeLeg);
    const start = performance.now();
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let frame = 0;
    const draw = (now: number) => {
      const progress = reduced ? 1 : Math.min(1, (now - start) / LEG_PREVIEW_MS);
      const p = track(progress);
      if (p) cursor.current = new THREE.Vector3(...localGlobePoint(geo, p, ROUTE_LIFT_M * 2));
      s.invalidate();
      if (progress < 1) frame = requestAnimationFrame(draw);
    };
    draw(start);
    return () => {
      cancelAnimationFrame(frame);
      cursor.current = null;
      s.invalidate();
    };
  }, [geo, lat_deg, lon_east_deg, playing, activeLeg]);

  const fallback = status === "fallback";
  return <div className="absolute inset-0 isolate overflow-hidden bg-[#080b14] text-[#f3eef3]">
    <div aria-hidden="true" className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,#242133_0%,#101321_53%,#080b14_79%)]" />
    <div ref={hostRef} className="absolute inset-0" tabIndex={status === "ready" ? 0 : -1}
      aria-label="Mars globe. Drag or use the arrow keys to rotate. Scroll or use plus and minus to zoom."
      onKeyDown={(event) => {
        const turn: Record<string, [number, number]> = {
          ArrowLeft: [-0.17, 0], ArrowRight: [0.17, 0], ArrowUp: [0, -0.17], ArrowDown: [0, 0.17],
        };
        const delta = turn[event.key];
        if (delta) stage.current?.orbit(...delta);
        else if (event.key === "+" || event.key === "=") stage.current?.zoom(0.74);
        else if (event.key === "-") stage.current?.zoom(1.35);
        else if (event.key === "0") stage.current?.overview();
        else return;
        event.preventDefault();
      }} />
    {!fallback && <>
      <button ref={pinRef} type="button" onClick={() => stage.current?.explore()}
        className="invisible absolute z-10 flex -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 border-white bg-[#a53b68] p-1.5 shadow-[0_0_0_5px_#de7aa75c] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white"
        aria-label="Zoom to Jezero exploration on the globe" title="Zoom to Jezero exploration">
        <span className="size-2 rounded-full bg-[#ffde94]" />
        <span aria-hidden="true" className="pointer-events-none absolute left-[calc(100%+10px)] rounded border border-[#7c5369] bg-[#12101e] px-2 py-1 text-xs font-semibold whitespace-nowrap">Jezero Crater</span>
      </button>
      {displayed.map((marker) => {
        const base = marker.kind === "base";
        const visited = marker.kind === "visited";
        const excluded = marker.kind === "left_out";
        const active = marker.id === legs[selectedLeg ?? -1]?.to;
        const label = base ? "Base" : visited ? `Stop ${marker.glyph} · ${marker.id}` : `${marker.id}${excluded ? " · excluded" : " · candidate"}`;
        return <button type="button" key={marker.id}
          ref={(node) => { if (node) markerRefs.current.set(marker.id, node); else markerRefs.current.delete(marker.id); }}
          aria-label={label} title={label} aria-pressed={active} onClick={() => onSelectSite(marker.id)}
          className={`invisible absolute z-10 grid size-6 -translate-x-1/2 -translate-y-1/2 place-items-center border text-[11px] leading-none font-bold shadow-[0_0_0_2px_#090910cc] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white ${base ? "rounded-sm border-white bg-[#f1edf4] text-[#14121a]" : active ? "rounded-full border-white bg-[#ffe3a0] text-[#14121a]" : visited ? "rounded-full border-white bg-[#a53b68] text-white" : excluded ? "rounded-full border-dashed border-[#ffbe84] bg-[#26202b] text-[#ffbe84]" : "rounded-full border-[#d0cadc] bg-[#191623] text-[#f3eef3]"}`}>
          {base ? "B" : visited ? marker.glyph : excluded ? "×" : marker.id}
        </button>;
      })}
      <span ref={cursorRef} aria-hidden="true" className="pointer-events-none invisible absolute z-20 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[#32252d] bg-[#fff5bf] shadow-[0_0_8px_#ffe3a0]" />
    </>}
    <header className="pointer-events-none absolute top-4 left-5 z-20 max-w-[70%] rounded bg-[#080b14]/75 px-2 py-1">
      <p className="text-[10px] font-semibold tracking-[0.24em] text-[#f1b791] uppercase">{detail && !fallback ? "Globe close-up" : "Mars overview"}</p>
      <h2 className="mt-1 text-xl font-semibold">{detail && !fallback ? "Jezero exploration" : "From orbit to Jezero"}</h2>
      <p className="mt-1 text-xs text-[#c9c4d6]">{Math.abs(lat_deg).toFixed(2)}°{lat_deg < 0 ? "S" : "N"} · {lon_east_deg.toFixed(2)}°E</p>
    </header>
    {status !== "ready" && <p role="status" className="absolute inset-x-4 top-1/2 mx-auto max-w-sm -translate-y-1/2 text-center text-sm text-[#d7d3e0]">
      {fallback ? "The Mars globe is unavailable on this device. You can still open the local mission map." : "Loading Mars Trek imagery…"}
    </p>}
    {status === "ready" && <div className="absolute top-4 right-4 z-20 flex flex-col gap-1.5" aria-label="Globe controls">
      <Button type="button" size="icon-sm" variant="secondary" aria-label="Show full Mars globe" title="Show full Mars globe (0)" onClick={() => stage.current?.overview()}><Globe2 /></Button>
      <Button type="button" size="icon-sm" variant="secondary" aria-label="Zoom to Jezero exploration" title="Zoom to Jezero exploration" onClick={() => stage.current?.explore()}><Crosshair /></Button>
      <Button type="button" size="icon-sm" variant="secondary" aria-label="Zoom in" title="Zoom in (+)" onClick={() => stage.current?.zoom(0.74)}><Plus /></Button>
      <Button type="button" size="icon-sm" variant="secondary" aria-label="Zoom out" title="Zoom out (−)" onClick={() => stage.current?.zoom(1.35)}><Minus /></Button>
    </div>}
    <div className="absolute right-4 bottom-4 left-4 z-20 flex flex-wrap items-end justify-between gap-3">
      <p className="rounded bg-[#080b14]/85 px-2 py-1 text-[10px] leading-relaxed text-[#c9c4d6]">
        {detail && !fallback ? <>
          Local HiRISE layer on the Mars globe<br />
          {legs.length ? "Modeled round trip · B = base · numbers = stop order" : "Candidate stops · run the mission to draw the round trip"}
        </> : <>Colorized MOC Atlas · NASA/JPL Mars Trek<br />Select Jezero to see the mission at local scale.</>}
      </p>
      <Button type="button" variant="secondary" size="sm" onClick={() => onOpen(fallback ? "2d" : "3d")}>
        {fallback ? "Open Jezero map" : "Open local 3D terrain"} <ArrowRight aria-hidden="true" />
      </Button>
    </div>
  </div>;
}
