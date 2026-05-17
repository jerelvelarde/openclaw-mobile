// Minimal design tokens. The real theme (light/dark, system colors, font
// scales, etc.) lands alongside the per-feature plans; for P02A we ship a
// small constant palette so screens have something to import without
// hard-coding strings inline.

export const colors = {
  bg: '#0b0b0c',
  surface: '#141416',
  text: '#f2f2f3',
  muted: '#8a8a90',
  accent: '#5b8def',
  danger: '#e0524b',
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
} as const;

export const radius = {
  sm: 4,
  md: 8,
  lg: 16,
  pill: 999,
} as const;

export const fontSize = {
  xs: 12,
  sm: 14,
  md: 16,
  lg: 20,
  xl: 28,
} as const;

export type Tokens = {
  colors: typeof colors;
  spacing: typeof spacing;
  radius: typeof radius;
  fontSize: typeof fontSize;
};

export const tokens: Tokens = { colors, spacing, radius, fontSize };
