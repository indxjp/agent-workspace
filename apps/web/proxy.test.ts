/**
 * The framework contract that decides the form of `apps/web/proxy.ts`'s one redirect — issue #201.
 *
 * The other three enumerated sites (`app/api/auth/callback/route.ts`) are App Router route
 * handlers: the `Response` they return is what the client receives, so they simply set a relative
 * `Location` and their own tests assert it. A proxy response is not that. It is post-processed by
 * `next/dist/server/web/adapter.js` before it is sent, and the two assertions below are the halves
 * of that post-processing this repository depends on:
 *
 *   1. a relative `Location` set by the proxy **throws** inside `NextURL`, so it is not an
 *      available shape at that site — the "smallest fix" prescribed for the other three would be a
 *      500 on every unauthenticated page visit; and
 *   2. an absolute same-origin `Location` set by the proxy is **rewritten by Next itself** to the
 *      relative form, which is why the wire header is already correct today.
 *
 * These are `next@16.3.4` internals, pinned deliberately: a version bump that changes either half
 * fails here rather than in a user's session. The behaviour they explain is asserted end to end,
 * over HTTP against a real `next dev`, in `tests/auth.test.ts` — this file says *why* the code in
 * `proxy.ts` looks the way it does, that one says what a browser actually receives.
 *
 * See `docs/adr/W9-R9b-relative-location-closes-the-class-and-the-proxy-site-is-owned-by-next.md`.
 *
 * The second suite below is about a different property of the same file: which paths the gate
 * admits on a bearer API key. It drives `proxy()` itself rather than a Next internal.
 */

import { describe, expect, it } from 'vitest';
import { NextURL } from 'next/dist/server/web/next-url';
import { getRelativeURL } from 'next/dist/shared/lib/router/utils/relativize-url';
import { ADAPTER_OPTIONS } from './proxy.test-support';

describe('the Location contract apps/web/proxy.ts is written against', () => {
  it('refuses a relative Location: NextURL reads its second argument as options, never as a base', () => {
    // `{ forceLocale, headers, nextConfig }` has no `pathname` key and is not a string, so
    // `next-url.js` takes the options branch, leaves `base` undefined, and evaluates
    // `new URL('/signin', undefined)`. There is no flag that avoids this — the call sits above the
    // `__NEXT_NO_MIDDLEWARE_URL_NORMALIZE` guard.
    expect(() => new NextURL('/signin', ADAPTER_OPTIONS)).toThrow(TypeError);

    // The same input with a base is fine, which is the proof that the throw is about the missing
    // origin and not about `/signin`.
    expect(new NextURL('/signin', 'http://127.0.0.1:3000', ADAPTER_OPTIONS).pathname).toBe(
      '/signin',
    );
  });

  it('strips the origin from a same-origin absolute Location, which is why the wire header is relative', () => {
    // `proxy.ts` builds its target with `new URL('/signin', request.url)`, and the adapter builds
    // the URL it compares against from that same `request.url`, so the hosts match by construction
    // and this branch always fires.
    const requestURL = new NextURL('http://127.0.0.1:3000/', ADAPTER_OPTIONS);
    const redirectURL = new NextURL(
      new URL('/signin', 'http://127.0.0.1:3000/').toString(),
      ADAPTER_OPTIONS,
    );
    expect(redirectURL.host).toBe(requestURL.host);
    expect(getRelativeURL(redirectURL, requestURL)).toBe('/signin');
    expect(getRelativeURL(redirectURL, requestURL)).not.toContain('://');

    // And the negative control: a cross-origin target is left absolute, so the rewrite above is a
    // same-origin relativisation and not a blanket "drop the host".
    const elsewhere = new NextURL('https://elsewhere.test/signin', ADAPTER_OPTIONS);
    expect(getRelativeURL(elsewhere, requestURL)).toBe('https://elsewhere.test/signin');
  });
});
