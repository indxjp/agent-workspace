# W9-R9b — A relative `Location` closes the cross-origin redirect class, and the proxy site is the framework's

Status: accepted
Date: 2026-09-14
Decided by: W9-R9b (implementing agent)
Scope: the `Location` header of every redirect the OIDC callback route and the proxy issue
(`apps/web/app/api/auth/callback/route.ts`, `apps/web/proxy.ts`); successor note to `W9-TEAM-185`
decision 8, which declared this class open

## Context

`W9-TEAM-185` decision 8 repaired `/api/auth/workspace` and then, under ADR-0048, enumerated the
sites the same root cause reaches without repairing them — three in the OIDC callback route and one
in the proxy — and said in terms that **the class is open**. Issue #187's review record raised the
same four as block R-2 (the Wave 9 review record in PR #199), adjudicated `refuted-as-declared`.
Issue #201 is where the class is closed, so #188 can carry it as closed rather than open.

The root cause is one sentence. `request.url`'s origin is the address this server is **bound** to,
never the address the client used. `next@16.3.4` builds it that way on both paths this repository
has: `dist/server/next-server.js:1280` gives a route handler
`${protocol}://${this.fetchHostname}:${this.port}${req.url}`, and `:1142` gives the proxy
`${initProtocol}://${this.fetchHostname || 'localhost'}:${this.port}${pathname}${query}`. Neither
reads `Host` on the path this deployment takes — `:1280`'s only `Host`-derived branch is reached
when `fetchHostname` or `port` is unset *and* `experimental.trustHostHeader` is on, and
`next.config.ts` sets neither. A reverse proxy, a container port map, or a plain
`localhost` / `127.0.0.1` alias is
enough to make the two differ — and then a redirect built from `request.url` crosses origins, the
cookie minted on that very response is not sent back to the other origin, and a sign-in that
succeeded arrives signed out. Under Playwright that alias *was* the whole defect (decision 8).

## Decision

**1. The class is closed.** After this change no site in the enumeration can put a cross-origin
`Location` on the wire: three because the code no longer builds an origin at all, the fourth
because the framework strips it and an executed test now proves it rather than assuming it. The
fourth carries one condition, stated here rather than left implicit: Next's stripping is itself
inside the `!process.env.__NEXT_NO_MIDDLEWARE_URL_NORMALIZE` guard at `adapter.js:393`, so that
site's relative wire header holds only while that flag is unset. Nothing in this repository sets
it and no test runs with it set; setting it would reopen this one site.

**2. The three callback sites answer a relative reference, in `/api/auth/workspace`'s exact shape.**
`apps/web/app/api/auth/callback/route.ts` gains a module-local `redirectTo(pathname, query = '')` —
the sibling's signature exactly, so the parameter names stay honest for the one arm that carries a
query string — returning a 303 `NextResponse` with no body whose `location` is `pathname` and
`query` concatenated. The three `NextResponse.redirect(new URL(…, request.url), 303)` calls become
`redirectTo('…')`:

| Arm | `Location` | Cookie riding the same response |
| --- | --- | --- |
| zero CURRENT memberships | `/signin?invitation=ready` | invitation-identity |
| exactly one | `/` | session |
| more than one | `/api/auth/workspace` | selection |

A relative reference is valid per RFC 9110 §10.2.2 and every browser resolves it against the
request URL, which is the only origin that can be right. The cookies still ride on the same
response; only the header's form changed, and the redirect targets are unchanged.

Six duplicated lines rather than a shared helper, per AGENTS.md's "add an abstraction only for a
stable shared concept". The doc comment carrying the reasoning is the substance of the duplication,
and it belongs in the file whose redirects a reader has open.

**3. `Host` and `X-Forwarded-Host` are refused as the source of the target, at all four sites.**
They would name the caller's origin, and both are caller-supplied: building a redirect from them
trades a lost session for an open redirect. Decision 8 said this; it is restated here because it is
the alternative a later reader will reach for first.

**4. `apps/web/proxy.ts` keeps its absolute same-origin construction, and the issue's prescribed
"smallest fix" is deliberately not applied there.** A proxy response does not reach the client as
written — `dist/server/web/adapter.js` post-processes it — and both halves of that processing were
read in the installed `next@16.3.4` and then pinned by tests:

- `adapter.js:394-396`: when `redirectURL.host === requestURL.host`, Next **rewrites the header
  itself** to `getRelativeURL(redirectURL, requestURL)`, the URL minus its origin
  (`dist/shared/lib/router/utils/relativize-url.js:25-36`). The proxy builds its target from
  `request.url` and the adapter builds `requestURL` from the same value (`adapter.js:123`), so the
  hosts match by construction and the branch always fires. **On the wire today this site already
  answers `Location: /signin`.** That rewrite is conditional: `:393` gates it behind
  `!process.env.__NEXT_NO_MIDDLEWARE_URL_NORMALIZE`, so with that flag set `proxy.ts:130` puts
  `http://<bind-host>/signin` back on the wire. Nothing in this repository sets it and no test runs
  with it set, so the claim above holds as stated — but it holds *because* of that, not
  unconditionally.
- `adapter.js:384`: the header is first passed to
  `new NextURL(location, { forceLocale, headers, nextConfig })`. That second argument has no
  `pathname` key and is not a string, so `dist/server/web/next-url.js:25-40` reads it as *options*,
  leaves `base` undefined, and `parseURL` (`:16-22`) evaluates `new URL('/signin', undefined)` — a
  `TypeError`. Applying the prescribed fix here therefore replaces a working redirect with a **500
  on every unauthenticated page visit**, the most-travelled path in the application. The call sits
  *above* the `__NEXT_NO_MIDDLEWARE_URL_NORMALIZE` guard at `:393`, so no flag avoids it.

So the issue's Outcome clause — every redirect the proxy issues answers a relative `Location` — is
satisfied at this site, and this change makes it a **tested** property instead of an assumed one.
`proxy.ts` acquires only the comment that records the above, so that the next reader does not
"complete" the repair into a 500.

**5. The status at the proxy site stays 307.** `NextResponse.redirect`'s default is 307, not the
303 the prescribed shape hard-codes. This is a page path, and a Server Action POSTs to one:
changing 307 → 303 would rewrite the method of a non-GET request. The three callback sites keep
their existing 303, which is correct for a `form_post` callback.

**6. Where the root cause still reaches, enumerated from the code and not repaired here**
(ADR-0048). `grep` over `apps/web` for a `Location` built from `request.url` now returns nothing
outside `proxy.ts:130`, whose answer is decision 4's. `apps/web/app/api/auth/login/route.ts:41` is
**not** a site: it redirects to `login.url`, the identity provider's own absolute authorization
endpoint, where an absolute URL is the only correct answer.

Two readings of `request.url` remain that are **not** `Location` sites and are a different symptom
of the same cause:

- `apps/web/app/api/auth/callback/route.ts:85` and `apps/web/app/api/auth/login/route.ts:46` derive
  the OIDC transaction cookie's `secure` flag from `new URL(request.url).protocol`. That is the
  **bind** protocol, so behind a TLS-terminating reverse proxy — plaintext on the inside, HTTPS on
  the outside — the cookie is minted without `Secure`.

They are outside issue #201's four sites and are not touched here. Saying so is the point:
ADR-0048's warning is that a partial repair plus a total claim retires the question. The claim made
above is about the `Location` class only.

## Alternatives considered

- **Apply `new NextResponse(null, { status: 303, headers: { location } })` at `proxy.ts:130` too.**
  Rejected on executed evidence: `adapter.js:384` throws (decision 4), and the wire header is
  already relative. It would close the class as the issue words it and open a worse one.
- **Redirect the proxy to a sentinel absolute origin** (`new URL('/signin', 'http://n')`) so nothing
  reads `request.url`. Rejected: `adapter.js:394`'s host comparison then fails, Next leaves the
  header alone, and the browser is sent to `http://n/signin`. Strictly worse than today.
- **`NextResponse.rewrite('/signin')` at the proxy.** Rejected: it leaves the URL bar on the
  protected path. That is a UX change, not this repair.
- **A shared `redirectTo` module imported by both auth routes.** Rejected per AGENTS.md: two
  six-line functions that happen to look alike are not a stable shared concept, and the reasoning
  is worth more next to each call site than behind an import.

## Consequences

- Anything that parsed these headers as absolute URLs breaks. In-repo that was only the two
  `new URL(location).pathname` readings in `callback.test.ts`, both rewritten. That reading is
  banned in the new assertions: `new URL('https://elsewhere.test/').pathname` is also `/`, which is
  exactly how the defect stayed invisible. An external consumer would need `new URL(location, base)`;
  `curl -L`, `fetch` and browsers all resolve a relative reference already.
- Two of the claims above are about `next@16.3.4` internals. They are pinned by
  `apps/web/proxy.test.ts` (the `NextURL` throw and the same-origin relativisation) and by
  `tests/auth.test.ts`'s live `next dev` probe of the wire header, so a version bump that changes
  either half fails a check rather than a user's session.
- `apps/web/proxy.test.ts` is a new file: it is the first unit test of that module, and it exists
  because `tests/auth.test.ts` cannot import `next` — the package is installed under
  `apps/web/node_modules` and the repository root has no copy.
- No schema, migration, contract, or public API change. Rollback is a `git revert` of the one PR.
- The `Secure`-flag pair in decision 6 remains open and belongs to a follow-up issue, which this
  run cannot file.
