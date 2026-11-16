import { readFileSync } from 'node:fs';

import { SPEC_PATH } from './inventory-support.js';
import type { RouteDeclaration } from './inventory-support.js';
import { key } from './route-declaration-reader.js';
import { routeShape } from './route-shape.js';

export function specRoutes(): ReadonlySet<string> {
  return parseSpecRoutes(readFileSync(SPEC_PATH, 'utf8'));
}

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
