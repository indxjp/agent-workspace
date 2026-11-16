'use client';
import { useRouter } from 'next/navigation';

import { LANG_COOKIE, LANGS, type Lang } from './lang';

/** How long the language choice is remembered: one year. */
const LANG_COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

const NAMES: Record<Lang, string> = { ja: '日本語', en: 'English' };

/** The switch at top right: sets the `store_lang` cookie and draws the page again in that language. */
export function LangSwitch({ lang, label }: { readonly lang: Lang; readonly label: string }) {
  const router = useRouter();
  const choose = (next: Lang) => {
    document.cookie = `${LANG_COOKIE}=${next}; path=/; max-age=${String(LANG_COOKIE_MAX_AGE_SECONDS)}; samesite=lax`;
    router.refresh();
  };
  return (
    <div role="group" aria-label={label} className="store-lang">
      {LANGS.map((each) => (
        <button
          key={each}
          type="button"
          lang={each}
          aria-pressed={each === lang}
          className="aw-app-button"
          onClick={() => {
            choose(each);
          }}
        >
          {NAMES[each]}
        </button>
      ))}
    </div>
  );
}
