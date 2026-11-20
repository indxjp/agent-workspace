/**
 * Reads the contracts package for `generate-openapi.mjs`: the route catalogue and the
 * contracts-version surface of ADR-0078 (header names, problem codes), straight from source.
 *
 * Node 24 runs the contracts' TypeScript source directly (type stripping), so the generator reads
 * the source through the package's public entry points and needs no build first. Two mappings make
 * that work: `@indx-workspace/contracts/*` is resolved under the `types` export condition (which
 * names `src/*.ts`, not `dist/*.js`), and inside that source a sibling import `./x.js` — the
 * specifier `tsc` emits — is mapped to the `./x.ts` next to it.
 */
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { URL, fileURLToPath } from 'node:url';

let hooksRegistered = false;

/** @param {string} specifier */
function isContractsEntry(specifier) {
  return (
    specifier === '@indx-workspace/contracts' || specifier.startsWith('@indx-workspace/contracts/')
  );
}

/**
 * The `./x.ts` next to a `./x.js` import made from a `.ts` file, when it exists.
 * @param {string} specifier @param {string | undefined} parent
 * @returns {string | undefined}
 */
function siblingTypeScriptSource(specifier, parent) {
  const isEmittedSiblingImport =
    parent !== undefined &&
    parent.endsWith('.ts') &&
    specifier.startsWith('.') &&
    specifier.endsWith('.js');
  if (!isEmittedSiblingImport) return undefined;
  const candidate = new URL(`${specifier.slice(0, -'.js'.length)}.ts`, parent);
  return existsSync(fileURLToPath(candidate)) ? candidate.href : undefined;
}

function resolveContractsFromSource() {
  if (hooksRegistered) return;
  hooksRegistered = true;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (isContractsEntry(specifier)) {
        return nextResolve(specifier, { ...context, conditions: ['types', ...context.conditions] });
      }
      const sibling = siblingTypeScriptSource(specifier, context.parentURL);
      if (sibling !== undefined) return nextResolve(sibling, context);
      return nextResolve(specifier, context);
    },
  });
}

/**
 * The route catalogue and the contracts-version surface of ADR-0078 (header names, problem codes),
 * both read from the contracts source so the document cannot drift from them.
 */
export async function loadContracts() {
  resolveContractsFromSource();
  /** @type {typeof import('@indx-workspace/contracts/routes')} */
  const routes = await import('@indx-workspace/contracts/routes');
  /** @type {typeof import('@indx-workspace/contracts')} */
  const root = await import('@indx-workspace/contracts');
  return {
    API_ROUTES: routes.API_ROUTES,
    API_SCHEMAS: routes.API_SCHEMAS,
    CONTRACTS_VERSION_HEADER: root.CONTRACTS_VERSION_HEADER,
    CONTRACTS_MINIMUM_VERSION_HEADER: root.CONTRACTS_MINIMUM_VERSION_HEADER,
    CONTRACTS_VERSION_PROBLEM_CODES: root.CONTRACTS_VERSION_PROBLEM_CODES,
  };
}
