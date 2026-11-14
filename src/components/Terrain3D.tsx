import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { Line2 } from "three/addons/lines/Line2.js";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { errorText } from "@/lib/api";
import { drawMarker, type Marker } from "@/lib/markers";
import { buildTerrainMesh } from "@/lib/terrainMesh";
import { INK_DARK, INK_LIGHT, MAP_BACKGROUND, ROUTE } from "@/lib/theme";
import type { LocalPoint, PlannedLeg, PointInspection } from "@/lib/types";

export interface MeshInfo {
  cols: number;
  rows: number;
  spacingX: number;
  spacingY: number;
  triangles: number;
  minElevation: number;
  maxElevation: number;
  missingVertices: number;
}

interface Terrain3DProps {
  /** Source elevation raster: row 0 = north, NaN = no data. */
  elevation: Float32Array;
  width: number;
  height: number;
  /** Ground size of one raster cell, metres. */
  dx: number;
  dy: number;
  /** Raster cells between mesh vertices. */
  step: number;
  /** Image draped on the surface; a new canvas object means new content. */
  texture: HTMLCanvasElement;
  /** Shade the surface with a synthetic light (never used on imagery). */
  lit: boolean;
  /** Vertical scale factor; 1 is true scale. */
  exaggeration: number;
  markers: Marker[];
  legs: PlannedLeg[];
  originalLegs?: PlannedLeg[];
  currentPosition?: LocalPoint | null;
  selectedLeg: number | null;
  inspected: PointInspection | null;
  placing: boolean;
  /** Changing this value puts the camera back to its starting view. */
  resetSignal: number;
  onPick: (point: LocalPoint) => void;
  onMesh: (info: MeshInfo) => void;
}

/** Route and markers are drawn this far above the surface so they stay visible. */
export const OVERLAY_LIFT_M = 1.5;
const FOV_DEG = 40;
const MARKER_CANVAS = { width: 200, height: 48, anchorX: 24 };

interface Stage {
  renderer: THREE.WebGLRenderer;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  /** The data's own frame: x east, y elevation, z = −north, all metres. */
  frame: THREE.Group;
  overlay: THREE.Group;
  mesh: THREE.Mesh | null;
  material: THREE.Material | null;
  /** Elevation shown at the scene origin, metres. */
  reference: number;
  invalidate: () => void;
}

function disposeOverlay(group: THREE.Group) {
  for (const child of [...group.children]) {
    group.remove(child);
    const object = child as THREE.Mesh | THREE.Sprite;
    // Sprites share one geometry inside three.js; only lines own theirs.
    if (!(object instanceof THREE.Sprite)) object.geometry?.dispose();
    const material = object.material as THREE.Material & { map?: THREE.Texture | null };
    material?.map?.dispose();
    material?.dispose();
  }
}

/**
 * 3D view of the same region. Every vertex height is a value of the elevation
 * raster (see `buildTerrainMesh`); nothing here generates or smooths terrain.
 */
export function Terrain3D(props: Terrain3DProps) {
  const { elevation, width, height, dx, dy, step, texture, lit, exaggeration } = props;
  const { markers, legs, selectedLeg, inspected, placing, resetSignal, onPick, onMesh } = props;
  const hostRef = useRef<HTMLDivElement>(null);
  const compassRef = useRef<HTMLDivElement>(null);
  const stage = useRef<Stage | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [viewportHeight, setViewportHeight] = useState(0);
  const callbacks = useRef({ onPick, onMesh });
  callbacks.current = { onPick, onMesh };

  const [extentX, extentY] = [width * dx, height * dy];

  // Renderer, camera and controls live as long as the component.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    } catch (error) {
      setFailure(errorText(error));
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.domElement.className = "block size-full";
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(MAP_BACKGROUND);
    scene.add(new THREE.AmbientLight(0xffffff, 1.1));
    // Synthetic light from the north-west, used only by the shaded layers.
    const sun = new THREE.DirectionalLight(0xffffff, 2.6);
    sun.position.set(-1, 1.1, -1);
    scene.add(sun);

    const camera = new THREE.PerspectiveCamera(FOV_DEG, 1, 5, 40_000);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = false;
    controls.screenSpacePanning = false;
    controls.maxPolarAngle = THREE.MathUtils.degToRad(88);
    controls.minDistance = 40;
    controls.maxDistance = 9000;

    const frame = new THREE.Group();
    const overlay = new THREE.Group();
    frame.add(overlay);
    scene.add(frame);

    let pending = 0;
    const invalidate = () => {
      if (pending) return;
      pending = requestAnimationFrame(() => {
        pending = 0;
        renderer.render(scene, camera);
        // North is −z. With the camera due south (azimuth 0) north points up.
        if (compassRef.current) {
          compassRef.current.style.transform = `rotate(${THREE.MathUtils.radToDeg(controls.getAzimuthalAngle())}deg)`;
        }
      });
    };
    controls.addEventListener("change", invalidate);

    const resize = () => {
      const [w, h] = [host.clientWidth, host.clientHeight];
      if (w === 0 || h === 0) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      setViewportHeight(h);
      invalidate();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();

    // A click (not a drag) reads the surface point under the cursor.
    const raycaster = new THREE.Raycaster();
    let pressed: { x: number; y: number } | null = null;
    const onDown = (event: PointerEvent) => {
      pressed = event.button === 0 ? { x: event.clientX, y: event.clientY } : null;
    };
    const onUp = (event: PointerEvent) => {
      const start = pressed;
      pressed = null;
      const current = stage.current;
      if (!start || !current?.mesh || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4) return;
      const rect = renderer.domElement.getBoundingClientRect();
      const pointer = new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        1 - ((event.clientY - rect.top) / rect.height) * 2,
      );
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObject(current.mesh, false)[0];
      if (!hit) return;
      const local = current.frame.worldToLocal(hit.point.clone());
      callbacks.current.onPick({ x_m: local.x, y_m: -local.z });
    };
    renderer.domElement.addEventListener("pointerdown", onDown);
    renderer.domElement.addEventListener("pointerup", onUp);

    stage.current = { renderer, camera, controls, frame, overlay, mesh: null, material: null, reference: 0, invalidate };
    return () => {
      stage.current = null;
      observer.disconnect();
      cancelAnimationFrame(pending);
      renderer.domElement.removeEventListener("pointerdown", onDown);
      renderer.domElement.removeEventListener("pointerup", onUp);
      controls.dispose();
      disposeOverlay(overlay);
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    };
  }, []);

  // Terrain mesh, straight from the raster.
  useEffect(() => {
    const s = stage.current;
    if (!s) return;
    const built = buildTerrainMesh(elevation, width, height, dx, dy, step);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(built.positions, 3));
    geometry.setAttribute("uv", new THREE.BufferAttribute(built.uvs, 2));
    geometry.setIndex(new THREE.BufferAttribute(built.indices, 1));
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, s.material ?? new THREE.MeshBasicMaterial({ color: 0x555555 }));
    s.frame.add(mesh);
    s.mesh = mesh;
    s.reference = Number.isFinite(built.minElevation) ? (built.minElevation + built.maxElevation) / 2 : 0;
    s.invalidate();
    callbacks.current.onMesh({
      cols: built.cols,
      rows: built.rows,
      spacingX: built.spacingX,
      spacingY: built.spacingY,
      triangles: built.indices.length / 3,
      minElevation: built.minElevation,
      maxElevation: built.maxElevation,
      missingVertices: built.missingVertices,
    });
    return () => {
      s.frame.remove(mesh);
      geometry.dispose();
      if (s.mesh === mesh) s.mesh = null;
    };
  }, [elevation, width, height, dx, dy, step]);

  // Surface appearance: the active map layer, draped unchanged.
  useEffect(() => {
    const s = stage.current;
    if (!s) return;
    const map = new THREE.CanvasTexture(texture);
    map.colorSpace = THREE.SRGBColorSpace;
    map.anisotropy = s.renderer.capabilities.getMaxAnisotropy();
    const material = lit ? new THREE.MeshLambertMaterial({ map }) : new THREE.MeshBasicMaterial({ map });
    // Bias the surface back in depth so lines drawn on it are not buried.
    material.polygonOffset = true;
    material.polygonOffsetFactor = 1;
    material.polygonOffsetUnits = 1;
    s.material = material;
    if (s.mesh) s.mesh.material = material;
    s.invalidate();
    return () => {
      if (s.material === material) s.material = null;
      material.dispose();
      map.dispose();
    };
  }, [texture, lit]);

  // Place the data frame: region centred on the origin, vertical scale applied.
  useEffect(() => {
    const s = stage.current;
    if (!s) return;
    s.frame.scale.set(1, exaggeration, 1);
    s.frame.position.set(-extentX / 2, -exaggeration * s.reference, extentY / 2);
    s.frame.updateMatrixWorld(true);
    s.invalidate();
  }, [exaggeration, extentX, extentY, elevation, step]);

  // Starting view: from the south, looking north, about 35° above the horizon.
  useEffect(() => {
    const s = stage.current;
    if (!s) return;
    const reach = Math.max(extentX, extentY);
    s.camera.position.set(0, reach * 0.75, reach * 1.05);
    s.controls.target.set(0, 0, 0);
    s.controls.update();
    s.invalidate();
  }, [resetSignal, extentX, extentY]);

  // Route, markers and the inspected point, at their own elevations.
  useEffect(() => {
    const s = stage.current;
    if (!s || viewportHeight === 0) return;
    disposeOverlay(s.overlay);

    const surface = (x_m: number, y_m: number): number | null => {
      const col = Math.floor(x_m / dx);
      const row = height - 1 - Math.floor(y_m / dy);
      if (col < 0 || col >= width || row < 0 || row >= height) return null;
      const value = elevation[row * width + col]!;
      return Number.isNaN(value) ? null : value;
    };

    const drawRoute = (routes: PlannedLeg[], original: boolean) => routes.forEach((leg, index) => {
      if (leg.path.length < 2) return;
      const positions = leg.path.flatMap((p, i) => [p.x_m, leg.elevation_m[i]! + OVERLAY_LIFT_M, -p.y_m]);
      const geometry = new LineGeometry();
      geometry.setPositions(positions);
      const selected = !original && index === selectedLeg;
      const material = new LineMaterial({ color: original ? 0xb0b0b0 : props.currentPosition ? 0x54d3e5 : selected ? INK_LIGHT : ROUTE,
        linewidth: original ? 2 : selected ? 6 : 4, dashed: original, dashSize: 12, gapSize: 8 });
      const line = new Line2(geometry, material);
      line.computeLineDistances();
      line.renderOrder = selected ? 2 : 1;
      s.overlay.add(line);
    });
    drawRoute(props.originalLegs ?? [], true);
    drawRoute(legs, false);

    // Constant on-screen size: a sprite's scale is a fraction of the view height.
    const pixel = (2 * Math.tan(THREE.MathUtils.degToRad(FOV_DEG / 2))) / viewportHeight;
    const sprite = (canvas: HTMLCanvasElement, anchorX: number, x_m: number, y_m: number, z_m: number) => {
      const map = new THREE.CanvasTexture(canvas);
      map.colorSpace = THREE.SRGBColorSpace;
      const material = new THREE.SpriteMaterial({ map, sizeAttenuation: false, depthTest: false, transparent: true });
      const object = new THREE.Sprite(material);
      const cssWidth = canvas.width / 2;
      const cssHeight = canvas.height / 2;
      object.center.set(anchorX / cssWidth, 0.5);
      // The frame is stretched vertically by the exaggeration; undo that for labels.
      object.scale.set(cssWidth * pixel, (cssHeight * pixel) / exaggeration, 1);
      object.position.set(x_m, z_m + OVERLAY_LIFT_M, -y_m);
      object.renderOrder = 3;
      s.overlay.add(object);
    };
    const canvas2x = (cssWidth: number, cssHeight: number) => {
      const canvas = document.createElement("canvas");
      canvas.width = cssWidth * 2;
      canvas.height = cssHeight * 2;
      const ctx = canvas.getContext("2d")!;
      ctx.scale(2, 2);
      return [canvas, ctx] as const;
    };

    for (const marker of markers) {
      const z = surface(marker.x_m, marker.y_m);
      if (z === null) continue; // no elevation here: nothing to stand the marker on
      const [canvas, ctx] = canvas2x(MARKER_CANVAS.width, MARKER_CANVAS.height);
      drawMarker(ctx, marker, MARKER_CANVAS.anchorX, MARKER_CANVAS.height / 2);
      sprite(canvas, MARKER_CANVAS.anchorX, marker.x_m, marker.y_m, z);
    }

    if (props.currentPosition) {
      const p = props.currentPosition;
      const z = surface(p.x_m, p.y_m);
      if (z !== null) {
        const [canvas, ctx] = canvas2x(160, 40);
        ctx.fillStyle = "#101319"; ctx.fillRect(3, 8, 24, 24);
        ctx.strokeStyle = "#54d3e5"; ctx.lineWidth = 3; ctx.strokeRect(3, 8, 24, 24);
        ctx.fillStyle = "#ffffff"; ctx.font = "bold 12px sans-serif";
        ctx.fillText("SIM", 5, 24); ctx.fillText("Current", 34, 24);
        sprite(canvas, 15, p.x_m, p.y_m, z);
      }
    }

    if (inspected?.elevation_m != null) {
      const [canvas, ctx] = canvas2x(32, 32);
      for (const [color, lineWidth] of [[INK_DARK, 4], [INK_LIGHT, 1.5]] as const) {
        ctx.strokeStyle = color;
        ctx.lineWidth = lineWidth;
        ctx.beginPath();
        ctx.arc(16, 16, 7, 0, 2 * Math.PI);
        ctx.moveTo(3, 16);
        ctx.lineTo(12, 16);
        ctx.moveTo(20, 16);
        ctx.lineTo(29, 16);
        ctx.moveTo(16, 3);
        ctx.lineTo(16, 12);
        ctx.moveTo(16, 20);
        ctx.lineTo(16, 29);
        ctx.stroke();
      }
      sprite(canvas, 16, inspected.local.x_m, inspected.local.y_m, inspected.elevation_m);
    }
    s.invalidate();
  }, [legs, props.originalLegs, props.currentPosition, markers, selectedLeg, inspected, elevation, width, height, dx, dy, viewportHeight, exaggeration]);

  if (failure) {
    return (
      <div className="absolute inset-0 grid place-items-center p-8 text-center text-sm text-muted-foreground">
        <p className="max-w-sm">
          The 3D view could not start because WebGL is not available on this system ({failure}).
        </p>
      </div>
    );
  }

  return (
    <div ref={hostRef} className={`absolute inset-0 ${placing ? "cursor-crosshair" : "cursor-grab"}`}>
      <div
        className="pointer-events-none absolute right-3 bottom-3 rounded-md bg-background/80 px-1.5 py-1 text-xs leading-none font-medium backdrop-blur-sm"
        aria-label="Compass: the arrow points north"
      >
        <div ref={compassRef} className="flex flex-col items-center">
          <svg width="12" height="16" viewBox="0 0 12 16" aria-hidden="true">
            <path d="M6 0 L11 13 L6 10 L1 13 Z" fill="currentColor" />
          </svg>
          <span className="mt-0.5">N</span>
        </div>
      </div>
    </div>
  );
}
