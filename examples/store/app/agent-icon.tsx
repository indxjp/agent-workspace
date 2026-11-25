import type { CatalogEntry } from '../catalog/index.ts';
import { pick, type Lang } from './lang';

/**
 * An entry's app icon: the first letter of its name on its area's colour (`store.css`,
 * `[data-area]`). Decorative, so a screen reader reads the name beside it instead.
 */
export function AgentIcon({
  entry,
  lang,
  size = 'md',
}: {
  readonly entry: CatalogEntry;
  readonly lang: Lang;
  readonly size?: 'sm' | 'md' | 'lg';
}) {
  const [letter = '?'] = Array.from(pick(entry.name, lang));
  return (
    <span className={`store-icon store-icon-${size}`} data-area={entry.area} aria-hidden="true">
      {letter}
    </span>
  );
}
