import type { SurfaceTheme } from '@indx-workspace/contracts/surfaces';

/**
 * The portal's look and language, in one place: every page and the chat read it. `locale` is
 * `en` or `ja`; `colour`, `radius`, `mode` and `density` are the hosted surface's own theme keys.
 */
export const theme = {
  locale: 'en',
  radius: 8,
  colour: '#0f766e',
  density: 'compact',
} as const satisfies SurfaceTheme;
