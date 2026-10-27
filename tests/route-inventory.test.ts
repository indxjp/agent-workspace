/**
 * The route-inventory gate (plan §9.1, "a route-inventory test asserting the API surface equals
 * §34"), and every other invariant that quantifies over *all* route handlers.
 *
 * This is a repository-wide invariant, not a test of one task's code, and under
 * [ADR-0019](../docs/adr/0019-repo-wide-gates-belong-to-the-integration-level.md) it is owned at the
 * integration level — by W1-INT-02, and now by W2-INT-00 — rather than by the feature task that
 * first needed it. It enumerates every route handler the repository *ships*, derives the HTTP
 * surface they expose, and asserts that surface **equals** the declared subset of spec §34 — no
 * route missing, and, the half that matters more, no route present that §34 does not name. Spec
 * §34's own instruction is "expose a very small control-plane API"; the way that instruction is
 * normally lost is one convenience endpoint at a time, each defensible on its own.
 *
 * ## The three sets, and why there are three
 *
 *   * `specRoutes()` — parsed out of `docs/spec.md` §34 at test time. Never transcribed: if the
 *     specification is amended, this set moves with it and no one has to update a copy here.
 *   * {@link expectedRoutes} — the subset this repository has decided to implement so far, one
 *     entry per route, each naming the task that owns it and whether it has landed. This is the
 *     only hand-maintained list, and extending it is meant to be a deliberate act.
 *   * the tracked tree — what is really there.
 *
 * The assertions run in that order, so a failure says which of the three disagrees. In particular,
 * a route that exists but is not in §34 fails against the specification, not merely against a list.
 *
 * ## The hand-maintained list is partitioned, and lives outside this file
 *
 * It used to be a single `EXPECTED_ROUTES` array here. Wave 2 runs six tracks in parallel and five
 * of them ship routes, so that array was a shared mutable resource in a wave designed around not
 * having any: either every track edits one array and collides, or every track's CI is red against a
 * gate that is working correctly.
 * [ADR-0025](../docs/adr/0025-the-route-inventory-is-partitioned-by-owner.md) splits it into
 * `tests/route-declarations/<TASK-ID>.ts`, one file per owning task — inside that task's `Owns`
 * glob by construction, exactly as its ADRs are — and this gate reads the **union of the tracked
 * declaration files**. None of the three assertions is weakened; only the list is repartitioned.
 *
 * The set of declaration files is itself **derived from the tracked tree by shape** —
 * `git ls-files` plus the filename rule in `declarationOwner`, which throws on anything that is not
 * a `<TASK-ID>.ts` — and never written down here as a list of member paths. The first version of
 * this repair did write them down, and that is the defect ADR-0027 was written about — recorded
 * for this repository in
 * [W2-INT-00-a-gate-derives-its-partition-from-the-tracked-tree.md](../docs/adr/W2-INT-00-a-gate-derives-its-partition-from-the-tracked-tree.md).
 * A literal list turns this gate red on every branch that adds a declaration file, and this file
 * is inside no wave task's `Owns` glob, so no such branch could turn it green. The same rule now
 * derives the route-file set for the same reason.
 *
 * A partition has two new ways to fail open, and ADR-0025 §3 requires both to fail closed. Both do,
 * and both are proved below rather than asserted in prose:
 *
 *   * a declaration file that exports nothing this reader can read is a **hard failure**, never an
 *     empty contribution — an unreadable declaration is not an absence of routes;
 *   * two files declaring the same `method`+`path` is a **hard failure naming both owners**,
 *     because duplicate ownership is the condition the split exists to make impossible and a set
 *     union would swallow it without a word.
 *
 * The declaration files are read as **text**, not imported. A loop that dynamically imports each
 * one is a module reference no static scan can resolve, and `tests/no-sdk-import.test.ts` refuses to
 * pass over one — the same objection that stopped this gate importing `apps/web/next.config.ts`
 * (`docs/adr/W1-INT-02-the-page-extension-knob-is-asserted-unset-not-read.md`). The reader is in
 * `tests/inventory-support.ts` and its grammar is total: every character is either part of a
 * construct it understands or the reason it refuses.
 *
 * ## §34 is a shape rule, and an extra route cites its mandate
 *
 * §34 introduces its list with the word "Examples:", and Wave 2 needs routes it does not print —
 * secrets (§23), API keys (§22), a file rename (§16), a membership role change (§21).
 * [ADR-0026](../docs/adr/0026-section-34-is-a-shape-rule-and-an-extra-route-cites-its-mandate.md)
 * neither closes the list nor drops the assertion. Instead:
 *
 *   * every route §34 prints ships at that method and that path, or this gate fails — unchanged;
 *   * a route §34 does not print ships only with a `mandate` naming the section that requires the
 *     capability, and **that section is looked up in `docs/spec.md`'s headings**, so a citation
 *     cannot be invented;
 *   * a route §34 *does* print may not carry a mandate: that means its author did not know it was
 *     already named, and the two lists have drifted;
 *   * the shape rule is enforced rather than assumed — `/api/<resource>`, `/api/<resource>/:id`,
 *     `/api/<resource>/:id/<sub>`, resource plural, no verb in the resource position — and the
 *     failure names which of those rules was broken.
 *
 * ## The inventory is the TRACKED tree, and that is what fixes the Wave 1a race
 *
 * The route files are listed with `git ls-files -- apps/web/app`, not by walking the working
 * directory. This is the same rule `tests/no-sdk-import.test.ts` uses and that
 * `docs/adr/W0-INF-02-probe-set-derived-from-the-tracked-tree.md` established, and here it is
 * load-bearing for a second reason.
 *
 * `tests/auth.test.ts` writes a real route handler at `apps/web/app/api/w1cp06-unregistered/deep/`
 * for the whole of its run — that fixture is the *point* of its acceptance criterion, a route
 * registered nowhere that must still be refused. It runs in a parallel worker of the same Vitest
 * run as this file. A working-directory walk therefore saw it and reported it as an undeclared
 * route whenever the two overlapped. The tracked tree does not contain it, because it is written
 * at run time and never committed, and a route that is not committed is a route this repository
 * does not ship.
 * That is a *positive* rule — "the inventory is the committed route surface" — not an exclusion
 * list, and it holds for any future test fixture without this file learning its name. The same rule
 * now enumerates the declaration files: an untracked declaration in somebody's working tree
 * contributes nothing, and a tracked one always does.
 *
 * The converse direction is fixed by construction: **this file writes nothing into the repository
 * tree.** The `route.jsx` probe below used to be planted under `apps/web/app/api/agents/` with
 * `mkdtempSync`, which grew `tests/auth.test.ts`'s derived probe matrix by two tests whenever the
 * two files overlapped in time. It is now a synthetic entry handed to the same pure functions the
 * live gate uses, so the proof is unchanged and the tree is never touched. ADR-0019 §4. That
 * promise is asserted mechanically, over every module this gate's imports reach — `gateModules`
 * walks the import graph, so moving a call into a helper is not a way of getting the promise back
 * for free. The first version of that scan named the helper instead of finding it, and a verifier
 * walked out of the list by adding a second one.
 *
 * ## Which files count as a route handler
 *
 * Next.js serves a file named `route.<ext>` for every `<ext>` in the application's configured
 * `pageExtensions`. That setting is a knob, and the previous version of this gate read it by
 * importing `apps/web/next.config.ts` dynamically so that a computed value could not be missed. That
 * import is a module reference no static scan can resolve, and `tests/no-sdk-import.test.ts`
 * rightly refuses to pass over one — see
 * `docs/adr/W1-INT-02-the-page-extension-knob-is-asserted-unset-not-read.md`. So the knob is now
 * **asserted to be unset** rather than read: the gate fails, loudly and by name, the moment
 * `apps/web/next.config.ts` so much as mentions `pageExtensions`, and until that day it uses Next's
 * documented default set. Refusing to run on a config it cannot read is the ADR-0015 shape; reading
 * it through a construct another gate cannot decide was not. That guard now lives in
 * `tests/inventory-support.ts`, because the screen inventory asks the same question of the same
 * knob and two answers to one question is one answer too many; the assertion that the knob really
 * is unset is still made here, by reading the config file.
 *
 * A file under `apps/web/app` whose name begins `route.` but whose extension is not one of those
 * extensions is a **hard failure**, not a skip. This reader cannot tell whether such a file is dead
 * weight or a route it is failing to see.
 *
 * ## What this does NOT cover
 *
 * Pages. `page.tsx` is a screen, not an API route, and plan §9.1 gives screens their own
 * screen-inventory test — `tests/screen-inventory.test.ts`, which W2-INT-00 wrote. The exclusion is
 * deliberate and is asserted here, over the real tracked page files, so that it stays deliberate.
 * The two gates read one grammar for that boundary: `filterPageFiles` and `filterRouteFiles` apply
 * the same private-folder rule and each ends in a classifier that throws rather than skipping what
 * it cannot decide. This gate reads the tracked app directory through **both** of them, so it
 * refuses both kinds of file. Four probes, all run: a planted `apps/web/app/api/probe/route.mdx`
 * fails this gate while it is building `routeFiles`, with `classifyAppFile`'s message; a planted
 * `apps/web/app/blog/page.mdx` fails the "excludes every tracked page file" assertion below, with
 * `classifyPageFile`'s. `tests/screen-inventory.test.ts` reads the directory through
 * `filterPageFiles` alone: the same `page.mdx` fails it, and the same `route.mdx` leaves it green.
 * Two sentences have now stood here claiming otherwise — the first that the screen gate refused a
 * `route.mdx`, the second that neither gate refuses both — and a run disproved each.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { API_ROUTE_EXCLUSIONS } from '@indx-workspace/contracts/routes';
import { describe, expect, it } from 'vitest';

import {
  APP_PREFIX,
  DEFAULT_PAGE_EXTENSIONS,
  HTTP_METHODS,
  NEXT_CONFIG_FILENAMES,
  PAGE_EXTENSIONS_KNOB,
  REPO_ROOT,
  SPEC_PATH,
  WEB_DIR,
  declarationOwner,
  declarationPaths,
  filterPageFiles,
  gateModules,
  nonReadingFsAccess,
  pageExtensions,
  readDeclarationArray,
  readDeclarationFiles,
  relativeSpecifiers,
  requireBoolean,
  requireString,
  specSections,
  trackedFiles,
  underPrivateFolder,
  unknownFields,
  urlPathOf,
} from './inventory-support.js';
import type {
  DeclarationFile,
  HttpMethod,
  RouteDeclaration,
  RouteMandate,
} from './inventory-support.js';

/** Where the partition lives. Repo-relative, forward-slashed — a `git ls-files` prefix. */
const ROUTE_DECLARATIONS = 'tests/route-declarations';

/**
 * Classify one file sitting in the app directory.
 *
 * Total, and the fall-through rejects. `route` means Next serves it; `ignore` means the name has
 * nothing to do with route handlers (`page.tsx`, `layout.tsx`, `globals.css`); anything named
 * `route.something-else` throws, because a reader that skipped it would be deciding "this is not a
 * route" from the absence of a match — exactly the shape that let `route.jsx` through the first
 * version of this gate.
 */
export function classifyAppFile(
  name: string,
  extensions: ReadonlySet<string>,
  file: string,
): 'route' | 'ignore' {
  const prefix = 'route.';
  if (!name.startsWith(prefix)) return 'ignore';
  const extension = name.slice(prefix.length);
  if (extensions.has(extension)) return 'route';
  throw new Error(
    `${file}: this file is named "${name}", but "${extension}" is not one of the pageExtensions ` +
      `this application configures (${[...extensions].sort().join(', ')}). The route inventory ` +
      `cannot tell whether Next.js serves it. If it does, the config and this gate disagree; if it ` +
      `does not, rename the file so it is not called route.*.`,
  );
}

// ── The declared surface, read from the partition ───────────────────────────────────────────

/** The fields a route declaration entry may carry. Anything else is rejected by name. */
const ROUTE_FIELDS = ['method', 'path', 'owner', 'landed', 'mandate'] as const;
/** The fields a `mandate` may carry. */
const MANDATE_FIELDS = ['section', 'because'] as const;

/**
 * Validate one raw entry out of one declaration file.
 *
 * Every field is checked positively and the fall-through rejects: a field absent, of the wrong
 * type, or not on {@link ROUTE_FIELDS} throws with the file and the entry named. `owner` must equal
 * the declaration file's own stem, which is what stops one task declaring routes on another's
 * behalf and so makes the "which file declared this?" half of the duplicate message truthful.
 */
export function validateRouteEntry(
  entry: Record<string, unknown>,
  file: string,
  owner: string,
): RouteDeclaration {
  const where = `${file}: ${JSON.stringify(entry)}`;
  const extra = unknownFields(entry, ROUTE_FIELDS);
  if (extra.length > 0) {
    throw new Error(
      `${where}: carries ${extra.join(', ')}, which no part of this gate reads. A field nothing ` +
        `reads is a claim nothing checks.`,
    );
  }
  const method = requireString(entry, 'method', where);
  if (!(HTTP_METHODS as readonly string[]).includes(method)) {
    throw new Error(
      `${where}: "${method}" is not an HTTP method Next.js serves ` +
        `(${HTTP_METHODS.join(', ')}), so no route file could ever match it.`,
    );
  }
  const routePathValue = requireString(entry, 'path', where);
  if (!routePathValue.startsWith('/')) {
    throw new Error(`${where}: "path" must begin with "/".`);
  }
  const declaredOwner = requireString(entry, 'owner', where);
  if (declaredOwner !== owner) {
    throw new Error(
      `${where}: declares owner "${declaredOwner}" in ${file}, whose owner is "${owner}". A ` +
        `declaration file speaks for exactly one task — the one it is named after (ADR-0025 §1).`,
    );
  }
  const landed = requireBoolean(entry, 'landed', where);
  const base = {
    method: method as HttpMethod,
    path: routePathValue,
    owner: declaredOwner,
    landed,
  };
  if (!('mandate' in entry)) return base;
  const raw = entry['mandate'];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${where}: "mandate" must be an object with a section and a because.`);
  }
  const mandateEntry = raw as Record<string, unknown>;
  const mandateExtra = unknownFields(mandateEntry, MANDATE_FIELDS);
  if (mandateExtra.length > 0) {
    throw new Error(
      `${where}: the mandate carries ${mandateExtra.join(', ')}, which nothing reads.`,
    );
  }
  const section = requireString(mandateEntry, 'section', where);
  if (!/^\d+(?:\.\d+)*$/.test(section)) {
    throw new Error(
      `${where}: a mandate's "section" is a specification section number as docs/spec.md prints it ` +
        `— "16", "20.6" — not "${section}".`,
    );
  }
  const mandate: RouteMandate = { section, because: requireString(mandateEntry, 'because', where) };
  return { ...base, mandate };
}

/**
 * The union of the declaration files, with duplicate ownership rejected.
 *
 * ADR-0025 §3: two files declaring the same `method`+`path` is a hard failure **naming both
 * owners**. A `Set` union would have swallowed it; this builds the union through a map keyed by
 * `METHOD /path` and throws the moment a second file claims one, so the message can say who else
 * had it. Duplication inside a single file is caught by the same map and says so.
 */
export function unionRoutes(files: readonly DeclarationFile[]): RouteDeclaration[] {
  const byKey = new Map<string, { entry: RouteDeclaration; file: string }>();
  for (const file of files) {
    for (const raw of file.entries) {
      const entry = validateRouteEntry(raw, file.repoPath, file.owner);
      const routeKey = key(entry);
      const seen = byKey.get(routeKey);
      if (seen !== undefined) {
        throw new Error(
          `${routeKey} is declared twice: by ${seen.entry.owner} in ${seen.file} and by ` +
            `${entry.owner} in ${file.repoPath}. Exactly one task owns the file that serves a ` +
            `route, so exactly one declaration file may claim it (ADR-0025 §3). Decide which task ` +
            `ships it and delete the other entry.`,
        );
      }
      byKey.set(routeKey, { entry, file: file.repoPath });
    }
  }
  return [...byKey.values()].map((held) => held.entry);
}

/** The declared surface: every tracked declaration file, read and unioned. */
function expectedRoutes(): RouteDeclaration[] {
  return unionRoutes(readDeclarationFiles(ROUTE_DECLARATIONS, 'routes'));
}

/** `METHOD /path`, the one string form all three sets are compared in. */
function key(entry: { method: string; path: string }): string {
  return `${entry.method} ${entry.path}`;
}

// ── The shape rule ──────────────────────────────────────────────────────────────────────────

/** A resource or sub-resource segment: lower-case, digits, single hyphens between words. */
const SEGMENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** A dynamic segment in the specification's notation. */
const PARAMETER = /^:[a-z][A-Za-z0-9]*$/;

/**
 * Resource segments that name an action rather than a thing.
 *
 * This list is an **additional** rejection layered on the positive rules below, never a substitute
 * for them: `no-verb` cannot fail open, because a verb this list has never heard of still has to
 * pass `shape` (kebab-case, so `renameFile` is out) and `plural-resource` (so `rename` is out). It
 * exists so that the commonest RPC-in-a-URL spellings fail under the name ADR-0026 decision 3 gives
 * them rather than under a rule about hyphens.
 */
const ACTION_WORDS = new Set([
  'create',
  'creates',
  'get',
  'gets',
  'list',
  'lists',
  'update',
  'updates',
  'delete',
  'deletes',
  'remove',
  'removes',
  'rename',
  'renames',
  'move',
  'moves',
  'copy',
  'copies',
  'search',
  'searches',
  'execute',
  'executes',
  'revoke',
  'revokes',
  'import',
  'imports',
  'export',
  'exports',
  'upload',
  'uploads',
  'download',
  'downloads',
  'invite',
  'invites',
  'reset',
  'resets',
  'send',
  'sends',
]);

/** What the shape rule decided, and — when it refused — which rule it was. */
export type ShapeVerdict =
  { readonly ok: true } | { readonly ok: false; readonly rule: string; readonly detail: string };

/**
 * Decide one declared path against ADR-0026 decision 3.
 *
 * Total, with an explicit else that rejects. A path under `/api/` is checked structurally; a path
 * outside `/api/` is admissible only if spec §34 prints it verbatim — §34 puts the public pages
 * under `/p/` deliberately, *"so that 'is this request authenticated?' is answerable by looking at
 * the path prefix alone"*, and that is the specification's own decision rather than a shape this
 * gate may generalise from. Anything else is refused under `outside-api`.
 */
export function routeShape(routePathValue: string, printedInSpec: boolean): ShapeVerdict {
  // Spec §30's pre-authentication setup flow needs one read-only capability probe before any
  // resource or administrator exists. The exact path is dispatched by W7-UI-04; this narrow
  // exception does not generalise a second literal segment to any other API route.
  if (routePathValue === '/api/setup/runtime-detect' || routePathValue === '/api/setup') {
    return { ok: true };
  }
  // §21's OIDC sign-in exchange (issue #118, dispatched by W9-AUTH-118) is three fixed
  // pre-session endpoints, none of which name a resource a plural noun would fit: there is no
  // list of "logins" to page through, and `:id` names nothing here — the caller has no identity
  // yet, which is the whole reason these three exist outside the authenticated `/api/**` shape.
  // As with `/api/setup` above, this is a named, narrow exception and does not generalise a
  // second literal segment to any other route.
  if (
    routePathValue === '/api/auth/login' ||
    routePathValue === '/api/auth/callback' ||
    routePathValue === '/api/auth/workspace'
  ) {
    return { ok: true };
  }
  // §21's terminal sign-in (issue #242, dispatched by SDK-10-CLI-AUTH-242, ADR-0083) is the same
  // kind of thing: four fixed steps of an OAuth device authorization grant — start, approve, take
  // or revoke the token, switch workspace — beside the three above, naming no collection and no
  // id. The same named, narrow exception; it generalises to no other route.
  if (
    routePathValue === '/api/auth/cli-device' ||
    routePathValue === '/api/auth/cli-verify' ||
    routePathValue === '/api/auth/cli-token' ||
    routePathValue === '/api/auth/cli-workspace'
  ) {
    return { ok: true };
  }
  // ADR-0120 clause 7, ADR-0144 D5 and issue #1674: the three fixed paths the platform cron calls,
  // naming no collection and no id. The same named, narrow exception as the sign-in steps above; it
  // generalises to no other route.
  if (
    routePathValue === '/api/cron/retention' ||
    routePathValue === '/api/cron/triggers' ||
    routePathValue === '/api/cron/storage-cleanup'
  ) {
    return { ok: true };
  }
  // Issue #1562: the readiness probe a kubelet calls. `readyz` is the Kubernetes convention for the
  // path, not a collection. One literal with its reason attached; it generalises to no other route.
  if (routePathValue === '/api/readyz') return { ok: true };
  // Issue #1846: the `aw-control` MCP door a running agent reaches through the gateway. `builder` is
  // a product name, not a collection, and `mcp` is the protocol, not an id. One literal with its
  // reason attached; it generalises to no other route.
  if (routePathValue === '/api/builder/mcp') return { ok: true };
  // §21's "who is this credential?" route (issue #233, dispatched by SDK-01-ME-233) is the one
  // resource that cannot be plural: a principal is a **singleton per caller**, so there is no
  // collection of "mes" to page through and no `:id` that could name one — `me` is not an id, it
  // is the only row the caller can ever address. Renaming it to `/api/principals/me`, the shape
  // that needs no exception here, would say something false (that a caller may name principals by
  // id) about a path `docs/sdk/04-api-specification.md` §5.2 and §8 already print. As with
  // `/api/setup` and the three `/api/auth/*` routes above, this is a single literal with its
  // reason attached and it generalises to no other route: any other singular resource still fails
  // the `plural-resource` rule below.
  if (routePathValue === '/api/me') {
    return { ok: true };
  }
  // ADR-0135: the A2A v0.3 protocol fixes where a client finds an agent. The agent card lives at
  // `<base>/.well-known/agent-card.json` under the URL the card names, so the card path is three
  // literal segments deep by the protocol's own convention, and `a2a` is the protocol's name, not
  // a collection. As with `/api/me` above, these are two literals with their reason attached and
  // they generalise to no other route.
  if (
    routePathValue === '/api/a2a/agents/:agentName' ||
    routePathValue === '/api/a2a/agents/:agentName/.well-known/agent-card.json'
  ) {
    return { ok: true };
  }
  // ADR-0134 part 3: RFC 9728 fixes where a client finds a protected resource's metadata — the
  // well-known prefix followed by the resource's own path, here the A2A endpoint above. §34 cannot
  // print it without naming `a2a` as a resource, which it is not. One literal with its reason; it
  // generalises to no other route.
  if (routePathValue === '/.well-known/oauth-protected-resource/api/a2a/agents/:agentName') {
    return { ok: true };
  }
  // Issue #1846 slice 5b: the Builder's read-only door for an outside MCP client sits beside
  // `/mcp/projects/:name` (an MCP resource, not an `/api` collection) and, by RFC 9728, publishes
  // its metadata under the well-known prefix. Two literals with their reason; they generalise to
  // no other route.
  if (
    routePathValue === '/mcp/builder' ||
    routePathValue === '/.well-known/oauth-protected-resource/mcp/builder'
  ) {
    return { ok: true };
  }
  // ADR-0147 (issue #1314, P8-4): search over the files a caller may read is a query of the `files`
  // collection, so it is `GET /api/files/search?q=`, beside `/api/files/:id` and not a `searches`
  // resource of its own. It is the SDK's `files.search` and the public contract the issue names.
  // One literal with its reason attached; it generalises to no other route.
  if (routePathValue === '/api/files/search') return { ok: true };
  // ADR-0144: Microsoft Graph and Zoom can call only a fixed URL and send no header, so the
  // trigger's secret is the last path segment. One literal with its reason; it generalises to no
  // other route.
  if (routePathValue === '/api/triggers/:id/fire/:secret') {
    return { ok: true };
  }
  if (!routePathValue.startsWith('/api/')) {
    if (printedInSpec) return { ok: true };
    return {
      ok: false,
      rule: 'outside-api',
      detail:
        `"${routePathValue}" is neither under /api/ nor printed in spec §34. §34 keeps the public ` +
        `pages under /p/ so that authentication is answerable from the path prefix alone; a new ` +
        `prefix is a specification change, not a route.`,
    };
  }
  const segments = routePathValue.slice(1).split('/');
  const [, resource, ...rest] = segments;
  if (resource === undefined || !SEGMENT.test(resource)) {
    return {
      ok: false,
      rule: 'shape',
      detail:
        `"${routePathValue}" does not begin /api/<resource>, where <resource> is lower-case words ` +
        `joined by single hyphens. ADR-0026 decision 3.`,
    };
  }
  if (rest.length > 2) {
    return {
      ok: false,
      rule: 'shape',
      detail:
        `"${routePathValue}" is deeper than /api/<resource>/:id/<sub>. §34 exposes "a very small ` +
        `control-plane API"; a fourth level is a resource that has not been named.`,
    };
  }
  if (rest.length >= 1 && !PARAMETER.test(rest[0] as string)) {
    return {
      ok: false,
      rule: 'shape',
      detail:
        `"${routePathValue}": the segment after the resource must be a dynamic id such as ":id", ` +
        `not "${rest[0] as string}". A second literal segment is a second resource.`,
    };
  }
  if (rest.length === 2 && !SEGMENT.test(rest[1] as string)) {
    return {
      ok: false,
      rule: 'shape',
      detail: `"${routePathValue}": "${rest[1] as string}" is not a lower-case hyphenated segment.`,
    };
  }
  if (!resource.endsWith('s')) {
    return {
      ok: false,
      rule: 'plural-resource',
      detail:
        `"${routePathValue}": the resource "${resource}" is not plural. Every resource §34 prints ` +
        `is — agents, runs, sessions, models, skills, connectors, files, users, projects, shares.`,
    };
  }
  if (ACTION_WORDS.has(resource)) {
    return {
      ok: false,
      rule: 'no-verb',
      detail:
        `"${routePathValue}": "${resource}" is an action, not a resource. §34 says "do not invent ` +
        `RPC frameworks if ordinary HTTP is enough" — the verb belongs in the method.`,
    };
  }
  return { ok: true };
}

// ── The specification ───────────────────────────────────────────────────────────────────────

/**
 * Every route printed in spec §34's code blocks.
 *
 * The slice read is §34 and only §34: from its heading to the next top-level heading, which is how
 * `docs/spec.md` ends a section. Round 2 sliced to end of file and took the first ```text fence in
 * that slice, so the fence was not necessarily §34's. A verifier retagged §34's own fence to ```http
 * and this gate read §35's fence instead, stopped only by the `routes.size === 0` backstop; round 3
 * then moved §34's route lines down into `# 35. Observability` as well, and the gate passed at 35 of
 * 35 with §34 printing no route at all. Every fence inside the section is read now, so "which one"
 * is not a question this parser answers either.
 *
 * Fails loudly if the section or a fence cannot be found. A parser that quietly returned an empty
 * set would make every "is this route in the spec?" assertion below pass vacuously, which is the
 * fail-open shape ADR-0015 exists to stop: a check that cannot run must fail, not pass.
 */
export function specRoutes(): ReadonlySet<string> {
  return parseSpecRoutes(readFileSync(SPEC_PATH, 'utf8'));
}

/**
 * Every line of §34's fenced blocks that opens like a request line but which {@link parseSpecRoutes}
 * did not turn into a route.
 *
 * This is a deliberately *looser* recognizer than the parser's, and it exists to be a second,
 * independent reading of the same text. The parser accepts exactly seven method tokens; this one
 * accepts any three-to-seven-letter word followed by a token, so a `TRACE`, a lowercase `get`, or a
 * method the spec gains later is caught here and dropped there — and the disagreement is the
 * finding. Measured when this was written: over §34's fences the two readings agree exactly, so an
 * empty result is the parser reading every request line the section prints, not the recognizer
 * failing to look.
 *
 * It replaces `routes.size >= EXPECTED_ROUTES.length`, which was never about the parser at all. That
 * bound compared §34's fixed printed surface against the accumulating union of every task's declared
 * routes, and ADR-0026 makes it structurally false: a route §34 does not print ships legally with a
 * checkable mandate, so the declared surface is *permitted* to exceed §34's — and did, the first time
 * two tracks landed mandated routes in one sub-wave. See ADR-0043.
 */
export function unparsedRequestLines(spec: string): readonly string[] {
  const heading = /^# 34\. API Design$/m.exec(spec);
  if (heading === null) {
    throw new Error(
      `docs/spec.md has no "# 34. API Design" heading; the route inventory cannot be checked.`,
    );
  }
  const rest = spec.slice(heading.index + heading[0].length);
  const next = /^# /m.exec(rest);
  const section = next === null ? rest : rest.slice(0, next.index);
  const parsed = parseSpecRoutes(spec);
  const loose = /^\s*([A-Za-z]{3,7})\s+(\S+)/;
  const missed: string[] = [];
  for (const fence of section.matchAll(/```text\r?\n([\s\S]*?)```/g)) {
    for (const raw of (fence[1] ?? '').split('\n')) {
      const match = loose.exec(raw);
      if (match === null) continue;
      if (!parsed.has(`${(match[1] ?? '').toUpperCase()} ${match[2] ?? ''}`))
        missed.push(raw.trim());
    }
  }
  return missed;
}

/** {@link specRoutes} over text, so a fixture can prove where the section ends. */
export function parseSpecRoutes(spec: string): ReadonlySet<string> {
  const heading = /^# 34\. API Design$/m.exec(spec);
  if (heading === null) {
    throw new Error(
      `docs/spec.md has no "# 34. API Design" heading; the route inventory cannot be checked.`,
    );
  }
  const rest = spec.slice(heading.index + heading[0].length);
  const next = /^# /m.exec(rest);
  const section = next === null ? rest : rest.slice(0, next.index);
  const fences = [...section.matchAll(/```text\r?\n([\s\S]*?)```/g)];
  if (fences.length === 0) {
    throw new Error('spec §34 contains no ```text block; the route inventory cannot be checked.');
  }
  const routes = new Set<string>();
  const line = /^\s*(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)\s+(\S+)/;
  for (const fence of fences) {
    for (const raw of (fence[1] ?? '').split('\n')) {
      const match = line.exec(raw);
      if (match === null) continue;
      routes.add(`${match[1] ?? ''} ${match[2] ?? ''}`);
    }
  }
  if (routes.size === 0) {
    throw new Error('spec §34’s code block yielded no routes; the parser and the spec disagree.');
  }
  return routes;
}

/**
 * Every way one declared entry can fail ADR-0026, described so the owner can act on it.
 *
 * Four rules, each decided positively:
 *
 *   1. §34 does not print it and it carries no mandate — absence of a justification is not a
 *      justification (ADR-0015);
 *   2. §34 *does* print it and it carries a mandate — the two lists have drifted;
 *   3. the cited section is not a heading in `docs/spec.md` — a citation cannot be invented;
 *   4. the path breaks the shape rule — and the message says which of its rules.
 */
export function mandateFaults(
  entries: readonly RouteDeclaration[],
  spec: ReadonlySet<string>,
  sections: ReadonlySet<string>,
): string[] {
  const faults: string[] = [];
  for (const entry of entries) {
    const printed = spec.has(key(entry));
    const mandate = entry.mandate;
    if (!printed && mandate === undefined) {
      faults.push(
        `${key(entry)} (${entry.owner}): spec §34 does not print this route and it carries no ` +
          `mandate. Cite the section that requires the capability — ADR-0026 decision 2.`,
      );
    }
    if (printed && mandate !== undefined) {
      faults.push(
        `${key(entry)} (${entry.owner}): spec §34 prints this route, so it must not carry a ` +
          `mandate (it cites §${mandate.section}). A mandate here means the two lists have drifted.`,
      );
    }
    if (mandate !== undefined && !sections.has(mandate.section)) {
      faults.push(
        `${key(entry)} (${entry.owner}): cites §${mandate.section}, which is not a heading in ` +
          `docs/spec.md. A citation that cannot be looked up is not a mandate.`,
      );
    }
    const shape = routeShape(entry.path, printed);
    if (!shape.ok) {
      faults.push(
        `${key(entry)} (${entry.owner}): breaks the ${shape.rule} rule — ${shape.detail}`,
      );
    }
  }
  return faults.sort();
}

// ── The tracked tree ────────────────────────────────────────────────────────────────────────

/** One `export` statement this reader decoded: the name it binds, and the rest of its line. */
export interface ExportedBinding {
  /** The identifier the statement binds — `GET`, `runtime`. */
  readonly name: string;
  /** Everything after the `export` keyword, trimmed: `const runtime = 'nodejs';` */
  readonly declaration: string;
}

/**
 * Every name a module's `export` statements bind, in source order.
 *
 * Total over the forms, and **the fall-through throws**. That polarity is the point. Round 2 asked
 * the source one yes/no question per HTTP method — a regex per method, with no `else` — so an
 * export written in a spelling that regex could not see was dropped rather than refused: a verifier
 * handed it `export const { GET } = handlers;` next to an `export async function POST`, and the
 * reader returned `POST` alone and threw nothing. That is a route that ships a GET and is invisible
 * to the inventory, the one failure mode this whole file exists to prevent. Here every line that
 * begins with `export` is decided, and a form this reader cannot decode is a hard failure.
 *
 * Type-level exports are decided too, not skipped past: `export type`, `export interface` and
 * `export enum` bind no value, and Next.js serves nothing from one.
 */
export function exportedBindings(source: string, file: string): ExportedBinding[] {
  const out: ExportedBinding[] = [];
  for (const match of source.matchAll(/^[ \t]*export\b[ \t]*(.*)$/gm)) {
    const declaration = (match[1] ?? '').trim();
    if (/^(?:type|interface|enum)\b/.test(declaration)) continue;
    const value =
      /^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/.exec(declaration) ??
      /^class\s+([A-Za-z_$][\w$]*)/.exec(declaration) ??
      /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\b/.exec(declaration);
    if (value === null) {
      throw new Error(
        `${file}: "export ${declaration}" is an export form the route inventory cannot decode. It ` +
          `reads source text, so it cannot tell what that binds, and a form it cannot read would ` +
          `become a route nothing sees. Write each export as "export async function NAME(…)", ` +
          `"export const NAME = …", or a type.`,
      );
    }
    out.push({ name: value[1] as string, declaration });
  }
  return out;
}

/**
 * The HTTP methods a route file exports.
 *
 * Reads the file as text rather than importing it: a route module imports `@/…` aliases and, in a
 * later wave, framework-only modules, and this gate must keep working without a bundler. Every
 * export goes through {@link exportedBindings}, which refuses what it cannot decode; a re-export
 * (`export { GET } from …`) is named separately first, because that one has a specific repair.
 */
export function exportedMethods(source: string, file: string): ReadonlySet<HttpMethod> {
  if (/^\s*export\s*\{/m.test(source)) {
    throw new Error(
      `${file}: this route file re-exports its handlers with "export { … }". The route inventory ` +
        `reads source text and cannot follow that, so it would under-report the route's methods. ` +
        `Declare each handler with "export async function GET(…)" instead.`,
    );
  }
  const methods = new Set<string>(HTTP_METHODS);
  const found = new Set<HttpMethod>();
  for (const binding of exportedBindings(source, file)) {
    if (methods.has(binding.name)) found.add(binding.name as HttpMethod);
  }
  if (found.size === 0) {
    throw new Error(
      `${file}: a route file that exports no HTTP method serves nothing. Delete it or export one.`,
    );
  }
  return found;
}

/**
 * The string a route file exports under `name`, or `null` if it exports no such name.
 *
 * `null` is the one thing this reader returns without deciding a value, and the caller reports it —
 * "the file declares nothing" and "the file declares something this gate cannot evaluate" read
 * differently to whoever has to fix them. The second is a throw here: an export whose initializer
 * is not a single quoted string is a value a source-text reader must not guess at.
 */
export function exportedStringConstant(source: string, name: string, file: string): string | null {
  const binding = exportedBindings(source, file).find((entry) => entry.name === name);
  if (binding === undefined) return null;
  const literal = new RegExp(`^(?:const|let|var)\\s+${name}\\s*=\\s*(['"])(.*)\\1;?$`).exec(
    binding.declaration,
  );
  if (literal === null) {
    throw new Error(
      `${file}: exports "${name}" as "${binding.declaration}", a value this gate cannot evaluate — ` +
        `it reads source text. Next.js reads this export as a constant, so write it as one.`,
    );
  }
  return literal[2] as string;
}

/**
 * Every line of a route file that names `ReadableStream` in code, as `path:line`.
 *
 * The rule spec §19.5 rule 5 gives is "no second implementation", and the identifier is what says
 * a file has one. Round 2 asked for the single spelling `new ReadableStream`, and round 3's
 * counter-example appended `new globalThis.ReadableStream<Uint8Array>({ start() {} })` to a real
 * route file with the gate staying green at 35 passed. That predicate answers false on the aliased
 * form `const S = ReadableStream; const body = new S();` too — run, not assumed.
 *
 * A line that is *entirely* a comment is exempt, because naming the rule is how
 * `apps/web/app/api/runs/[id]/events/route.ts` states it. A trailing comment on a line of code is
 * not exempt: that is the fail-closed direction, and the repair is to move the comment.
 */
export function streamOffenders(files: readonly RouteFile[]): string[] {
  const offenders: string[] = [];
  for (const file of files) {
    file.source.split('\n').forEach((line, index) => {
      if (!/\bReadableStream\b/.test(line)) return;
      if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) return;
      offenders.push(`${file.repoPath}:${index + 1}`);
    });
  }
  return offenders;
}

/** One route handler, as this gate sees it: where it lives, and what is in it. */
export interface RouteFile {
  /** Repo-relative and forward-slashed, e.g. `apps/web/app/api/agents/route.ts`. */
  readonly repoPath: string;
  readonly source: string;
}

/**
 * Reduce a list of repo-relative paths to the ones Next.js serves as route handlers.
 *
 * Pure, so the probe below can hand it a file that is not on disk. Two rules, both positive:
 * a path segment beginning `_` means Next serves nothing beneath it, and the file name is put
 * through {@link classifyAppFile}, which throws rather than skipping what it cannot decide.
 */
export function filterRouteFiles(
  paths: readonly string[],
  extensions: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  for (const file of paths) {
    if (!file.startsWith(`${APP_PREFIX}/`)) continue;
    const relative = file.slice(APP_PREFIX.length + 1);
    const segments = relative.split('/');
    const name = segments[segments.length - 1] ?? '';
    // Next.js ignores a folder whose name starts with `_`, so a route file under one serves
    // nothing and must not appear in the inventory. The rule is `underPrivateFolder` in
    // `tests/inventory-support.ts` rather than a test of its own here, because the screen
    // inventory asks it of the same tree and two answers to one question is one answer too many.
    if (underPrivateFolder(segments)) continue;
    if (classifyAppFile(name, extensions, file) === 'ignore') continue;
    out.push(file);
  }
  return out.sort();
}

/**
 * Every `METHOD /path` a set of route files serves.
 *
 * The one derivation the live gate and the probe both go through, so the probe proves something
 * about the code that actually decides the inventory.
 */
export function routeSurface(files: readonly RouteFile[]): ReadonlySet<string> {
  const found = new Set<string>();
  for (const file of files) {
    const relative = file.repoPath.slice(APP_PREFIX.length + 1);
    const dir = relative.split('/').slice(0, -1).join('/');
    const urlPath = urlPathOf(dir, file.repoPath);
    for (const method of exportedMethods(file.source, file.repoPath)) {
      found.add(`${method} ${urlPath}`);
    }
  }
  return found;
}

/** The tracked route handlers, read. A tracked file missing from the worktree throws. */
function trackedRouteFiles(): RouteFile[] {
  const extensions = pageExtensions();
  return filterRouteFiles(trackedFiles(APP_PREFIX), extensions).map((repoPath) => {
    const absolute = path.join(REPO_ROOT, repoPath);
    if (!existsSync(absolute)) {
      throw new Error(
        `${repoPath} is tracked by git but absent from the working tree, so this gate could not ` +
          `read the route it declares.`,
      );
    }
    return { repoPath, source: readFileSync(absolute, 'utf8') };
  });
}

const routeFiles = trackedRouteFiles();
const actual = routeSurface(routeFiles);
// Read at module scope, so an unreadable declaration file or a duplicated route is a hard failure
// of the whole gate rather than one red assertion among many. ADR-0025 §3 calls both hard failures
// and this is what makes that word true; the messages themselves are proved on fixtures below.
const declarationFiles = readDeclarationFiles(ROUTE_DECLARATIONS, 'routes');
const EXPECTED_ROUTES: readonly RouteDeclaration[] = expectedRoutes();

// ── The gate ────────────────────────────────────────────────────────────────────────────────

describe('the route inventory equals the declared subset of spec §34', () => {
  it('reads every declaration file the tracked tree holds, derived by shape', () => {
    // ADR-0027 §1. This assertion used to be a literal list of the two declaration files that
    // existed when it was written, which is the alternative ADR-0025 rejected in writing: five of
    // Wave 2b's six tracks add `tests/route-declarations/<TASK-ID>.ts`, that file is outside every
    // one of their `Owns` globs, and a literal here would have turned this gate red on all five
    // with no branch able to make it green. The set is now `git ls-files` plus the filename rule.
    //
    // It is derived a second time and from a *wider* pathspec than `readDeclarationFiles` uses,
    // because the failure this assertion exists to catch is the enumerating call going narrow: a
    // `git ls-files` that returned a shorter list would satisfy every assertion below by having
    // nothing left to compare. The shape rule throws rather than filtering, so a `README.md` in
    // the directory is a failure naming the file (proved on a fixture below).
    const derived = declarationPaths(ROUTE_DECLARATIONS, 'tests');
    expect(
      declarationFiles.map((file) => file.repoPath),
      `derived from \`git ls-files -- tests\`: ${derived.join(', ')}`,
    ).toEqual(derived);
    expect(derived.length, `${ROUTE_DECLARATIONS} tracks no declaration file`).toBeGreaterThan(0);
    // …and every one of them contributed. A file read but silently empty is the other way the
    // union goes short, and `readDeclarationArray` refuses it — this is the assertion that says so.
    expect(
      declarationFiles.filter((file) => file.entries.length === 0).map((file) => file.repoPath),
      'these declaration files were read but declared nothing',
    ).toEqual([]);
    expect(EXPECTED_ROUTES.length).toBeGreaterThan(0);
  });

  it('reads spec §34 and finds the routes it prints', () => {
    const routes = specRoutes();
    // A positive assertion that the parse worked, rather than a transcribed count that would rot
    // the next time §34 is amended, and rather than a comparison against the declared surface —
    // which ADR-0026 makes structurally false, since a route §34 does not print ships legally with
    // a mandate. See `unparsedRequestLines` and ADR-0043.
    expect(routes.has('GET /api/agents')).toBe(true);
    // Every request line §34 prints became a route, decided by a second and looser reading of the
    // same fences. A parser that silently dropped one would shrink the spec side of every
    // comparison in this file and turn a mandate fault into a pass — the fail-open shape ADR-0015
    // exists to stop.
    expect(
      unparsedRequestLines(readFileSync(SPEC_PATH, 'utf8')),
      'lines in §34’s fenced blocks that look like request lines and yielded no route',
    ).toEqual([]);
  });

  it('reads the specification’s headings, so a mandate citation can be looked up', () => {
    const sections = specSections();
    expect(sections.has('34')).toBe(true);
    expect(sections.has('19.5')).toBe(true);
    expect(sections.has('16')).toBe(true);
    expect(sections.has('999')).toBe(false);
  });

  it('declares no route without the specification’s mandate, and none against its shape', () => {
    expect(
      mandateFaults(EXPECTED_ROUTES, specRoutes(), specSections()),
      'ADR-0026: a route spec §34 does not print ships only with a checkable mandate, and every ' +
        'declared path obeys the shape rule',
    ).toEqual([]);
  });

  it('declares each route exactly once, across every declaration file', () => {
    // The union is built at module scope and throws on a duplicate, so reaching this line at all is
    // half the assertion. The other half is that the union really is the sum of the parts: a map
    // that silently overwrote would make the two agree by losing an entry.
    const declared = declarationFiles.reduce((total, file) => total + file.entries.length, 0);
    expect(EXPECTED_ROUTES.length).toBe(declared);
    expect(new Set(EXPECTED_ROUTES.map(key)).size).toBe(declared);
  });

  it('read every route file the tracked tree holds, derived by shape', () => {
    // The same repair as the declaration files above, and the same reason it was needed: this was
    // a literal list of the five route files that existed when it was written, and every Wave 2b
    // track that ships a route adds one — inside its own `Owns` globs, while this file is inside
    // nobody's but the integrator's. A literal member list is not a partition (ADR-0027 §1).
    //
    // Derived from a wider pathspec than `trackedRouteFiles` uses, so a `git ls-files` that
    // returned a shorter list is caught rather than satisfied, and through the same
    // `filterRouteFiles`, whose classifier throws on a `route.<unknown-ext>` rather than skipping
    // it. What makes the equality below mean something is that this set is non-empty and complete.
    const derived = filterRouteFiles(trackedFiles('apps/web'), pageExtensions());
    expect(
      routeFiles.map((file) => file.repoPath),
      `derived from \`git ls-files -- apps/web\`: ${derived.join(', ')}`,
    ).toEqual(derived);
    expect(derived.length, 'apps/web tracks no route handler at all').toBeGreaterThan(0);
    expect(actual.size).toBeGreaterThan(0);
  });

  it('serves exactly the routes declared as landed — no more, no fewer', () => {
    const landed = new Set(EXPECTED_ROUTES.filter((entry) => entry.landed).map(key));

    const undeclared = [...actual].filter((route) => !landed.has(route)).sort();
    const notLandedButPresent = EXPECTED_ROUTES.filter(
      (entry) => !entry.landed && actual.has(key(entry)),
    ).map((entry) => `${key(entry)} — set landed: true (owner ${entry.owner})`);

    expect(
      undeclared,
      'these route handlers exist but are declared by no file in tests/route-declarations/. Spec ' +
        '§34 says "expose a very small control-plane API"; add the entry to your task\'s own ' +
        'declaration file deliberately, or delete the route.\n' +
        (notLandedButPresent.length > 0
          ? `Some of them are already declared with landed: false —\n  ${notLandedButPresent.join('\n  ')}`
          : ''),
    ).toEqual([]);

    const missing = [...landed].filter((route) => !actual.has(route)).sort();
    expect(missing, 'these routes are declared as landed but no route handler serves them').toEqual(
      [],
    );
  });

  it('declares POST /api/builder/mcp as the one run-caller route (issue #1846)', () => {
    const runCaller = API_ROUTE_EXCLUSIONS.filter(
      (route) => route.because === 'run-caller route (per-run token, aw-control tools)',
    ).map(key);
    expect(runCaller).toEqual(['POST /api/builder/mcp']);
    const declared = EXPECTED_ROUTES.filter((entry) => key(entry) === 'POST /api/builder/mcp');
    expect(declared.map((entry) => entry.landed)).toEqual([true]);
  });

  it('serves all five agent routes of spec §34, and no sixth under /api/agents', () => {
    const five = [
      'POST /api/agents',
      'GET /api/agents',
      'GET /api/agents/:id',
      'PATCH /api/agents/:id',
      'DELETE /api/agents/:id',
    ];
    for (const route of five) {
      expect(actual.has(route), `spec §34 requires ${route}`).toBe(true);
    }
    // Everything currently served under /api/agents. No search, bulk or count endpoint can slip
    // in unnoticed, and the run route ADR-0013 puts here is allowed through only by its entry.
    const declaredUnderAgents = new Set(
      EXPECTED_ROUTES.filter((entry) => entry.path.startsWith('/api/agents')).map(key),
    );
    const servedUnderAgents = [...actual].filter((route) => route.includes(' /api/agents')).sort();
    expect(servedUnderAgents.filter((route) => !declaredUnderAgents.has(route))).toEqual([]);
  });

  it('serves the three run routes of spec §34 plus the security-mandated revocation operation, and nothing undeclared under /api/runs', () => {
    // W1-CP-04's slice, asserted here rather than in `apps/web/server/runs/routes.test.ts`, which
    // used to make the same claim over the whole `app/api` tree from inside one task's directory.
    // ADR-0019: a closed world over the tree is asserted once, where the tree is visible.
    for (const route of [
      'POST /api/agents/:id/runs',
      'GET /api/runs/:id',
      'GET /api/runs/:id/events',
    ]) {
      expect(actual.has(route), `spec §34 requires ${route}`).toBe(true);
    }
    expect(actual.has('POST /api/runs/:id'), 'the revocation operation must be served').toBe(true);
    // Everything currently served under /api/runs, allowed through only by its own declaration —
    // the same derivation the agents assertion above uses. A literal list stood here until
    // W9-RUNS-135 shipped the durable `GET /api/runs` its declaration file mandates and this
    // gate refused it by name; a closed world enumerated by a literal has not been partitioned
    // (ADR-0027, ADR-0025), and the declarations directory is where the partition lives.
    const declaredUnderRuns = new Set(
      EXPECTED_ROUTES.filter((entry) => entry.path.startsWith('/api/runs')).map(key),
    );
    const servedUnderRuns = [...actual].filter((route) => route.includes(' /api/runs')).sort();
    expect(servedUnderRuns.filter((route) => !declaredUnderRuns.has(route))).toEqual([]);
  });
});

describe('the partition fails closed, in both of the two ways it can fail open', () => {
  // ADR-0025 §3's two guards, executed rather than described. Both are proved against the same
  // functions the live gate went through at module scope, on synthetic inputs, so neither proof
  // needs a file planted in the repository — this file's oldest rule (ADR-0019 §4).

  it('refuses a declaration file that exports nothing readable', () => {
    // Four spellings of "nothing readable", each a different way a file could arrive empty-handed:
    // no export, a misnamed export, an array of no entries, and a body that is not data at all.
    // A gate that treated any of them as "this task ships no routes" would be deciding on the
    // absence of a negative (ADR-0015).
    expect(() =>
      readDeclarationArray(
        'export const other = [];\n',
        'tests/route-declarations/W9-XX-01.ts',
        'routes',
      ),
    ).toThrow(/exports no readable "routes" array/);
    expect(() =>
      readDeclarationArray(
        '// nothing here at all\n',
        'tests/route-declarations/W9-XX-01.ts',
        'routes',
      ),
    ).toThrow(/exports no readable "routes" array/);
    expect(() =>
      readDeclarationArray(
        'export const routes = [];\n',
        'tests/route-declarations/W9-XX-01.ts',
        'routes',
      ),
    ).toThrow(/declares no entries/);
    expect(() =>
      readDeclarationArray(
        'export const routes = [buildRoutes()];\n',
        'tests/route-declarations/W9-XX-01.ts',
        'routes',
      ),
    ).toThrow(/is not a value this reader can read/);
  });

  it('refuses a file in the declaration directory that is not a task’s declaration', () => {
    // ADR-0027 §2 and §3: the rule that enumerates the partition is a classifier, so a file at the
    // right path with the wrong shape is a hard failure naming it, never a skip. If it were a
    // filter over the `git ls-files` listing, each of these would be dropped and the gate would
    // stay green — which is how a literal member list came to look like the safer option.
    expect(() =>
      declarationOwner('tests/route-declarations/README.md', ROUTE_DECLARATIONS),
    ).toThrow(/holds one TypeScript declaration file per owning task/);
    expect(() => declarationOwner('tests/route-declarations/types.ts', ROUTE_DECLARATIONS)).toThrow(
      /"types" is not a task id/,
    );
    expect(() =>
      declarationOwner('tests/route-declarations/wave2/W2-CP-02.ts', ROUTE_DECLARATIONS),
    ).toThrow(/one flat directory of <TASK-ID>\.ts files/);
    expect(() => declarationOwner('tests/inventory-support.ts', ROUTE_DECLARATIONS)).toThrow(
      /is not under tests\/route-declarations\//,
    );
    // …and a real declaration file is accepted, so the classifier is not satisfied by rejecting
    // everything. `W2-CP-02` is a task that has not landed: the rule is about the shape of the
    // name, not about a list of the names that exist today.
    expect(declarationOwner('tests/route-declarations/W2-CP-02.ts', ROUTE_DECLARATIONS)).toBe(
      'W2-CP-02',
    );
  });

  it('refuses two files declaring the same route, and names both owners', () => {
    const first: DeclarationFile = {
      repoPath: 'tests/route-declarations/W2-CP-03.ts',
      owner: 'W2-CP-03',
      entries: [{ method: 'GET', path: '/api/files', owner: 'W2-CP-03', landed: false }],
    };
    const second: DeclarationFile = {
      repoPath: 'tests/route-declarations/W2-CP-04.ts',
      owner: 'W2-CP-04',
      entries: [{ method: 'GET', path: '/api/files', owner: 'W2-CP-04', landed: false }],
    };
    expect(() => unionRoutes([first, second])).toThrow(/W2-CP-03/);
    expect(() => unionRoutes([first, second])).toThrow(/W2-CP-04/);
    expect(() => unionRoutes([first, second])).toThrow(
      /GET \/api\/files is declared twice: by W2-CP-03 in tests\/route-declarations\/W2-CP-03\.ts and by W2-CP-04 in tests\/route-declarations\/W2-CP-04\.ts/,
    );
    // …and the same route declared once is not a duplicate, which is what stops the guard from
    // being satisfied by rejecting everything.
    expect(unionRoutes([first]).map(key)).toEqual(['GET /api/files']);
  });

  it('refuses a declaration file that speaks for another task', () => {
    expect(() =>
      validateRouteEntry(
        { method: 'GET', path: '/api/files', owner: 'W2-CP-03', landed: false },
        'tests/route-declarations/W2-CP-04.ts',
        'W2-CP-04',
      ),
    ).toThrow(/declares owner "W2-CP-03" in tests\/route-declarations\/W2-CP-04\.ts/);
  });

  it('refuses an entry whose fields are absent, mistyped, or unread', () => {
    const file = 'tests/route-declarations/W2-CP-03.ts';
    expect(() =>
      validateRouteEntry({ path: '/api/files', owner: 'W2-CP-03', landed: true }, file, 'W2-CP-03'),
    ).toThrow(/"method" must be a non-empty string/);
    expect(() =>
      validateRouteEntry(
        { method: 'FETCH', path: '/api/files', owner: 'W2-CP-03', landed: true },
        file,
        'W2-CP-03',
      ),
    ).toThrow(/is not an HTTP method Next\.js serves/);
    expect(() =>
      validateRouteEntry(
        { method: 'GET', path: '/api/files', owner: 'W2-CP-03' },
        file,
        'W2-CP-03',
      ),
    ).toThrow(/"landed" must be true or false/);
    expect(() =>
      validateRouteEntry(
        { method: 'GET', path: '/api/files', owner: 'W2-CP-03', landed: true, note: 'later' },
        file,
        'W2-CP-03',
      ),
    ).toThrow(/carries note, which no part of this gate reads/);
  });
});

describe('spec §34 is a shape rule, and an extra route cites its mandate', () => {
  // ADR-0026, proved on fixtures. The live declarations are checked by the gate above; these
  // establish that the checks the gate ran can actually refuse something.
  const spec = specRoutes();
  const sections = specSections();

  it('refuses a route §34 does not print when it carries no mandate', () => {
    const faults = mandateFaults(
      [{ method: 'POST', path: '/api/secrets', owner: 'W2-CP-02', landed: false }],
      spec,
      sections,
    );
    expect(faults).toEqual([
      'POST /api/secrets (W2-CP-02): spec §34 does not print this route and it carries no mandate. ' +
        'Cite the section that requires the capability — ADR-0026 decision 2.',
    ]);
  });

  it('accepts the same route once it cites a section the specification really has', () => {
    expect(
      mandateFaults(
        [
          {
            method: 'POST',
            path: '/api/secrets',
            owner: 'W2-CP-02',
            landed: false,
            mandate: { section: '23', because: 'Secrets are created and referenced by name.' },
          },
        ],
        spec,
        sections,
      ),
    ).toEqual([]);
  });

  it('refuses a mandate citing a section docs/spec.md does not have', () => {
    const faults = mandateFaults(
      [
        {
          method: 'POST',
          path: '/api/secrets',
          owner: 'W2-CP-02',
          landed: false,
          mandate: { section: '61', because: 'Invented, and nothing would have said so.' },
        },
      ],
      spec,
      sections,
    );
    expect(faults).toEqual([
      'POST /api/secrets (W2-CP-02): cites §61, which is not a heading in docs/spec.md. A citation ' +
        'that cannot be looked up is not a mandate.',
    ]);
  });

  it('refuses a mandate on a route §34 already prints', () => {
    const faults = mandateFaults(
      [
        {
          method: 'GET',
          path: '/api/agents',
          owner: 'W1-CP-05',
          landed: true,
          mandate: { section: '17', because: 'Agents are managed.' },
        },
      ],
      spec,
      sections,
    );
    expect(faults).toEqual([
      'GET /api/agents (W1-CP-05): spec §34 prints this route, so it must not carry a mandate (it ' +
        'cites §17). A mandate here means the two lists have drifted.',
    ]);
  });

  it('names the rule a badly shaped path broke, rather than saying "invalid"', () => {
    // ADR-0026 decision 3's own worked example, both halves: the rename that is admissible under
    // §16, and the RPC spelling that is not.
    expect(routeShape('/api/files/:id/rename', false)).toEqual({ ok: true });
    expect(routeShape('/api/renameFile', false)).toMatchObject({ ok: false, rule: 'shape' });
    expect(routeShape('/api/rename', false)).toMatchObject({ ok: false, rule: 'plural-resource' });
    expect(routeShape('/api/exports', false)).toMatchObject({ ok: false, rule: 'no-verb' });
    expect(routeShape('/api/files/:id/versions/:vid', false)).toMatchObject({
      ok: false,
      rule: 'shape',
    });
    expect(routeShape('/api/files/latest', false)).toMatchObject({ ok: false, rule: 'shape' });
    // Outside /api/ is decided by the specification, not by this shape: §34 prints the public
    // pages under /p/, and nothing else may invent a prefix.
    expect(routeShape('/p/:token', true)).toEqual({ ok: true });
    expect(routeShape('/p/:token', false)).toMatchObject({ ok: false, rule: 'outside-api' });
    expect(routeShape('/internal/metrics', false)).toMatchObject({
      ok: false,
      rule: 'outside-api',
    });
    // Issue #233's named exception, and the proof that it is one literal rather than a relaxed
    // rule: `/api/me` passes, and every other singular resource — including the ones a general
    // "singleton resource" rule would have admitted — still fails `plural-resource`.
    expect(routeShape('/api/me', false)).toEqual({ ok: true });
    // ADR-0135's two A2A literals pass; a neighbouring shape does not.
    expect(routeShape('/api/a2a/agents/:agentName', false)).toEqual({ ok: true });
    expect(routeShape('/api/a2a/agents/:agentName/.well-known/agent-card.json', false)).toEqual({
      ok: true,
    });
    expect(routeShape('/api/a2a/agents/:agentName/tasks', false)).toMatchObject({ ok: false });
    expect(routeShape('/api/a2a/agents', false)).toMatchObject({ ok: false });
    for (const singular of ['/api/session', '/api/config', '/api/whoami', '/api/me/:id/tokens']) {
      expect(routeShape(singular, false), singular).toMatchObject({
        ok: false,
        rule: 'plural-resource',
      });
    }
    // And the shapes §34 actually uses all pass, so the rule is not merely a rejecter.
    for (const admissible of [
      '/api/agents',
      '/api/agents/:id',
      '/api/agents/:id/runs',
      '/api/model-connections',
      '/api/runtime-profiles',
    ]) {
      expect(routeShape(admissible, true), admissible).toEqual({ ok: true });
    }
  });
});

describe('every route handler in the repository, whoever wrote it', () => {
  // These two invariants arrived as loops inside `apps/web/server/runs/routes.test.ts`, W1-CP-04's
  // file, where they ranged over every route under `apps/web/app/api` — including the two agent
  // route files W1-CP-05 owns, which is how they came to fail on the Wave 1a union. They are
  // repository-wide claims and they are correct; ADR-0019 says the fix is to move them to where
  // the whole tree is visible, not to narrow them to their author's subtree.

  it('runs every route on the Node runtime and never prerenders one', () => {
    // 'edge' is deprecated and cannot hold a long-lived stream (R-13). `force-dynamic` is what
    // stops Next from prerendering a handler that reads a session cookie.
    //
    // Read as exports, not as text the file happens to contain. Round 2 asked each file whether it
    // `includes` the two declarations spelled out in full, and round 3's counter-example turned the
    // real `apps/web/app/api/agents/route.ts` into `export const runtime = 'edge';` with the nodejs
    // spelling left above it on a commented-out line: the gate stayed at 35 passed.
    const wrong: string[] = [];
    for (const file of routeFiles) {
      for (const [name, required] of [
        ['runtime', 'nodejs'],
        ['dynamic', 'force-dynamic'],
      ] as const) {
        const declared = exportedStringConstant(file.source, name, file.repoPath);
        if (declared !== required) {
          wrong.push(`${file.repoPath}: ${name} is ${declared ?? 'not exported'}, not ${required}`);
        }
      }
    }
    expect(wrong, 'route files that do not declare their runtime').toEqual([]);
  });

  it('keeps the streaming pattern out of the route files', () => {
    // Spec §19.5 rule 5 forbids a second chat implementation; the same rule is applied to the
    // stream. A route handler that builds its own ReadableStream is a second SSE implementation
    // and the next one copied from it will drift.
    //
    // The rule is the identifier on a line of code, not the one spelling `new ReadableStream`.
    // Round 3 appended `new globalThis.ReadableStream<Uint8Array>({ start() {} })` to
    // `apps/web/app/api/runs/[id]/route.ts` and the gate stayed at 35 passed. A line that is
    // entirely a comment is exempt,
    // because naming the rule is how `apps/web/app/api/runs/[id]/events/route.ts` states it — a
    // trailing comment on a line of code is not exempt, which is the fail-closed direction.
    expect(streamOffenders(routeFiles), 'route files that build their own stream').toEqual([]);
  });
});

describe('the set of files treated as route handlers is derived, not transcribed', () => {
  it('refuses to guess when apps/web configures a pageExtensions of its own', () => {
    const extensions = pageExtensions();
    // Positive assertions about the extensions that decide this gate's blind spots. `jsx` is
    // named literally because omitting it is the defect this describe block exists to prevent:
    // `apps/web/app/api/agents/sneaky/route.jsx` was served by Next (`next typegen` emitted
    // "/api/agents/sneaky") while the gate stayed green at 13/13.
    expect(extensions.has('jsx')).toBe(true);
    expect(extensions.has('ts')).toBe(true);
    expect([...extensions].sort()).toEqual([...DEFAULT_PAGE_EXTENSIONS].sort());
    // And the guard that makes the line above an assertion rather than an assumption: the config
    // this gate read really does leave the knob unset, checked by reading it.
    const configs = NEXT_CONFIG_FILENAMES.map((name) => path.join(WEB_DIR, name)).filter((file) =>
      existsSync(file),
    );
    expect(configs.map((file) => path.basename(file))).toEqual(['next.config.ts']);
    expect(readFileSync(configs[0] as string, 'utf8')).not.toContain(PAGE_EXTENSIONS_KNOB);
  });

  it('treats every configured extension as a route handler, and rejects the rest', () => {
    const extensions = pageExtensions();
    for (const extension of extensions) {
      expect(classifyAppFile(`route.${extension}`, extensions, 'x'), `route.${extension}`).toBe(
        'route',
      );
    }
    // Not a route file name at all: skipped quietly, which is correct — Next serves neither as a
    // route handler and neither is called `route.*`.
    expect(classifyAppFile('page.tsx', extensions, 'x')).toBe('ignore');
    expect(classifyAppFile('layout.tsx', extensions, 'x')).toBe('ignore');
    // Named `route.*` but not an extension this application serves. Rejected loudly rather than
    // skipped: the reader cannot decide, so it must not decide "not a route". `route.mjs` is the
    // concrete case — the previous hand-written list read it, and `next typegen` proves Next does
    // not serve it under the default pageExtensions.
    expect(() => classifyAppFile('route.mjs', new Set(['tsx', 'ts', 'jsx', 'js']), 'x')).toThrow(
      /not one of the pageExtensions/,
    );
    expect(() => classifyAppFile('route.test.ts', extensions, 'x')).toThrow(
      /not one of the pageExtensions/,
    );
    expect(() => classifyAppFile('route.', extensions, 'x')).toThrow(
      /not one of the pageExtensions/,
    );
  });

  it('excludes every tracked page file, which is the screen inventory’s half', () => {
    // Stated in this file's header since W1-INT-02 — "`page.tsx` is a screen, not an API route" —
    // and asserted here since W2-INT-00, over the real tracked pages rather than one literal name.
    // `tests/screen-inventory.test.ts` asserts the other direction: that each of these pages is
    // declared as a screen. Neither gate may quietly stop seeing what the other assumes it sees,
    // and since the repair of ADR-0027 they read the page set through one function —
    // `filterPageFiles`, the twin of `filterRouteFiles` — rather than each applying its own filter.
    const extensions = pageExtensions();
    const pages = filterPageFiles(trackedFiles(APP_PREFIX), extensions);
    expect(pages.length, 'apps/web/app tracks no page file at all').toBeGreaterThan(0);
    expect(filterRouteFiles(pages, extensions), 'a page is not a route handler').toEqual([]);
  });

  it('reports an undeclared route.jsx that Next.js would serve', () => {
    // The acceptance criterion, executed rather than asserted in prose: hand the live gate's own
    // two functions the exact file that defeated the first version of this gate — a `route.jsx`
    // under `apps/web/app/api/agents/` — and prove it is seen, and that it is not in the union of
    // the declaration files, which is what turns the equality assertion above red.
    //
    // It is a synthetic entry rather than a real file on disk, and that is the whole repair of the
    // Wave 1a race: the previous version planted it under `apps/web/app/api/agents/` with
    // `mkdtempSync` while `tests/auth.test.ts` was walking that directory in a parallel worker.
    // See ADR-0019 §4 and this file's header.
    const probePath = `${APP_PREFIX}/api/agents/inventory-probe/route.jsx`;
    const kept = filterRouteFiles(
      [...routeFiles.map((file) => file.repoPath), probePath],
      pageExtensions(),
    );
    expect(kept, 'the filter must not drop a route.jsx').toContain(probePath);

    const withProbe = routeSurface([
      ...routeFiles,
      {
        repoPath: probePath,
        source: 'export async function GET() { return new Response("undeclared"); }\n',
      },
    ]);
    const probeRoute = 'GET /api/agents/inventory-probe';
    expect([...withProbe]).toContain(probeRoute);

    const landed = new Set(EXPECTED_ROUTES.filter((entry) => entry.landed).map(key));
    expect(landed.has(probeRoute)).toBe(false);
    expect([...withProbe].filter((route) => !landed.has(route))).toEqual([probeRoute]);

    // …and the real surface, with no probe in it, is exactly the declared one. This is the same
    // comparison the gate makes above, repeated here so that the two halves of the proof — "the
    // probe is reported" and "nothing else is" — sit next to each other.
    expect([...actual].filter((route) => !landed.has(route))).toEqual([]);
  });

  it('does not report a route file that Next.js serves from no URL', () => {
    // The other side of the filter: a `route.ts` under an underscore-prefixed folder is not
    // served, and a gate that reported it would fail on a file that ships nothing.
    const hidden = `${APP_PREFIX}/api/_hidden/leak/route.ts`;
    expect(filterRouteFiles([hidden], pageExtensions())).toEqual([]);
  });

  it('writes nothing into the repository tree', () => {
    // Asserted mechanically, not promised in a comment. The Wave 1a race was this file planting a
    // fixture under `apps/web/app` while a sibling walked it; the repair is structural, and this
    // is the assertion that keeps it structural. `readFileSync` and `existsSync` are the only fs
    // calls it needs.
    //
    // The scanned set is this gate's import graph. Round 2 wrote the two file names down instead,
    // and a verifier walked out of the list: a tracked `tests/inventory-extra.ts` holding a
    // `mkdirSync` call, imported from `tests/inventory-support.ts`, left both gates at 61 passed.
    const modules = gateModules('tests/route-inventory.test.ts');
    expect(modules, 'the import scan found no module beyond the gate itself').not.toEqual([
      'tests/route-inventory.test.ts',
    ]);
    for (const module of modules) {
      const source = readFileSync(path.join(REPO_ROOT, module), 'utf8');
      expect(
        nonReadingFsAccess(source),
        `${module} must not mutate the tree it asserts over — ADR-0019 §4`,
      ).toEqual([]);
    }
  });
});

describe('the inventory’s own readers fail rather than under-report', () => {
  it('rejects a route file that exports no HTTP method', () => {
    expect(() => exportedMethods('export const revalidate = 0;\n', 'x/route.ts')).toThrow(
      /exports no HTTP method/,
    );
  });

  it('rejects re-exported handlers instead of silently missing them', () => {
    expect(() => exportedMethods("export { GET } from './handlers';\n", 'x/route.ts')).toThrow(
      /re-exports its handlers/,
    );
  });

  it('reads all three declaration forms Next.js documents', () => {
    const source = [
      'export async function GET(request: Request) { return new Response(); }',
      'export function HEAD() { return new Response(); }',
      'export const POST = () => new Response();',
    ].join('\n');
    expect([...exportedMethods(source, 'x/route.ts')].sort()).toEqual(['GET', 'HEAD', 'POST']);
  });

  it('reports every way of reaching fs that is not a read', () => {
    // The table the ADR-0019 §4 assertion above rests on. A reader passes; every other form is
    // either named or refused as undecodable, which is what makes the allowlist's polarity hold —
    // round 2's list of seven mutator verbs missed `unlinkSync` and `copyFileSync` outright.
    //
    // Every specifier below is joined at run time, for the reason `tests/no-sdk-import.test.ts`
    // gives for its own tables: `nonReadingFsAccess` is run over this file too, and a fixture that
    // spelled the module out would report this gate to itself. The first draft of this test did,
    // and the run said so. The two call keywords are split for a second reason: written whole,
    // `tests/no-sdk-import.test.ts` reads them as module references whose argument it cannot
    // resolve and fails — which it also did, on the draft before this one.
    const node = `'node${':fs'}'`;
    const promises = `'node${':fs/promises'}'`;
    const bare = `'${'f' + 's'}'`;
    const undecodable = /reached by a form this reader cannot decode/;
    expect(nonReadingFsAccess(`import { readFileSync } from ${node};\n`)).toEqual([]);
    expect(nonReadingFsAccess(`import { unlinkSync } from ${node};\n`)).toEqual(['unlinkSync']);
    expect(nonReadingFsAccess(`import { rmSync as nuke } from ${node};\n`)).toEqual(['rmSync']);
    expect(nonReadingFsAccess(`import { writeFile } from ${promises};\n`)).toEqual(['writeFile']);
    for (const form of [
      `import * as anyName from ${node};\n`,
      `export { readFileSync } from ${node};\n`,
      `const anyName = requir${'e'}(${bare});\n`,
      `const anyName = await imp${'ort'}(${node});\n`,
    ]) {
      const reported = nonReadingFsAccess(form);
      expect(reported, form).toHaveLength(1);
      expect(reported[0], form).toMatch(undecodable);
    }
  });

  it('follows a relative module reference in every form it can be written', () => {
    // The table behind `gateModules`, and the escape a verifier drove through it in round 3.
    // `relativeSpecifiers` read a line-start `from` clause and a line-start bare import and
    // nothing else, so a top-level dynamic import of a plain relative literal left the module it
    // named outside the ADR-0019 §4 scan: a tracked helper holding a `mkdirSync`, reached that
    // way, kept both gates green. `tests/no-sdk-import.test.ts` refuses any resolver call in this
    // tree whose argument is not a plain quoted string, so reading the literal covers every call
    // form the repository accepts at all.
    //
    // Each fixture interpolates its specifier rather than spelling it. That is not decoration:
    // `gateModules` scans this file too, and a fixture that wrote the path out would be a module
    // reference this gate then had to resolve — which is the shape that made an earlier draft of
    // `relativeSpecifiers` throw on its own test file.
    const sibling = './inventory-support.js';
    for (const form of [
      `import { REPO_ROOT } from '${sibling}';`,
      `import type { RouteDeclaration } from '${sibling}';`,
      `import {\n  REPO_ROOT,\n} from '${sibling}';`,
      `export { REPO_ROOT } from '${sibling}';`,
      `export * from '${sibling}';`,
      `import '${sibling}';`,
      `import { REPO_ROOT } from "${sibling}";`,
      `const helper = await import('${sibling}');`,
      `const helper = require('${sibling}');`,
      `const where = require.resolve('${sibling}');`,
      `const where = import.meta.resolve('${sibling}');`,
    ]) {
      expect(relativeSpecifiers(form), form).toEqual([sibling]);
    }
    // …and it is not satisfied by matching everything. A package specifier names no file in this
    // repository and is decided by `nonReadingFsAccess` instead; prose naming a path is not a
    // module reference; and the bound on the `from` clause still holds, so an import statement
    // above a fixture string cannot reach into it.
    expect(relativeSpecifiers("import { describe } from 'vitest';\n")).toEqual([]);
    expect(relativeSpecifiers(` * see ${sibling} for the reader\n`)).toEqual([]);
    expect(relativeSpecifiers(`import path from 'node:path';\nconst s = '${sibling}';\n`)).toEqual(
      [],
    );
  });

  it('refuses an export form it cannot decode rather than dropping the handler', () => {
    // The round-2 reader asked one yes/no question per method and dropped what it could not spell.
    // Each of these ships a GET that a per-method regex cannot see.
    const destructured = [
      'const handlers = { GET: () => new Response("x") };',
      'export const { GET } = handlers;',
      'export async function POST() { return new Response("y"); }',
    ].join('\n');
    expect(() => exportedMethods(destructured, 'x/route.ts')).toThrow(/cannot decode/);
    expect(() => exportedMethods('export default function GET() {}\n', 'x/route.ts')).toThrow(
      /cannot decode/,
    );
    expect(() => exportedMethods("export * from './handlers';\n", 'x/route.ts')).toThrow(
      /cannot decode/,
    );
  });

  it('reads a type-level export as binding no handler, and says so by name', () => {
    const source = [
      'export type GET = never;',
      'export interface POST { x: 1 }',
      'export async function DELETE() { return new Response(); }',
    ].join('\n');
    expect([...exportedMethods(source, 'x/route.ts')]).toEqual(['DELETE']);
  });

  it('refuses a runtime declaration whose value it cannot evaluate', () => {
    const source = 'export const runtime = RUNTIME;\nexport function GET() {}\n';
    expect(() => exportedStringConstant(source, 'runtime', 'x/route.ts')).toThrow(
      /cannot evaluate/,
    );
    // Absent is not the same failure as unreadable, and the caller reports it differently.
    expect(exportedStringConstant('export function GET() {}\n', 'runtime', 'x/route.ts')).toBe(
      null,
    );
    // And a commented-out declaration is not a declaration — the escape round 3 drove a real route
    // file through, running it on 'edge' while the round-2 gate read the comment above it.
    const commented = [
      "// export const runtime = 'nodejs';",
      "export const runtime = 'edge';",
      'export function GET() {}',
    ].join('\n');
    expect(exportedStringConstant(commented, 'runtime', 'x/route.ts')).toBe('edge');
  });

  it('sees a stream built through any name, and lets a comment name the rule', () => {
    const built = (source: string): string[] =>
      streamOffenders([{ repoPath: 'x/route.ts', source }]);
    expect(built('const body = new ReadableStream();\n')).toEqual(['x/route.ts:1']);
    expect(built('const body = new globalThis.ReadableStream();\n')).toEqual(['x/route.ts:1']);
    expect(built('const S = ReadableStream;\nconst body = new S();\n')).toEqual(['x/route.ts:1']);
    expect(built(' * Copy the import, not the ReadableStream.\n')).toEqual([]);
    expect(built('// no ReadableStream here\n')).toEqual([]);
  });

  it('reads spec §34’s own fence, not the next section’s', () => {
    // §34 prints nothing parseable and §35 prints routes: the answer is a refusal, not §35's list.
    // Round 2 sliced to end of file; retagging §34's fence and moving its lines down into §35 left
    // the gate passing at 35 of 35 with §34 printing no route.
    const spec = [
      '# 34. API Design',
      '',
      '```http',
      'GET /api/agents',
      '```',
      '',
      '# 35. Observability',
      '',
      '```text',
      'GET /api/observability',
      '```',
      '',
    ].join('\n');
    expect(() => parseSpecRoutes(spec)).toThrow(/contains no/);
    // Two fences inside §34 are both read, so "which one" is not a question this parser answers.
    const two = [
      '# 34. API Design',
      '',
      '```text',
      'notes, not routes',
      '```',
      '',
      '```text',
      'GET /api/agents',
      '```',
      '',
      '# 35. Observability',
      '',
    ].join('\n');
    expect([...parseSpecRoutes(two)]).toEqual(['GET /api/agents']);
  });

  it('does not mistake a non-exported or differently named function for a handler', () => {
    const source = [
      'function GET() { return null; }',
      'const PATCH = 1;',
      'export const GETTER = () => new Response();',
      'export async function GET() { return new Response(); }',
    ].join('\n');
    expect([...exportedMethods(source, 'x/route.ts')]).toEqual(['GET']);
  });

  it('maps a dynamic segment to the specification’s notation and drops a route group', () => {
    expect(urlPathOf('api/agents/[id]', 'f')).toBe('/api/agents/:id');
    expect(urlPathOf('(shell)/api/agents', 'f')).toBe('/api/agents');
  });

  it('rejects segment shapes §34 does not use, rather than treating them as literals', () => {
    expect(() => urlPathOf('api/[...rest]', 'f')).toThrow(/catch-all/);
    expect(() => urlPathOf('api/[[...rest]]', 'f')).toThrow(/optional catch-all/);
    expect(() => urlPathOf('api/@modal', 'f')).toThrow(/parallel routes/);
    expect(() => urlPathOf('api/we ird', 'f')).toThrow(/segment shape/);
  });

  it('fails when the specification section it reads cannot be found', () => {
    // Asserted indirectly: the parser throws on a missing heading, so a spec rename fails this
    // gate loudly instead of turning every membership check into a vacuous pass.
    expect(() => specRoutes()).not.toThrow();
    expect(specRoutes().size).toBeGreaterThan(0);
  });

  it('the landed flag still decides something, with no entry left that uses it', () => {
    // Wave 1 flipped the last `landed: false` entry to `true`, so the branch that flag controls is
    // no longer taken by any real entry. A field nothing exercises is a field that rots into a
    // decoration, and the next wave would then declare a route with `landed: false` and get a
    // silent pass. So the two directions are exercised on a fixture: an entry declared but absent
    // is "missing", and the same entry present is "undeclared" until the flag is flipped.
    const fixture: readonly RouteDeclaration[] = [
      { method: 'GET', path: '/api/models', owner: 'W2-XX-01', landed: false },
    ];
    const served = new Set(['GET /api/models']);
    const landed = new Set(fixture.filter((entry) => entry.landed).map(key));
    expect([...served].filter((route) => !landed.has(route))).toEqual(['GET /api/models']);
    expect(
      fixture.filter((entry) => !entry.landed && served.has(key(entry))).map(key),
      'an entry marked landed: false whose route file has appeared must be reported',
    ).toEqual(['GET /api/models']);

    const flipped: readonly RouteDeclaration[] = fixture.map((entry) => ({
      ...entry,
      landed: true,
    }));
    const flippedLanded = new Set(flipped.filter((entry) => entry.landed).map(key));
    expect([...served].filter((route) => !flippedLanded.has(route))).toEqual([]);
    expect([...flippedLanded].filter((route) => !served.has(route))).toEqual([]);
    // And a route declared as landed that nothing serves is reported as missing.
    expect([...flippedLanded].filter((route) => !new Set<string>().has(route))).toEqual([
      'GET /api/models',
    ]);
  });
});
