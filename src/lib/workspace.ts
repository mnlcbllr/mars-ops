import { isTauri } from "@tauri-apps/api/core";
import { api } from "./api";
import type { GeologicUnit } from "./geology";
import { ELEVATION_RAMP, elevationRgba, rampLut } from "./layers";
import type { DatasetInfo, MissionScenario } from "./types";

export interface Workspace {
  info: DatasetInfo;
  scenario: MissionScenario;
  elevation: Float32Array;
  slope: Float32Array;
  imagery: HTMLCanvasElement;
  heights: HTMLCanvasElement;
  geology: GeologicUnit[];
}

export function canvas(width: number, height: number) {
  const image = document.createElement("canvas");
  image.width = width;
  image.height = height;
  const context = image.getContext("2d");
  if (!context) throw new Error("The map could not start: a 2D canvas is unavailable.");
  return { image, context };
}

export function rasterImage(data: Uint8ClampedArray<ArrayBuffer>, width: number, height: number) {
  const { image, context } = canvas(width, height);
  context.putImageData(new ImageData(data, width, height), 0, 0);
  return image;
}

function raster(bytes: ArrayBuffer, width: number, height: number) {
  if (bytes.byteLength !== width * height * 4) throw new Error("The dataset raster has unexpected dimensions.");
  const values = new Float32Array(width * height);
  const view = new DataView(bytes);
  for (let i = 0; i < values.length; i++) values[i] = view.getFloat32(i * 4, true);
  return values;
}

export async function loadWorkspace(): Promise<Workspace> {
  if (!isTauri()) {
    throw new Error("Open the HYDE desktop app with bun tauri dev. Dataset access, mission planning and report export require the native runtime, not a regular browser tab.");
  }
  const datasets = await api.listDatasets();
  const dataset = datasets[0];
  if (!dataset) throw new Error("No bundled datasets found. Check the app's datasets resource directory.");
  const info = await api.openDataset(dataset.dataset_id);
  const [scenario, elevationBytes, slopeBytes, imageryBytes, geologyBytes] = await Promise.all([
    api.defaultScenario(), api.layer("elevation"), api.layer("slope"), api.layer("imagery"),
    info.manifest.layers.some((layer) => layer.kind === "GEOLOGY") ? api.layer("geology") : null,
  ]);
  const geo = info.manifest.georeference;
  const grid = info.planning_grid;
  const elevation = raster(elevationBytes, geo.width, geo.height);
  const slope = raster(slopeBytes, grid.width, grid.height);
  const heights = rasterImage(
    elevationRgba(elevation, info.elevation_min_m ?? 0, info.elevation_max_m ?? 0, rampLut(ELEVATION_RAMP)),
    geo.width, geo.height,
  );
  const source = new Image();
  const url = URL.createObjectURL(new Blob([imageryBytes], { type: "image/png" }));
  let imagery: HTMLCanvasElement;
  try {
    source.src = url;
    await source.decode();
    const target = canvas(source.naturalWidth, source.naturalHeight);
    target.context.drawImage(source, 0, 0);
    imagery = target.image;
  } finally {
    URL.revokeObjectURL(url);
  }
  const geology: GeologicUnit[] = geologyBytes
    ? JSON.parse(new TextDecoder().decode(geologyBytes)).units : [];
  return { info, scenario, elevation, slope, imagery, heights, geology };
}
