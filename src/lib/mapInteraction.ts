export type PlacementMode = "base" | "site";

/** Single-letter shortcuts are scoped to the focused map, never text fields. */
export function mapShortcut(event: {
  key: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean;
  repeat: boolean; isComposing: boolean; defaultPrevented: boolean;
}): PlacementMode | "cancel" | null {
  if (event.defaultPrevented || event.repeat || event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return null;
  switch (event.key.toLowerCase()) {
    case "b": return "base";
    case "c": return "site";
    case "escape": return "cancel";
    default: return null;
  }
}
