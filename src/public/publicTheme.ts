/**
 * The public pages' light theme (§E.6, D831): the only light surface in Nook. public.css and the
 * question renderer's `data-theme="public"` use these values; tests/workspaceUi.test.tsx checks every
 * text/background pair against WCAG AA (4.5:1) and the decorative pairs against 3:1.
 *
 * The plan's accent `#b8860b` (Nook's amber darkened) is 3.25:1 on white: enough for borders, focus
 * rings, and fills (non-text, 3:1) but not for text or a button's label, so text and filled buttons
 * use `accentText` (#8a6408, 5.4:1) — a deviation recorded as D838.
 */
export const PUBLIC_LIGHT = {
  background: "#f6f5f2",
  card: "#ffffff",
  text: "#18181b",
  muted: "#6b6b72",
  border: "#e4e4e7",
  accent: "#b8860b",
  accentText: "#8a6408",
  onAccent: "#ffffff",
  error: "#b42318"
} as const;

/** Dark (prefers-color-scheme: dark): the app's own tokens. */
export const PUBLIC_DARK = {
  background: "#09090a",
  card: "#141416",
  text: "#f2f2f3",
  muted: "#a1a1a8",
  border: "#2f2f35",
  accent: "#f6c453",
  accentText: "#f6c453",
  onAccent: "#281f0b",
  error: "#fda4af"
} as const;

/** WCAG relative luminance of a #rrggbb color. */
export function luminance(hex: string) {
  const value = hex.replace("#", "");
  const channel = (index: number) => {
    const c = Number.parseInt(value.slice(index, index + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

export function contrast(a: string, b: string) {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (high + 0.05) / (low + 0.05);
}

/**
 * A module's accent for its public page (a form's or booking type's color), made safe: a valid
 * #rrggbb that keeps 4.5:1 against white for text, else the default. Never raw CSS from the module.
 */
export function publicAccent(color: string | null | undefined): { accent: string; accentText: string } {
  if (!color || !/^#[0-9a-f]{6}$/i.test(color)) return { accent: PUBLIC_LIGHT.accent, accentText: PUBLIC_LIGHT.accentText };
  const text = contrast(color, PUBLIC_LIGHT.card) >= 4.5 ? color : PUBLIC_LIGHT.accentText;
  return { accent: contrast(color, PUBLIC_LIGHT.card) >= 3 ? color : PUBLIC_LIGHT.accent, accentText: text };
}
