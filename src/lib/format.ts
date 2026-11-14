// Number formatting shared by every panel, so the map, the dock and the
// methods drawer never disagree on how a value is rounded.

const DASH = "—";

/** A number with thousands separators and a true minus sign; a dash if absent. */
export function fmt(value: number | null | undefined, digits = 0): string {
  if (value == null || !Number.isFinite(value)) return DASH;
  const text = Math.abs(value).toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  // Do not print "-0".
  return value < 0 && Number(text.replace(/,/g, "")) !== 0 ? `−${text}` : text;
}

export function minutes(seconds: number, digits = 0): string {
  return `${fmt(seconds / 60, digits)} min`;
}

/** Elapsed time since the start of the EVA as `T+h:mm`. */
export function clock(seconds: number): string {
  const total = Math.round(seconds / 60);
  return `T+${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function latLon(p: { lat_deg: number; lon_east_deg: number }): string {
  const lat = `${Math.abs(p.lat_deg).toFixed(5)}°${p.lat_deg < 0 ? "S" : "N"}`;
  return `${lat} ${p.lon_east_deg.toFixed(5)}°E`;
}
