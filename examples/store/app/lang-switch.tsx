import { LANGS, type Lang } from './lang';

const NAMES: Record<Lang, string> = { ja: '日本語', en: 'English' };

/**
 * The switch at top right: a link to this page at `?lang=<it>`, which sets the language cookie
 * (`proxy.ts`). Plain links, so it works without JavaScript and names the same URLs as `hreflang`.
 */
export function LangSwitch({ lang, label }: { readonly lang: Lang; readonly label: string }) {
  return (
    <div role="group" aria-label={label} className="store-lang">
      {LANGS.map((each) => (
        <a
          key={each}
          href={`?lang=${each}`}
          lang={each}
          hrefLang={each}
          aria-current={each === lang}
          className="aw-app-button"
        >
          {NAMES[each]}
        </a>
      ))}
    </div>
  );
}
