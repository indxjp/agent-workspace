# W1-CP-06 — The session cookie is `__Host-`, `Secure` and `SameSite=Lax`, unconditionally

Status: accepted
Date: 2026-09-03
Decided by: W1-CP-06 (Control Plane)
Scope: `apps/web/server/auth/session.ts`, `apps/web/server/auth/origin.ts`, `apps/web/middleware.ts`

## Context

The session is carried in a cookie, so the cookie's attributes are the authentication design, not a
detail of it. Spec §24 sets the posture (*"Treat the agent sandbox as potentially untrusted"*,
deny-by-default networking) and this task's brief adds *"A session cookie, hardened"* and *"Do not
hand-roll … CSRF protection."*

The one genuinely contested attribute is `Secure`. The product is self-hosted, spec §31 and
Appendix A.4 describe a single VM with Docker Compose, and nothing in the spec promises TLS. A
`Secure` cookie is refused by the browser over plain HTTP — except on `localhost`, which Chrome,
Firefox and Safari all exempt. So `Secure` unconditionally means: **development works, TLS
deployments work, and a deployment served over plain HTTP on a real hostname cannot hold a
session.**

## Decision

```text
__Host-aw_session   HttpOnly   Secure   SameSite=Lax   Path=/   Max-Age=43200
```

- **`__Host-` prefix.** Browser-enforced: the cookie is rejected unless it is `Secure`, `Path=/`
  and carries no `Domain`. Subdomain injection becomes impossible without any server-side check for
  it — the browser refuses to set the cookie in the first place.
- **`Secure`, unconditionally.** Not derived from the request's scheme. Deriving it is the classic
  downgrade: an attacker who can force one plain-HTTP request gets a cookie issued without the
  attribute, and every later request leaks it. A conditional hardening is a hardening the attacker
  chooses.
- **`SameSite=Lax`.** A cross-site `POST` does not carry the cookie at all, so it arrives
  unauthenticated and the gate answers 401. `Strict` was rejected because it breaks arriving at the
  product from an external link, which §20.6's share links make an ordinary path.
- **`HttpOnly`.** Script cannot read it.
- **Absolute 12-hour lifetime**, not a sliding window. `verifySessionToken` also refuses a token
  whose `exp - iat` exceeds the maximum this build issues, so a longer-lived token cannot be minted
  by a caller passing a larger TTL.

**CSRF is browser-enforced plus an `Origin` check, and no token is minted.** `SameSite=Lax` is the
primary control. `apps/web/server/auth/origin.ts` adds OWASP's recommended supplement for unsafe
methods: the `Origin` header must be present and its **host** must be one of the hosts this request
could legitimately have been addressed to (`nextUrl.host`, `Host`, `X-Forwarded-Host`). A missing,
`null`, unparseable or foreign `Origin` on a `POST`/`PUT`/`PATCH`/`DELETE` is 403 — absence is a
rejection, not a pass (ADR-0015). A synchroniser token was rejected outright: generating,
transporting, storing per session and rotating a second secret is exactly the hand-rolled CSRF
protection the brief forbids.

The comparison is on **host**, not on the full origin, because comparing `scheme://host:port`
breaks every deployment behind a TLS-terminating proxy — the browser says
`https://app.example.com`, the app sees `http://web:3000` — and that failure is total: every write
in the product returns 403. `X-Forwarded-Host` is trusted for this purpose because a browser will
not let a cross-site page set it; an attacker who can forge it is not attacking through a browser
and does not have the victim's cookie either.

## Honest downside

**A deployment served over plain HTTP on a non-localhost host cannot sign anybody in, and the
failure will look like a broken login rather than a missing certificate.** The browser silently
drops the cookie; the next request is 401. There is no server-side warning for it because the
server cannot see that the browser refused the cookie. If the Owner wants plain-HTTP deployments to
work, that is a decision to record, not a runtime downgrade to add — and the change is one
attribute in one function.

**`Origin` costs non-browser clients a header.** `curl -X POST` against `/api/**` with a session
cookie and no `Origin` gets 403 with `{"code":"cross_origin"}`. It is one flag
(`-H "Origin: http://localhost:3000"`). Programmatic access is supposed to use workspace API keys
(§22), which are W2's, and this is the interim cost.

**`SameSite=Lax` still permits a cross-site top-level `GET` to carry the cookie.** That is by
design and is why the `Origin` check covers only unsafe methods: a `GET` that changes state would
be the bug, not the cookie.
