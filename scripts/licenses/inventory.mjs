import { POLICY, EXCEPTIONS } from './policy.mjs';
import {
  parseSpdx,
  canonicaliseSpdx,
  canonicalSet,
  expressionSatisfies,
  expressionDenied,
  salvageDenied,
} from './spdx.mjs';
/**
 * @param {import('./types.mjs').LicensePolicy} policy
 * @param {string} scope
 * @returns {import('./types.mjs').CompiledPolicy}
 */
export function makePolicy(policy, scope) {
  const allow = scope === 'dev' ? policy.allow.concat(policy.allowDev ?? []) : policy.allow;
  return {
    scope,
    allowSet: canonicalSet(allow),
    reviewSet: new Set(policy.review),
    denySet: canonicalSet(policy.denyFamilies),
    denyLiteralSet: new Set(policy.denyLiteral),
    denyByName: policy.denyByName ?? [],
  };
}

/**
 * @param {string} licence
 * @param {import('./types.mjs').CompiledPolicy} compiled
 * @returns {import('./types.mjs').Classification}
 */
export function classify(licence, compiled) {
  // Stage N. Every stage below reads `normalised`, not `licence`, with one exception: the two
  // exact-match policy lists are consulted under BOTH spellings, so a policy entry keeps
  // matching the string pnpm actually printed as well as its canonical SPDX form.
  const normalised = canonicaliseSpdx(licence);
  if (compiled.denyLiteralSet.has(licence) || compiled.denyLiteralSet.has(normalised)) {
    return { verdict: 'deny', why: 'denyLiteral: not an open-source licence this project accepts' };
  }
  let ast;
  try {
    ast = parseSpdx(normalised);
  } catch (error) {
    // The offset in `error.message` is an offset into `normalised`, so say so when that is not
    // the string pnpm printed. Silently reporting an offset into a string the reader cannot
    // see is the kind of small lie this file has had too many of.
    const message = error instanceof Error ? error.message : String(error);
    const where = normalised === licence ? message : `${message}, in \`${normalised}\``;
    const buried = salvageDenied(normalised, compiled.denySet, compiled.denyLiteralSet);
    if (buried) {
      return {
        verdict: 'deny',
        why: `unparseable SPDX expression containing \`${buried}\` (${where})`,
      };
    }
    return { verdict: 'review', why: `unparseable SPDX expression (${where})` };
  }
  if (expressionSatisfies(ast, compiled.allowSet)) {
    return { verdict: 'allow', why: 'on the allow list' };
  }
  if (compiled.reviewSet.has(licence) || compiled.reviewSet.has(normalised)) {
    return { verdict: 'review', why: 'on the review list' };
  }
  if (expressionDenied(ast, compiled.denySet)) {
    return { verdict: 'deny', why: 'strong copyleft: obliges compliance with a denied licence' };
  }
  return { verdict: 'review', why: 'on none of the policy lists' };
}

// ── Package names and exceptions ────────────────────────────────────────────────────────

/** @param {readonly string[]} patterns @param {string} name */
export function matchName(patterns, name) {
  return patterns.some((p) => (p.endsWith('*') ? name.startsWith(p.slice(0, -1)) : p === name));
}

/**
 * @param {import('./types.mjs').ExceptionRegistry} exceptions
 * @param {string} name
 * @param {string} licence
 * @returns {import('./types.mjs').ExceptionMatch | null}
 */
export function matchException(exceptions, name, licence) {
  for (const [pattern, entry] of Object.entries(exceptions)) {
    const nameMatches = pattern.endsWith('*')
      ? name.startsWith(pattern.slice(0, -1))
      : pattern === name;
    if (!nameMatches) continue;
    const granted = Array.isArray(entry.licence) ? entry.licence : [entry.licence];
    if (granted.includes(licence)) return { pattern, entry };
    return { pattern, entry, licenceMismatch: granted.join(' | ') };
  }
  return null;
}

/**
 * @param {import('./types.mjs').LicenseInventory} inventory
 * @param {import('./types.mjs').EvaluationOptions} [options]
 * @returns {import('./types.mjs').InventoryRow[]}
 */
export function evaluateInventory(
  inventory,
  { policy = POLICY, exceptions = EXCEPTIONS, scope = 'prod', now = Date.now() } = {},
) {
  const compiled = makePolicy(policy, scope);
  const context = { compiled, exceptions, scope, now };
  /** @type {import('./types.mjs').InventoryRow[]} */
  const rows = [];
  for (const [licence, packages] of Object.entries(inventory)) {
    const { verdict, why } = classify(licence, compiled);
    for (const pkg of packages) {
      const version = Array.isArray(pkg.versions)
        ? pkg.versions.join(',')
        : String(pkg.versions ?? '');
      const row = { name: pkg.name, version, licence, verdict, why };

      const finding = packageFinding(row, context);
      if (finding !== null) rows.push(finding);
    }
  }
  rows.sort(
    (a, b) =>
      (a.verdict === b.verdict ? 0 : a.verdict === 'deny' ? -1 : 1) || a.name.localeCompare(b.name),
  );
  return rows;
}

/**
 * @param {import('./types.mjs').InventoryRow} row
 * @param {import('./types.mjs').EvaluationContext} context
 * @returns {import('./types.mjs').InventoryRow | null}
 */
function packageFinding(row, { compiled, exceptions, scope, now }) {
  // Name prohibitions take precedence over permissive licenses and exceptions.
  if (matchName(compiled.denyByName, row.name)) {
    return {
      ...row,
      verdict: 'deny',
      why: 'denyByName: a third-party sandbox vendor SDK, forbidden while D-09 stands',
    };
  }
  if (row.verdict === 'allow') return null;
  const found = matchException(exceptions, row.name, row.licence);
  if (!found || row.verdict === 'deny') return row;
  const reason = exceptionFailure(found, { licence: row.licence, scope, now });
  return reason === null ? null : { ...row, why: reason };
}

/**
 * @param {import('./types.mjs').ExceptionMatch} matched
 * @param {{ licence: string, scope: string, now: number }} context
 * @returns {string | null}
 */
function exceptionFailure({ pattern, entry, licenceMismatch }, { licence, scope, now }) {
  if (licenceMismatch)
    return `exception \`${pattern}\` was granted for ${licenceMismatch}, not for ${licence}; re-review`;
  if (entry.scope !== scope && entry.scope !== 'all')
    return `exception \`${pattern}\` is scoped '${entry.scope}', this run is '${scope}'`;
  // An unreadable expiry must fail closed, including values Date.parse would coerce.
  if (typeof entry.expires !== 'string' || !Number.isFinite(Date.parse(entry.expires))) {
    return `exception \`${pattern}\` has an unreadable expiry (${JSON.stringify(entry.expires ?? null)}); an exception without a usable expiry clears nothing`;
  }
  if (Date.parse(entry.expires) < now)
    return `exception \`${pattern}\` expired ${entry.expires}; re-review or renew`;
  return null;
}
