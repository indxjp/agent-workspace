import type { ReactNode } from 'react';

/**
 * The page's `<main>` landmark and margins, the same as the switched-off panel (`feature-off.tsx`)
 * and close to the Agents, Models and Users screens, which draw their own. Files, Skills, a skill,
 * Connectors, New connector, API Keys and Settings render a fragment, so their pages wrap it here;
 * without it they had no landmark and sat flush against the sidebar (UX-24 in #2086).
 */
export function ScreenMain({ children }: { readonly children: ReactNode }) {
  return <main className="w-full max-w-[1120px] px-4 pt-[26px] pb-[90px] sm:px-8">{children}</main>;
}

/**
 * A screen the caller may not open: the same landmark and margins, the screen's own heading, and
 * the refusal in words, so a person who follows a link here still lands inside `<main>`.
 */
export function NotAllowedScreen({
  title,
  children,
  lang,
}: {
  readonly title: string;
  readonly children: ReactNode;
  /** The language the title and refusal are in, when a page words them for its reader. */
  readonly lang?: string;
}) {
  return (
    <ScreenMain>
      <h1 lang={lang} className="text-[21px]">
        {title}
      </h1>
      <p lang={lang} className="mt-2 text-sm text-muted">
        {children}
      </p>
    </ScreenMain>
  );
}
