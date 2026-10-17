/**
 * A surface's look as the page and the widget loader apply it (ADR-0108 rungs ① and ②; ADR-0105;
 * S1-18, issue #456). Pure, with no React at runtime.
 *
 * - {@link SURFACE_DEFAULTS} is the one source of every default: the contract leaves an unset key
 *   unset (ADR-0108), and the widget fills it here when it renders.
 * - {@link surfaceThemeStyle} is the surface root's style. It overrides the design system's own
 *   token names (`apps/web/app/globals.css`), so the existing Tailwind classes follow the theme.
 * - {@link surfaceWidgetLook} is what the server's widget loader draws its launcher and frame
 *   with. The server never imports components; the loader's route passes this function in.
 */
import type { CSSProperties } from 'react';

import type {
  SurfaceDefinition,
  SurfaceDensity,
  SurfaceLayout,
  SurfaceLocale,
  SurfaceTheme,
  SurfaceThemeMode,
  SurfaceToolTraceMode,
} from '@indx-workspace/contracts/surfaces';

import { surfaceStrings } from './locale.js';

/** What an unset key of a surface's theme, layout or parts renders as. */
export const SURFACE_DEFAULTS: {
  /** The setup question's recommended brand colour, and the design system's own `--accent`. */
  readonly colour: string;
  readonly radius: number;
  readonly mode: SurfaceThemeMode;
  readonly density: SurfaceDensity;
  readonly locale: SurfaceLocale;
  readonly layout: SurfaceLayout;
  readonly toolTrace: SurfaceToolTraceMode;
} = {
  colour: '#2f5fd0',
  radius: 8,
  mode: 'system',
  density: 'comfortable',
  locale: 'en',
  layout: 'dock',
  toolTrace: 'hidden',
};

/** A style object whose custom properties are typed, so no cast is needed to set them. */
export type SurfaceThemeStyle = CSSProperties & Record<`--${string}`, string>;

/** The text colour on a light accent: the design system's own `--text`. */
const DARK_FOREGROUND = '#1b1a18';
const LIGHT_FOREGROUND = '#ffffff';

/** The design system's palettes (`globals.css`), the subset a surface paints with. */
const PALETTES: Readonly<Record<'light' | 'dark', Readonly<Record<`--${string}`, string>>>> = {
  light: {
    '--bg': '#faf9f7',
    '--surface': '#ffffff',
    '--surface-2': '#f4f3f0',
    '--border': '#e3e0da',
    '--text': '#1b1a18',
    '--text-2': '#4a4842',
    '--muted': '#7d7a72',
  },
  dark: {
    '--bg': '#141416',
    '--surface': '#1c1c1f',
    '--surface-2': '#232327',
    '--border': '#303036',
    '--text': '#ececef',
    '--text-2': '#c2c2c8',
    '--muted': '#8e8e98',
  },
};

/** The spacing and type size each density sets. */
const DENSITIES: Readonly<Record<SurfaceDensity, Readonly<Record<`--${string}`, string>>>> = {
  compact: { '--surface-gap': '8px', '--surface-pad': '12px', '--surface-text': '13px' },
  comfortable: { '--surface-gap': '16px', '--surface-pad': '24px', '--surface-text': '14px' },
};

const HEX_COLOUR = /^#[0-9a-f]{6}$/iu;

/** WCAG 2 relative luminance of a `#rrggbb` colour. */
function relativeLuminance(hex: string): number {
  if (!HEX_COLOUR.test(hex)) throw new TypeError(`not a #rrggbb colour: ${JSON.stringify(hex)}`);
  const linear = (offset: number): number => {
    const channel = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(1) + 0.7152 * linear(3) + 0.0722 * linear(5);
}

function contrast(left: number, right: number): number {
  return (Math.max(left, right) + 0.05) / (Math.min(left, right) + 0.05);
}

/**
 * The text colour drawn on `hex`: white or the design system's near-black, whichever contrasts
 * more by WCAG relative luminance.
 */
export function surfaceAccentForeground(hex: string): string {
  const accent = relativeLuminance(hex);
  return contrast(accent, relativeLuminance(LIGHT_FOREGROUND)) >=
    contrast(accent, relativeLuminance(DARK_FOREGROUND))
    ? LIGHT_FOREGROUND
    : DARK_FOREGROUND;
}

/** The surface root's style for `theme`, with every unset key at {@link SURFACE_DEFAULTS}. */
export function surfaceThemeStyle(theme?: SurfaceTheme): SurfaceThemeStyle {
  const colour = theme?.colour ?? SURFACE_DEFAULTS.colour;
  const radius = theme?.radius ?? SURFACE_DEFAULTS.radius;
  const mode = theme?.mode ?? SURFACE_DEFAULTS.mode;
  const density = theme?.density ?? SURFACE_DEFAULTS.density;
  const scheme: SurfaceThemeStyle =
    mode === 'system' ? { colorScheme: 'light dark' } : { colorScheme: mode, ...PALETTES[mode] };
  return {
    ...scheme,
    ...DENSITIES[density],
    '--accent': colour,
    '--accent-foreground': surfaceAccentForeground(colour),
    '--radius': `${String(radius)}px`,
  };
}

/** What the widget loader draws its launcher and frame with; the server's `WidgetLook`. */
export interface SurfaceWidgetLook {
  readonly colour: string;
  readonly foreground: string;
  readonly radius: number;
  readonly layout: SurfaceLayout;
  readonly launcherLabel: string;
  readonly frameTitle: string;
}

/** The widget look of `surface`, served by the agent `agentName`. */
export function surfaceWidgetLook(
  surface: SurfaceDefinition,
  agentName: string,
): SurfaceWidgetLook {
  const colour = surface.theme?.colour ?? SURFACE_DEFAULTS.colour;
  const frameTitle = surface.title ?? agentName;
  const strings = surfaceStrings(surface.theme?.locale ?? SURFACE_DEFAULTS.locale);
  return {
    colour,
    foreground: surfaceAccentForeground(colour),
    radius: surface.theme?.radius ?? SURFACE_DEFAULTS.radius,
    layout: surface.layout ?? SURFACE_DEFAULTS.layout,
    launcherLabel: strings.launcherLabel(frameTitle),
    frameTitle,
  };
}
