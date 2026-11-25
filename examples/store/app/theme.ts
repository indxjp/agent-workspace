import type { SurfaceTheme } from '@indx-workspace/contracts/surfaces';

/**
 * The store's look and language, in one place. `locale` is the language a visitor sees until the
 * switch at top right sets the `store_lang` cookie (`lang.ts`): the store is Japanese first, and
 * the apps lane writes `en` here for its English journeys.
 */
export const theme = {
  locale: 'ja',
  colour: '#0070e0',
  radius: 12,
} as const satisfies SurfaceTheme;
