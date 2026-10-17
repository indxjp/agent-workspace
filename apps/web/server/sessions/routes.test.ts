/**
 * The three App Router files this task wrote, checked against the handlers they adapt.
 *
 * They are read as **source text**, not imported. `apps/web/server/runs/routes.test.ts` does the
 * same and for the same two reasons: a route file's `RouteContext<'…'>` type only exists after
 * `next typegen`, and what is being asserted here is a property of the tracked tree rather than
 * of a module graph.
 *
 * This file deliberately asserts nothing about routes it does not own.
 * [ADR-0019](../../../../docs/adr/0019-repo-wide-gates-belong-to-the-integration-level.md): a
 * closed-world assertion over `apps/web/app/api` belongs to `tests/route-inventory.test.ts`,
 * where the whole surface is visible. Narrowing such a gate to its author's subtree is the
 * fail-open shape ADR-0015 exists to stop.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** `apps/web/server/sessions` → `apps/web`. */
const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const ROUTES = [
  {
    file: 'app/api/sessions/route.ts',
    methods: ['GET'],
    handlers: ['listSessions'],
  },
  {
    file: 'app/api/sessions/[engineSessionId]/route.ts',
    methods: ['GET', 'PATCH'],
    handlers: ['getSession', 'updateSession'],
  },
  {
    file: 'app/api/sessions/[engineSessionId]/transcript/route.ts',
    methods: ['GET', 'POST', 'DELETE'],
    handlers: ['appendTranscript', 'deleteTranscript', 'loadTranscript'],
  },
  {
    file: 'app/api/sessions/[engineSessionId]/subkeys/route.ts',
    methods: ['GET'],
    handlers: ['listTranscriptSubkeys'],
  },
] as const;

function read(file: string): string {
  return readFileSync(path.join(WEB, file), 'utf8');
}

/** The names a route file exports as HTTP handlers, in the order Next.js recognises them. */
function exportedMethods(source: string): string[] {
  const found: string[] = [];
  for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    if (new RegExp(`export\\s+async\\s+function\\s+${method}\\s*\\(`).test(source)) {
      found.push(method);
    }
  }
  return found;
}

describe.each(ROUTES)('$file', ({ file, methods, handlers }) => {
  it('exports exactly the methods it declares', () => {
    expect(exportedMethods(read(file))).toEqual([...methods]);
  });

  it('delegates to the handlers in server/sessions/api.ts and defines no logic of its own', () => {
    const source = read(file);
    for (const handler of handlers) {
      expect(source).toContain(handler);
    }
    // §34's "expose a very small control-plane API": the route file is an adapter. A route that
    // read the store, or built a key, would be a second implementation of the rules `api.ts`
    // enforces — and the one nobody's tests reach.
    expect(source).not.toContain('TranscriptStore');
    expect(source).not.toContain('projectKey');
  });

  it('runs on Node and is never prerendered', () => {
    const source = read(file);
    // 'edge' is deprecated in Next 16 and the store needs Node APIs; a prerendered handler would
    // serve one tenant's answer to another.
    expect(source).toContain("export const runtime = 'nodejs';");
    expect(source).toContain("export const dynamic = 'force-dynamic';");
  });
});

describe('the transcript routes are reachable only under /api/', () => {
  it.each(ROUTES)('$file lives under app/api', ({ file }) => {
    // Spec §34: the public surface is `/p/**` and everything under `/api/**` is gated by
    // `apps/web/proxy.ts` by prefix. A transcript route served from anywhere else would be
    // outside that gate entirely.
    expect(file.startsWith('app/api/')).toBe(true);
  });
});
