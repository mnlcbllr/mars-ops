import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { Line2 } from "three/addons/lines/Line2.js";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { errorText } from "@/lib/api";
import { drawMarker, type Marker } from "@/lib/markers";
import { buildTerrainMesh } from "@/lib/terrainMesh";
import { INK_DARK, INK_LIGHT, MAP_BACKGROUND, WARNING } from "@/lib/theme";
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
  /** Latest replanned route; replaces the original legs while present. */
  revisedLegs?: PlannedLeg[];
  /** How many legs of the displayed route the crew has already walked. */
  completedLegs?: number;
  /** Simulated crew position on the lattice, when a simulation is running. */
  position?: LocalPoint | null;
  /** Candidate corridor the user is about to block, drawn as a ring. */
  blockPreview?: { center: LocalPoint; radius_m: number } | null;
  /** Terrain-derived ground-level preview at a selected destination (clearly labeled in UI). */
  pov?: { point: LocalPoint; label: string } | null;
  selectedLeg: number | null;
  inspected: PointInspection | null;
  /** Hide the inspection reticle, e.g. while the right-click placement menu is open. */
  hideInspected?: boolean;
  placing: boolean;
  /** Changing this value puts the camera back to its starting view. */
  resetSignal: number;
  onPick: (point: LocalPoint) => void;
  onContextPick?: (point: LocalPoint | null) => void;
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
  const { markers, legs, revisedLegs, completedLegs = 0, position, blockPreview, pov, selectedLeg, inspected, hideInspected, placing, resetSignal, onPick, onMesh } = props;
  const hostRef = useRef<HTMLDivElement>(null);
  const compassRef = useRef<HTMLDivElement>(null);
  const stage = useRef<Stage | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [viewportHeight, setViewportHeight] = useState(0);
  const callbacks = useRef({ onPick, onMesh, onContextPick: props.onContextPick });
  callbacks.current = { onPick, onMesh, onContextPick: props.onContextPick };

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
    // Reserve right click for placement; Shift + left drag still pans.
    controls.mouseButtons.RIGHT = null;

    const frame = new THREE.Group();
    const overlay = new THREE.Group();
    frame.add(overlay);
    scene.add(frame);

    let pending = 0;
    const renderNow = () => {
      renderer.render(scene, camera);
      // North is −z. With the camera due south (azimuth 0) north points up.
      if (compassRef.current) {
        compassRef.current.style.transform = `rotate(${THREE.MathUtils.radToDeg(controls.getAzimuthalAngle())}deg)`;
      }
    };
    const invalidate = () => {
      if (pending) return;
      pending = requestAnimationFrame(() => {
        pending = 0;
        renderNow();
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
      // Draw in the same tick: setSize clears the WebGL buffer, and a deferred
      // rAF redraw would let one blank frame reach the screen (visible blink).
      renderNow();
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
    const surfacePoint = (event: MouseEvent): LocalPoint | null => {
      const current = stage.current;
      if (!current?.mesh) return null;
      const rect = renderer.domElement.getBoundingClientRect();
      const pointer = new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        1 - ((event.clientY - rect.top) / rect.height) * 2,
      );
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObject(current.mesh, false)[0];
      if (!hit) return null;
      const local = current.frame.worldToLocal(hit.point.clone());
      return { x_m: local.x, y_m: -local.z };
    };
    const onUp = (event: PointerEvent) => {
      const start = pressed;
      pressed = null;
      if (!start || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4) return;
      const point = surfacePoint(event);
      if (point) callbacks.current.onPick(point);
    };
    const onContext = (event: MouseEvent) => {
      callbacks.current.onContextPick?.(surfacePoint(event));
    };
    renderer.domElement.addEventListener("pointerdown", onDown);
    renderer.domElement.addEventListener("pointerup", onUp);
    renderer.domElement.addEventListener("contextmenu", onContext);

    stage.current = { renderer, camera, controls, frame, overlay, mesh: null, material: null, reference: 0, invalidate };
    return () => {
      stage.current = null;
      observer.disconnect();
      cancelAnimationFrame(pending);
      renderer.domElement.removeEventListener("pointerdown", onDown);
      renderer.domElement.removeEventListener("pointerup", onUp);
      renderer.domElement.removeEventListener("contextmenu", onContext);
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

  const surfaceZ = (x_m: number, y_m: number): number | null => {
    const col = Math.floor(x_m / dx);
    const row = height - 1 - Math.floor(y_m / dy);
    if (col < 0 || col >= width || row < 0 || row >= height) return null;
    const value = elevation[row * width + col]!;
    return Number.isNaN(value) ? null : value;
  };

  // Starting view: from the south, looking north, about 35° above the horizon.
  useEffect(() => {
    const s = stage.current;
    if (!s || pov) return;
    const reach = Math.max(extentX, extentY);
    s.camera.position.set(0, reach * 0.75, reach * 1.05);
    s.controls.target.set(0, 0, 0);
    s.controls.update();
    s.invalidate();
  }, [resetSignal, extentX, extentY, pov]);

  // Destination POV: terrain-derived ground-level preview (not a real photo).
  // Camera/target live in world space, where the mesh sits (elevation − reference)
  // metres above the origin, so the offset must be added back.
  useEffect(() => {
    const s = stage.current;
    if (!s || !pov) return;
    const z = surfaceZ(pov.point.x_m, pov.point.y_m);
    if (z === null) return;
    const eye = 1.7; // modeled observer eye height, metres above DTM surface
    const look = 12; // metres ahead (north) — short, so the ground stays close and readable
    const px = pov.point.x_m;
    const py = pov.point.y_m;
    const groundY = (z - s.reference) * exaggeration;
    s.camera.position.set(px, groundY + eye * exaggeration, -py);
    s.controls.target.set(px, groundY + eye * 0.7 * exaggeration, -(py + look));
    s.controls.update();
    s.invalidate();
  }, [pov, elevation, width, height, dx, dy, exaggeration]);

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

    // One route on the map: the plan in effect right now (a replanned route
    // replaces the original instead of fighting it). The path still to follow
    // is dashed white; the walked part is a faint solid trail behind it.
    const route = revisedLegs && revisedLegs.length > 0 ? revisedLegs : legs;
    route.forEach((leg, index) => {
      if (leg.path.length < 2) return;
      const positions = leg.path.flatMap((p, i) => [p.x_m, leg.elevation_m[i]! + OVERLAY_LIFT_M, -p.y_m]);
      const geometry = new LineGeometry();
      geometry.setPositions(positions);
      const walked = index < completedLegs;
      const selected = index === selectedLeg && !walked;
      const dashed = !walked && !selected;
      const material = new LineMaterial({
        color: INK_LIGHT,
        linewidth: selected ? 6 : walked ? 2.5 : 4,
        dashed,
        dashSize: 10,
        gapSize: 8,
        transparent: walked,
        opacity: walked ? 0.35 : 1,
      });
      const line = new Line2(geometry, material);
      if (dashed) line.computeLineDistances();
      line.renderOrder = walked ? 1 : 2;
      s.overlay.add(line);
    });

    // Corridor preview: a ring on the surface at the declared radius.
    if (blockPreview) {
      const ring: number[] = [];
      const segments = 72;
      for (let i = 0; i <= segments; i++) {
        const angle = (i / segments) * 2 * Math.PI;
        const x = blockPreview.center.x_m + Math.cos(angle) * blockPreview.radius_m;
        const y = blockPreview.center.y_m + Math.sin(angle) * blockPreview.radius_m;
        const z = surface(x, y);
        if (z === null) continue;
        ring.push(x, z + OVERLAY_LIFT_M + 1, -y);
      }
      if (ring.length >= 6) {
        const geometry = new LineGeometry();
        geometry.setPositions(ring);
        const material = new LineMaterial({ color: WARNING, linewidth: 3 });
        const line = new Line2(geometry, material);
        line.renderOrder = 4;
        s.overlay.add(line);
      }
    }

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

    if (position) {
      const z = surface(position.x_m, position.y_m);
      if (z !== null) {
        const [canvas, ctx] = canvas2x(36, 36);
        ctx.beginPath();
        ctx.arc(18, 18, 12, 0, 2 * Math.PI);
        ctx.fillStyle = INK_DARK;
        ctx.fill();
        ctx.beginPath();
        ctx.arc(18, 18, 10, 0, 2 * Math.PI);
        ctx.fillStyle = WARNING;
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(18, 11);
        ctx.lineTo(24, 24);
        ctx.lineTo(12, 24);
        ctx.closePath();
        ctx.fillStyle = INK_DARK;
        ctx.fill();
        sprite(canvas, 18, position.x_m, position.y_m, z);
      }
    }

    if (inspected?.elevation_m != null && !hideInspected) {
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
  }, [legs, revisedLegs, position, blockPreview, markers, selectedLeg, inspected, hideInspected, elevation, width, height, dx, dy, viewportHeight, exaggeration]);

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
