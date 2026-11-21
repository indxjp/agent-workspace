/**
 * The store's two languages (spec "The store app"): the default is `theme.locale` (Japanese; the
 * apps lane writes it `en` for its English journeys), and `?lang=ja|en` on any page (the switch at
 * top right, and the URLs the sitemap and `hreflang` name) sets the `store_lang` cookie (`proxy.ts`). Every screen picks its words with `pick`, from the `{ ja, en }` pairs the
 * catalog and each screen's strings hold.
 */
import { theme } from './theme.ts';

export const LANGS = ['ja', 'en'] as const;
export type Lang = (typeof LANGS)[number];

/** The cookie the language switch sets; a page without it is in {@link DEFAULT_LANG}. */
export const LANG_COOKIE = 'store_lang';
export const DEFAULT_LANG: Lang = theme.locale;

/** `value` as a language, or the default for anything else (a missing or tampered cookie). */
export function langOf(value: string | undefined): Lang {
  return value === 'en' || value === 'ja' ? value : DEFAULT_LANG;
}

/** The words of `text` in `lang`. */
export function pick<T>(text: { readonly ja: T; readonly en: T }, lang: Lang): T {
  return text[lang];
}
