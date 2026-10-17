# W2-CP-03 — A download is an inert attachment, never the uploader's chosen media type

Status: accepted
Date: 2026-09-05
Decided by: W2-CP-03 (ObjectStore / files API), verification round 2
Scope: `apps/web/server/files/http.ts`, `apps/web/server/files/handlers.ts`

## Context

`GET /api/files/:id` returns the bytes of a stored object. The first revision of this route set the
response `Content-Type` to the value the *uploader* supplied on `POST /api/files`, verbatim, and
sent no other header about how to treat the body. W2-CP-03's verification round 1 built the
counter-example and ran it through the real route handlers:

```
POST /api/files  x-file-path: pwn.txt  content-type: text/html
                 body: <script>alert(document.domain)</script>
POST status = 201

GET  /api/files/<encodeFileId('pwn.txt')>
GET  status                 = 200
GET  content-type           = text/html
GET  x-content-type-options = null
GET  content-disposition    = null
GET  body                   = <script>alert(document.domain)</script>
```

That is stored XSS from the application's own origin. Every workspace member can upload; the route
is same-origin with the session cookie and with every other `/api/**` route; so any member could
serve script to any other member of the same workspace and act as them. It was also undeclared:
round 1's audit of the branch found no gap, ADR, comment or test that mentioned download safety at
all, and `grep -rn 'nosniff|Content-Disposition'` over the whole of `apps/web/server/files`,
`packages/core/src/storage` and the W2-CP-03 ADRs returned nothing.

## Decision

Three independent defences, each of which closes the hole on its own. They are stacked because each
one has a failure mode the other two do not share, not because any one of them is doubted.

1. **The response `Content-Type` is never caller text.** `handlers.ts`'s `downloadContentType`
   parses the stored value (strip parameters, trim, case-fold — parse before comparing, ADR-0015),
   looks the essence up in `DOWNLOADABLE_CONTENT_TYPES`, and returns **the table's own string**.
   Anything not in the table becomes `application/octet-stream`. The table is a closed allowlist
   with an explicit rejecting `else`, not a blocklist of active types: a blocklist has to be
   complete to be safe, and `text/html`, `image/svg+xml`, `application/xhtml+xml`, `text/xml` and
   `application/xml` are only the entries anyone remembers.
2. **`Content-Disposition: attachment` on every binary response.** The browser saves the bytes
   rather than rendering them in a browsing context. The header is built from a positive character
   set — `[A-Za-z0-9._-]`, everything else substituted — so a key containing `"` or `;` cannot close
   the quoted string and append a parameter of its own, with an RFC 6266 `filename*=UTF-8''…` form
   carrying the real name.
3. **`X-Content-Type-Options: nosniff` on every response**, binary, JSON and empty alike, so a
   client cannot decide for itself that an `application/octet-stream` body "looks like" HTML.

The bytes themselves are returned unchanged. This is a delivery decision, not a sanitising one: the
store's mandate is byte-identical round-trips (W2-CP-04's importer depends on it), so nothing here
rewrites, escapes or inspects content.

## Consequences

* **`/api/files/:id` cannot be used as the `src` of an inline preview.** An `<img>` or a PDF frame
  pointed at it will download instead of rendering. This is a real cost and it is stated rather than
  glossed: spec §16's "preview metadata" (size, content type, modified time) is served by
  `GET /api/files` and is unaffected, but an inline *content* preview needs a separate, sandboxed
  delivery path — a distinct origin, or a one-time signed URL — which no task in this wave owns.
  Declared as a gap on this PR.
* A stored content type that is legitimate but not in the table (`text/html` for a genuine HTML
  document a user wants back) is served as `application/octet-stream`. The bytes are intact and the
  filename is intact, so the file downloads correctly; only the media type is generalised. Widening
  the table is safe for any type that cannot execute, and is a one-line change in one place.
* `apps/web/server/files/routes.test.ts`'s "verification round 1 counter-examples" block drives the
  round-1 reproduction above through the real route handlers and asserts all three headers, so a
  future edit that drops one fails a test rather than a review.
* This decision covers the files routes only. `apps/web/server/agents/http.ts` has its own
  `toResponse`, outside this task's `Owns` globs and serving JSON exclusively; whether the
  application should set `nosniff` globally (middleware, or `next.config`'s headers) is a
  repository-wide question for whoever owns that configuration.
