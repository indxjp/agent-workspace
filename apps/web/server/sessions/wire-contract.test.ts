/**
 * The cross-package **wire contract** gate for spec §20's session-state API (ENG-06, #305).
 *
 * ## Why this file exists
 *
 * `state.ts` and `@agent-workspace/engine`'s `EngineSessionStore` restate the same store shape in
 * two nominally unrelated declarations, and `apps/runner/src/session-state.ts` and
 * `apps/web/server/sessions/state-api.ts` then restate the same **HTTP wire format** — paths, query
 * parameter names, request-body field names, response-body field names — once on each side.
 * `apps/web` does not depend on `@agent-workspace/runner` and cannot: its manifest is not this
 * task's file (ADR-0017), and a deep relative import into a sibling app would put an edge in the
 * build graph that no manifest declares.
 *
 * ENG-06 retargeted this gate when the client moved from `session.ts`'s Claude-shaped transcript
 * mirror to `session-state.ts`'s engine-neutral store. The machinery is unchanged; what it reads and
 * what it replays are the new file and the new routes, because a gate left pointing at the file that
 * no longer speaks to the control plane is a gate that has stopped checking anything.
 *
 * Until this gate existed, the header of `transcript.ts` and gap 6 of W2-CP-07's PR both claimed
 * the compiler was watching that duplication — *"session.ts builds a TranscriptMirror out of the
 * wire format transcript.ts defines, so a divergence stops it compiling"*. **That was not true.**
 * `session.ts` imports nothing from `apps/web`; a verifier renamed the `subkeys` field of one
 * response on the `apps/web` side, updated `api.test.ts` in lockstep as a maintainer would, and
 * `pnpm typecheck`, `pnpm lint` and all 1 059 tests stayed green while resume broke against a
 * real model. ADR-0016: an artefact must not assert behaviour that is not so, and the fix for a
 * claim like that is to make it true or to delete it. This file makes it true.
 *
 * ## How it works — three sources, compared, none of them trusted
 *
 * | source | how it is read |
 * | --- | --- |
 * | the client, `apps/runner/src/session-state.ts` | as **text**, parsed with the TypeScript AST |
 * | its route declarations, `tests/route-declarations/ENG-06-SESSION-STATE-305.ts` | the same way |
 * | the handlers in `./state-api` | **executed**, against a real store and a real principal |
 *
 * Reading a sibling package's source as text to stop a restatement drifting is the pattern this
 * repository already uses — `apps/web/server/runs/store.test.ts` reads
 * `packages/core/src/db/schema/runs.ts` for exactly this reason. The AST rather than a regular
 * expression is ADR-0030's rule applied to the same problem one level down: a property name is a
 * node, not a substring, so an escape or a reformat cannot walk past it.
 *
 * The declarations file is the third source because it is what `tests/route-inventory.test.ts`
 * checks the real App Router files against. Comparing the mirror's paths to it therefore reaches
 * the route files themselves, without this test having to know where they live.
 *
 * ## What it does not cover, stated rather than implied
 *
 * ADR-0031 — a static check cannot be complete, and this one is bounded in three ways worth
 * naming, because a reader who believes it covers more will stop worrying about more:
 *
 *  1. It compares the **wire**, not the two TypeScript declarations. `TranscriptStore` and
 *     `TranscriptMirror` are still two hand-written types with no compiler edge between them, and
 *     a member added to one and not the other is invisible here **unless the wire exercises it**.
 *     Every member the wire does exercise is replayed below.
 *  2. The mirror's vocabulary is extracted from four syntactic forms — an `/api/…` string or
 *     template, a `URLSearchParams` name, a property name under `JSON.stringify`, and a string
 *     used as an element access. A wire name the mirror built some other way is not seen. Each
 *     extractor **fails the gate when it finds nothing** rather than passing vacuously, which is
 *     the one failure mode of a check that cannot run (ADR-0015).
 *  3. Path and method are compared as sets, not as pairs; the pairing is what the replay below
 *     exercises, one handler at a time.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createInMemoryWorkspaceScopeResolver,
  type SessionRecord,
  type SessionRepositoryProvider,
} from '@agent-workspace/core/db';

import { installSessionApi, resetSessionApi, type SessionPrincipal } from './environment';
import { InMemoryTranscriptStore } from './memory-store';
import { InMemorySessionStateStore } from './state-memory-store';
import {
  appendSessionState,
  deleteSessionState,
  listSessionStateEntries,
  listSessionStateStreams,
  replaceSessionState,
} from './state-api';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIRROR_SOURCE = path.join(HERE, '../../../runner/src/session-state.ts');
const ROUTE_DECLARATIONS = path.join(
  HERE,
  '../../../../tests/route-declarations/ENG-06-SESSION-STATE-305.ts',
);

const WORKSPACE = 'c8b1f0de-6a2e-4a1f-9d3b-000000000001';
const USER = 'c8b1f0de-6a2e-4a1f-9d3b-000000000009';
const SESSION = '11111111-2222-4333-8444-555555555555';
const SUBPATH = 'subagents/agent-1';
const ENGINE = 'claude-agent-sdk';
const STREAM_KEY = `${WORKSPACE}/`;
/**
 * Paths and methods the control plane serves on this family and the client never calls.
 *
 * Both are empty, and that is the claim: every route ENG-06 declares is a route the runner's store
 * actually speaks. A future route this family gains without a client is a decision that has to be
 * written here rather than passing unnoticed.
 */
const CONTROL_PLANE_ONLY_PATHS = new Set<string>();
const CONTROL_PLANE_ONLY_METHODS = new Set<string>();
const PRINCIPAL: SessionPrincipal = {
  kind: 'user',
  principalId: USER,
  ownerPrincipalId: USER,
  userId: USER,
  workspaceId: WORKSPACE,
  role: 'builder',
};

// ── Reading a source file as a tree ──────────────────────────────────────────────────────

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ES2023, true);
}

/** Every node in `root`, depth first. */
function* walk(root: ts.Node): Generator<ts.Node> {
  yield root;
  for (const child of root.getChildren()) yield* walk(child);
}

/** The cooked text of a string-ish literal, or `null` when the node is not one. */
function literalText(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

/**
 * A URL template with its interpolations replaced by `{}` — `/api/sessions/{}/transcript`.
 *
 * Returns `null` for anything whose *first* chunk does not begin `/api/`, which is what keeps
 * `` `${path}?${query}` `` (a template that starts with a hole) out of the path set: it composes
 * a path, it does not name one.
 */
function urlPattern(node: ts.Node): string | null {
  let text: string;
  if (ts.isTemplateExpression(node)) {
    text = node.head.text;
    for (const span of node.templateSpans) text += `{}${span.literal.text}`;
  } else {
    const literal = literalText(node);
    if (literal === null) return null;
    text = literal;
  }
  if (!text.startsWith('/api/')) return null;
  // The query half is compared through `queryNames` below, not as part of the path.
  const [pathOnly = ''] = text.split('?');
  return pathOnly;
}

/** The property names of every object literal inside `root`, including nested ones. */
function propertyNames(root: ts.Node): string[] {
  const names: string[] = [];
  for (const node of walk(root)) {
    if (!ts.isObjectLiteralExpression(node)) continue;
    for (const property of node.properties) {
      const name = property.name;
      if (name === undefined) continue;
      if (ts.isIdentifier(name) || ts.isStringLiteral(name)) names.push(name.text);
    }
    // `{ ...spread }` carries no name here; the spread's own object literal is walked above.
  }
  return names;
}

interface MirrorWire {
  readonly paths: ReadonlySet<string>;
  readonly methods: ReadonlySet<string>;
  readonly queryNames: ReadonlySet<string>;
  readonly requestBodyNames: ReadonlySet<string>;
  readonly responseNames: ReadonlySet<string>;
}

/**
 * The wire vocabulary `apps/runner/src/session-state.ts` actually speaks, read off its syntax tree.
 *
 * Nothing here is matched against an expected list; the sets are returned as found, and the
 * assertions below are what compare them to the control plane.
 */
function readMirrorWire(): MirrorWire {
  const source = parse(MIRROR_SOURCE);
  const paths = new Set<string>();
  const methods = new Set<string>();
  const queryNames = new Set<string>();
  const requestBodyNames = new Set<string>();
  const responseNames = new Set<string>();

  for (const node of walk(source)) {
    // 1. `/api/…` string and template literals — the paths it calls.
    const pattern = urlPattern(node);
    if (pattern !== null) paths.add(pattern);

    // 2. `new URLSearchParams({ projectKey })` and `params.set('subpath', …)`.
    if (ts.isNewExpression(node) && node.expression.getText() === 'URLSearchParams') {
      for (const name of propertyNames(node)) queryNames.add(name);
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'set'
    ) {
      const first = node.arguments[0];
      const name = first === undefined ? null : literalText(first);
      if (name !== null) queryNames.add(name);
    }

    // 3. Property names under `JSON.stringify(…)` — the request bodies it sends.
    if (ts.isCallExpression(node) && node.expression.getText() === 'JSON.stringify') {
      for (const argument of node.arguments) {
        for (const name of propertyNames(argument)) requestBodyNames.add(name);
      }
    }

    // 4. `record['entries']` — the response fields it reads back.
    //
    // Read position only, and the distinction is made explicitly rather than by hoping: an
    // element access on the left of an `=` is a field being *written* — `headers['content-type']`
    // is the one in this file — and a request header is not a field of an answer. Every other
    // string-literal element access is classified as a read, which is the arm that carries the
    // assertion, so a form this rule places wrongly makes the gate louder, not quieter.
    if (ts.isElementAccessExpression(node)) {
      const name = literalText(node.argumentExpression);
      const parent: ts.Node | undefined = node.parent;
      const isWriteTarget =
        parent !== undefined &&
        ts.isBinaryExpression(parent) &&
        parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        parent.left === node;
      if (name !== null && !isWriteTarget) responseNames.add(name);
    }

    // 5. `{ method: 'POST' }` — the verbs it uses.
    if (ts.isPropertyAssignment(node)) {
      const name = node.name;
      if ((ts.isIdentifier(name) || ts.isStringLiteral(name)) && name.text === 'method') {
        const verb = literalText(node.initializer);
        if (verb !== null) methods.add(verb);
      }
    }
  }

  return { paths, methods, queryNames, requestBodyNames, responseNames };
}

/**
 * The `{ method, path }` pairs ENG-06 declares to `tests/route-inventory.test.ts`, with
 * `:param` segments normalised to the mirror's `{}` so the two are comparable.
 *
 * Every element of the exported array must yield both fields. One that does not fails the gate by
 * name rather than being skipped — a declaration this reader cannot understand is a declaration
 * this gate is not checking, and saying nothing about it is the fail-open shape (ADR-0015).
 */
function readDeclaredRoutes(): Array<{ method: string; path: string }> {
  const source = parse(ROUTE_DECLARATIONS);
  const declared: Array<{ method: string; path: string }> = [];
  for (const node of walk(source)) {
    if (!ts.isVariableDeclaration(node)) continue;
    if (node.name.getText() !== 'routes') continue;
    const initializer = node.initializer;
    if (initializer === undefined) continue;
    for (const element of walk(initializer)) {
      if (!ts.isObjectLiteralExpression(element)) continue;
      // The `mandate: { section, because }` object is nested inside a route object; it carries no
      // `method`, so it is not a route and is passed over here rather than refused.
      const read = (field: string): string | null => {
        for (const property of element.properties) {
          if (!ts.isPropertyAssignment(property)) continue;
          const name = property.name;
          if (!ts.isIdentifier(name) && !ts.isStringLiteral(name)) continue;
          if (name.text !== field) continue;
          return literalText(property.initializer);
        }
        return null;
      };
      const method = read('method');
      const routePath = read('path');
      if (method === null && routePath === null) continue;
      if (method === null || routePath === null) {
        throw new Error(
          `${ROUTE_DECLARATIONS}: a route object states only one of method/path ` +
            `(method=${String(method)}, path=${String(routePath)}), so this gate cannot compare ` +
            `it to the mirror. Fix the declaration or fix this reader; do not leave it unchecked.`,
        );
      }
      declared.push({ method, path: routePath.replace(/:[A-Za-z0-9_]+/g, '{}') });
    }
  }
  return declared;
}

// ── The control plane, executed ──────────────────────────────────────────────────────────

const SESSION_ROW: SessionRecord = {
  id: SESSION,
  workspaceId: WORKSPACE,
  ownerPrincipalId: USER,
  userId: USER,
  agentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  projectId: null,
  engineSessionId: SESSION,
  engine: ENGINE,
  agentVersionId: null,
  title: 'wire contract',
  status: 'active',
  createdAt: new Date('2026-09-01T00:00:00Z'),
  updatedAt: new Date('2026-09-01T00:00:00Z'),
};

const SESSIONS: SessionRepositoryProvider = {
  forScope: () => ({
    ensure: () => Promise.resolve({ kind: 'existing', session: SESSION_ROW }),
    get: (id) => Promise.resolve(id === SESSION_ROW.id ? SESSION_ROW : null),
    getByEngineSessionId: (id) =>
      Promise.resolve(id === SESSION_ROW.engineSessionId ? SESSION_ROW : null),
    list: () => Promise.resolve({ items: [SESSION_ROW], nextCursor: null }),
    update: () => Promise.resolve({ kind: 'no-op', session: SESSION_ROW }),
    archive: () => Promise.resolve({ kind: 'no-op', session: SESSION_ROW }),
    restore: () => Promise.resolve({ kind: 'no-op', session: SESSION_ROW }),
  }),
};

function streamRef(streamKey: string) {
  return { workspaceId: WORKSPACE, sessionId: SESSION, engine: ENGINE, streamKey } as const;
}

function install(): InMemorySessionStateStore {
  // Which backend is installed is not what this gate is about: the wire is the same over either,
  // and `state-store.test.ts` runs the same contract suite against both.
  const stateStore = new InMemorySessionStateStore();
  installSessionApi({
    authenticate: () => Promise.resolve(PRINCIPAL),
    canAccessSession: () => Promise.resolve(true),
    store: new InMemoryTranscriptStore(),
    stateStore,
    sessions: SESSIONS,
    scopes: createInMemoryWorkspaceScopeResolver([{ id: WORKSPACE, slug: 'wire-contract' }]),
  });
  return stateStore;
}

afterEach(() => {
  resetSessionApi();
});

/**
 * The value the replay sends for one wire name.
 *
 * A name the client sends that is absent from this table fails the gate: it means the request shape
 * changed and nothing here knows what the new field means, which is precisely the drift this file
 * exists to notice.
 */
const REQUEST_VALUES: Readonly<Record<string, unknown>> = {
  engine: ENGINE,
  streamKey: STREAM_KEY,
  entries: [{ entryKey: 'a', entry: { type: 'user', text: 'the passphrase is ORCHID' } }],
  blobKey: 'state.tar',
  after: 0,
  limit: 100,
  last: '1',
};

function valueFor(name: string): unknown {
  if (!(name in REQUEST_VALUES)) {
    throw new Error(
      `apps/runner/src/session-state.ts sends a wire field this gate has no value for: ${JSON.stringify(name)}. ` +
        `The request shape changed on the client's side; add it here **and** check that ` +
        `apps/web/server/sessions/state-api.ts reads it, which is the drift this gate exists for.`,
    );
  }
  return REQUEST_VALUES[name];
}

/** Build a request body out of the client's own top-level field names. */
function entriesBody(wire: MirrorWire): unknown {
  const body: Record<string, unknown> = {};
  for (const name of wire.requestBodyNames) body[name] = valueFor(name);
  return body;
}

/**
 * Build a query string out of the client's own parameter names.
 *
 * `omit` is how the delete-the-stream case is distinguished from the delete-the-last-entry one:
 * both are spelled by the same client with the same parameter set minus `last`, and a gate that
 * could only build one of them would replay half the route.
 */
function queryString(wire: MirrorWire, omit: ReadonlySet<string> = new Set()): string {
  const params = new URLSearchParams();
  for (const name of wire.queryNames) {
    if (omit.has(name)) continue;
    params.set(name, String(valueFor(name)));
  }
  return params.toString();
}

function url(pathname: string): string {
  return `https://control.example${pathname.replace('{}', SESSION)}`;
}

/** Every property name appearing anywhere in a parsed JSON body. */
function allNames(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const element of value) allNames(element, into);
  } else if (typeof value === 'object' && value !== null) {
    for (const [name, nested] of Object.entries(value)) {
      into.add(name);
      allNames(nested, into);
    }
  }
  return into;
}

function topLevelNames(value: unknown): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`a 200 answer that is not a JSON object: ${JSON.stringify(value)}`);
  }
  return Object.keys(value);
}

function pathEndingIn(wire: MirrorWire, suffix: string): string {
  const found = [...wire.paths].find((candidate) => candidate.endsWith(suffix));
  if (found === undefined) {
    throw new Error(
      `apps/runner/src/session-state.ts names no path ending in ${JSON.stringify(suffix)}, so this ` +
        `gate cannot replay it. Either the client stopped calling that route or this reader no ` +
        `longer recognises how it spells one — neither may pass quietly (ADR-0015).`,
    );
  }
  return found;
}

// ── The gate ─────────────────────────────────────────────────────────────────────────────

describe('the session-state client and the control plane speak one wire format', () => {
  const wire = readMirrorWire();

  it('reads a non-empty vocabulary out of the client, so a silent no-op cannot pass', () => {
    // ADR-0015: a check that cannot run must fail. An extractor that matched nothing — because the
    // client was rewritten in a shape it does not recognise — would otherwise make every assertion
    // below vacuously true.
    expect([...wire.paths].sort()).not.toEqual([]);
    expect([...wire.methods].sort()).not.toEqual([]);
    expect([...wire.queryNames].sort()).not.toEqual([]);
    expect([...wire.requestBodyNames].sort()).not.toEqual([]);
    expect([...wire.responseNames].sort()).not.toEqual([]);
  });

  it('calls exactly the routes this unit declares, and no others', () => {
    const declared = readDeclaredRoutes();
    expect(declared.length).toBeGreaterThan(0);
    expect([...new Set([...wire.paths, ...CONTROL_PLANE_ONLY_PATHS])].sort()).toEqual(
      [...new Set(declared.map((r) => r.path))].sort(),
    );
    expect([...new Set([...wire.methods, ...CONTROL_PLANE_ONLY_METHODS])].sort()).toEqual(
      [...new Set(declared.map((r) => r.method))].sort(),
    );
  });

  it('drives every handler with requests built from the client’s own vocabulary', async () => {
    const store = install();
    const entries = pathEndingIn(wire, '/state-entries');
    const streams = pathEndingIn(wire, '/state-streams');
    // Named so a rename of the blob route is a failure here too, even though its own body is bytes
    // and is replayed by `state-api.test.ts` rather than by this JSON comparison.
    expect(pathEndingIn(wire, '/state-blobs').length).toBeGreaterThan(0);

    // POST — the append every engine mirrors its batches through. A body assembled from the field
    // names the client's source sends must be one this handler accepts.
    const posted = await appendSessionState(
      new Request(url(entries), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(entriesBody(wire)),
      }),
      SESSION,
    );
    expect(posted.status).toBe(204);
    await expect(store.list(streamRef(STREAM_KEY), {})).resolves.toEqual([
      { sequence: 1, entryKey: 'a', entry: { type: 'user', text: 'the passphrase is ORCHID' } },
    ]);

    // PUT — replace-all, over the same body shape.
    const replaced = await replaceSessionState(
      new Request(url(entries), {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(entriesBody(wire)),
      }),
      SESSION,
    );
    expect(replaced.status).toBe(204);

    // A second stream, so the stream listing has a subagent to report and the client's
    // `listSubkeys` reader has something to filter.
    await store.append(streamRef(`${WORKSPACE}/${SUBPATH}`), [{ entry: { type: 'user' } }]);

    // The two GETs, each with a query string built the same way. Their bodies are what the client's
    // readers parse.
    const listed = await listSessionStateEntries(
      new Request(`${url(entries)}?${queryString(wire)}`),
      SESSION,
    );
    expect(listed.status).toBe(200);
    const streamed = await listSessionStateStreams(
      new Request(`${url(streams)}?${queryString(wire)}`),
      SESSION,
    );
    expect(streamed.status).toBe(200);

    const bodies = [await listed.json(), await streamed.json()] as unknown[];

    // Every field the control plane puts at the top of an answer is a field the client's source
    // names somewhere. This is the direction the original verifier's counter-example broke:
    // renaming a response field here, with `apps/web`'s own test updated in lockstep, leaves the
    // client reading a field that no longer arrives.
    const spoken = new Set([...wire.responseNames, ...wire.requestBodyNames, ...wire.queryNames]);
    for (const body of bodies) {
      for (const name of topLevelNames(body)) {
        expect(
          { field: name, spokenByTheClient: spoken.has(name) },
          `the control plane answers with a top-level field ${JSON.stringify(name)} that ` +
            `apps/runner/src/session-state.ts never mentions, so the client cannot read it back`,
        ).toEqual({ field: name, spokenByTheClient: true });
      }
    }

    // …and the other direction: every field the client reads off an answer is one an answer
    // actually carries. This is what a rename on the *client's* side trips.
    const observed = new Set<string>();
    for (const body of bodies) allNames(body, observed);
    for (const name of wire.responseNames) {
      expect(
        { field: name, presentInAnAnswer: observed.has(name) },
        `apps/runner/src/session-state.ts reads a field ${JSON.stringify(name)} off a response, ` +
          `and no answer of these routes carries it`,
      ).toEqual({ field: name, presentInAnAnswer: true });
    }

    // DELETE closes the set, in both spellings the client uses.
    const popped = await deleteSessionState(
      new Request(`${url(entries)}?${queryString(wire)}`, { method: 'DELETE' }),
      SESSION,
    );
    expect(popped.status).toBe(204);
    const dropped = await deleteSessionState(
      new Request(`${url(entries)}?${queryString(wire, new Set(['last']))}`, { method: 'DELETE' }),
      SESSION,
    );
    expect(dropped.status).toBe(204);
    await expect(store.list(streamRef(STREAM_KEY), {})).resolves.toBeNull();
  });
});
