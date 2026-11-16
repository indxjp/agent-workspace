import { pick, type Lang } from './lang.ts';

/** The words of one screen: `tr(lang)(ja, en)` picks the pair for the visitor's language. */
export function tr(lang: Lang) {
  return (ja: string, en: string): string => pick({ ja, en }, lang);
}
