/**
 * Reading `docs/spec.md` for the permission-table tests: the §34 resource scan and the section
 * lookup the §21 citations are checked against.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { REPO_ROOT } from '../../../../tests/inventory-support';

const SPEC = readFileSync(path.join(REPO_ROOT, 'docs/spec.md'), 'utf8');

/** One section of `docs/spec.md`, from its heading to the next top-level heading. */
export function specSection(heading: RegExp, name: string): string {
  const match = heading.exec(SPEC);
  if (match === null) {
    throw new Error(
      `docs/spec.md has no ${name} heading, so this test cannot check the permission table ` +
        `against it and refuses to pass instead.`,
    );
  }
  const rest = SPEC.slice(match.index + match[0].length);
  const next = /^# /m.exec(rest);
  return next === null ? rest : rest.slice(0, next.index);
}

/**
 * What one scan of §34 found: the resource segments it names, and the times it wrote the bare
 * prefix `/api/` while naming no resource at all.
 *
 * The second number exists so that "§34 mentioned the prefix without naming a resource" is a fact
 * this parser *states*, rather than an occurrence it silently dropped.
 */
interface SpecResourceScan {
  readonly resources: ReadonlySet<string>;
  readonly bareMentions: number;
}

/** The literal this scan looks for. There is no context condition around it, deliberately. */
const API_PREFIX = '/api/';

/**
 * The characters that end a path segment in §34 — in its route table and in its prose alike.
 *
 * Closed, and checked positively: a character that is not in this set does not end a segment, and
 * an occurrence that ends on one is not a resource this parser can name, so it refuses rather
 * than recording the prefix it managed to read.
 */
const SEGMENT_TERMINATORS = new Set([
  ' ',
  '\t',
  '\n',
  '\r',
  '`',
  '/',
  '(',
  ')',
  '[',
  ']',
  '{',
  '}',
  '<',
  '>',
  ',',
  ';',
  ':',
  '.',
  '!',
  '?',
  '"',
  "'",
  '|',
  '*',
  '#',
]);

/**
 * `/api/<segment>` prefixes §34 prints that are a protocol's name, not a resource. A2A v0.3 fixes
 * where a client finds an agent and its card, so `/api/a2a/…` is a literal pair of routes
 * (ADR-0135) that authorise as `POST /api/agents/:id/runs`; `tests/route-inventory.policy-check.ts` names
 * the same exception. `/api/auth/…` is the sign-in protocol's prefix: its routes are public or
 * identity-only and authenticate a client or the presented credential itself, never through a
 * §21 row (ADR-0083 D8; ADR-0161 D3 prints `POST /api/auth/token-exchange` in §34). The tests
 * below require each prefix to be printed and to stay out of `RESOURCES`, so this list can
 * neither go stale nor hide a real resource.
 */
export const PROTOCOL_PREFIXES: ReadonlySet<string> = new Set(['a2a', 'auth']);

const SEGMENT_SHAPE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

/**
 * Every resource segment spec §34 names, decided positively.
 *
 * Round 1 asked this question with `/(?:^|\s)\/api\/([a-z0-9]+(?:-[a-z0-9]+)*)/`, which requires
 * whitespace or a line start immediately before `/api/`. §34 writes prose in backticks, and the
 * section's own last paragraph contains a backticked `` `/api/` ``, so a resource §34 named that
 * way contributed nothing and `classifies every resource spec §34 prints` passed with nothing to
 * check. The verifier's counter-example is re-run below, in the describe block "the §34 scan
 * decides positively, not from the absence of a match", against both scans; it read:
 *
 * ```text
 * $ node -e "const re = /(?:^|\s)\/api\/([a-z0-9]+(?:-[a-z0-9]+)*)/gmu; …"
 * matches: []
 * ```
 *
 * for a sample containing `` `/api/webhooks` `` and `(/api/model_connections)`. That is the
 * ADR-0015 fail-open exactly: the conclusion *"§34 names no further resource"* was drawn from the
 * ABSENCE of a match, and `found.size === 0` only caught a total parse failure, never a partial
 * one.
 *
 * It is now drawn from a positive parse. Every occurrence of the literal `/api/` is found by
 * index — a scan nothing can hide from, because there is no context condition to satisfy — and
 * each occurrence is then classified, with a refusing `else`:
 *
 *   1. segment characters follow and stop on a {@link SEGMENT_TERMINATORS} character → a resource
 *      segment, recorded;
 *   2. a terminator follows immediately → the bare prefix, naming no resource. §34's closing
 *      paragraph writes exactly this. Counted, not dropped;
 *   3. anything else — `(/api/model_connections)` is the verifier's own example — → this parser
 *      cannot say which resource the text names, and it **throws**. A check that cannot run
 *      fails (ADR-0015); it does not skip the occurrence and carry on.
 *
 * ## Why this is not `parseSpecRoutes` from `tests/route-inventory.policy-check.ts`
 *
 * That function answers a narrower question — the whole routes printed inside §34's ```text
 * fences — and reusing it would not have fixed this fail-open, because a resource named only in
 * §34's prose is outside every fence and it would not see one either. Importing it is separately
 * impossible: it is exported from a `.test.ts`, so importing it would collect and run that file's
 * suite a second time inside this one.
 */
export function scanSpecResources(section: string): SpecResourceScan {
  const resources = new Set<string>();
  let bareMentions = 0;
  for (
    let at = section.indexOf(API_PREFIX);
    at !== -1;
    at = section.indexOf(API_PREFIX, at + API_PREFIX.length)
  ) {
    const from = at + API_PREFIX.length;
    let end = from;
    while (end < section.length && !SEGMENT_TERMINATORS.has(section[end] ?? '')) end += 1;
    const segment = section.slice(from, end);
    const context = JSON.stringify(section.slice(Math.max(0, at - 30), end + 10));
    if (segment === '') {
      bareMentions += 1;
      continue;
    }
    if (!SEGMENT_SHAPE.test(segment)) {
      throw new Error(
        `spec §34 writes ${API_PREFIX}${segment} at ${context}, and ${JSON.stringify(segment)} ` +
          `is not the shape of a resource segment this parser can read ` +
          `(${String(SEGMENT_SHAPE)}). It is not skipped: a resource segment nobody can parse ` +
          `is one nobody can check against the permission table, so this check fails rather ` +
          `than passing with one fewer thing to check (ADR-0015).`,
      );
    }
    resources.add(segment);
  }
  if (resources.size === 0) {
    throw new Error(
      'spec §34 was found but named no /api/<resource>, so this parse produced nothing and ' +
        'every assertion built on it would pass by having nothing to check.',
    );
  }
  return { resources, bareMentions };
}

/** {@link scanSpecResources} over the real §34. */
export function specResources(): SpecResourceScan {
  return scanSpecResources(specSection(/^# 34\. API Design$/m, '"# 34. API Design"'));
}
