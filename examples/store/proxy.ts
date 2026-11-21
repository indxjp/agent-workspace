import { NextResponse, type NextRequest } from 'next/server';

import { LANG_COOKIE, langOf } from './app/lang.ts';

// The language choice is remembered for a year, and only the server reads it.
const COOKIE = { path: '/', maxAge: 365 * 24 * 60 * 60, sameSite: 'lax', httpOnly: true } as const;

/**
 * `?lang=ja|en` on a page (the URLs the sitemap and `hreflang` name, and the language switch) sets
 * the `store_lang` cookie: on this request, so the page and its header render in that language,
 * and on the answer, so the visitor's next pages do too. Any other value changes nothing. Static
 * files, the social cards and the API are left alone, so they never set a cookie.
 */
export function proxy(request: NextRequest): NextResponse {
  const lang = request.nextUrl.searchParams.get('lang');
  if (lang === null || langOf(lang) !== lang) return NextResponse.next();
  request.cookies.set(LANG_COOKIE, lang);
  const response = NextResponse.next({ request: { headers: request.headers } });
  const secure = request.nextUrl.protocol === 'https:';
  response.cookies.set(LANG_COOKIE, lang, { ...COOKIE, secure });
  return response;
}

export const config = { matcher: ['/((?!_next/static|_next/image|og/|api/).*)'] };
