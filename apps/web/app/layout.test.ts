/**
 * The root layout's `lang` stays English: most screens are still English, so a Japanese `lang` on
 * `<html>` would have a screen reader read them with a Japanese voice. The translated parts carry
 * their own `lang` (UX-15 in #2086; see `components/shell/shell-lang.test.tsx`).
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import RootLayout from './layout';

describe('RootLayout lang (UX-15)', () => {
  it('is en, whatever language the browser asks for', () => {
    const markup = renderToStaticMarkup(RootLayout({ children: null }));
    expect(/<html lang="([^"]*)"/u.exec(markup)?.[1]).toBe('en');
  });
});
