import {
  HTTP_METHODS,
  readDeclarationFiles,
  requireBoolean,
  requireString,
  unknownFields,
} from './inventory-support.js';
import type {
  DeclarationFile,
  HttpMethod,
  RouteDeclaration,
  RouteMandate,
} from './inventory-support.js';

export const ROUTE_DECLARATIONS = 'tests/route-declarations';

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

const ROUTE_FIELDS = ['method', 'path', 'owner', 'landed', 'mandate'] as const;

const MANDATE_FIELDS = ['section', 'because'] as const;

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

export function expectedRoutes(): RouteDeclaration[] {
  return unionRoutes(readDeclarationFiles(ROUTE_DECLARATIONS, 'routes'));
}

export function key(entry: { method: string; path: string }): string {
  return `${entry.method} ${entry.path}`;
}
