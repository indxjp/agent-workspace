#!/usr/bin/env node
/**
 * Generates `packages/schemas/agent-workspace.schema.json` — the JSON Schema (draft 2020-12) of
 * `agent-workspace.yaml`, `apiVersion: agentworkspace.dev/v1`, `kind: Deployment` — from the Zod
 * definition the CLI validates with, `packages/cli/src/profile-schema.ts` (issue #424, ADR-0091),
 * and the identical copy `packages/cli/schema/agent-workspace.schema.json`, which the published CLI
 * ships and its `$schema` URL names on unpkg. Editors read the schema; the CLI never does, so the
 * schema is generated, never the source of truth.
 *
 * The generator lives in `packages/cli` because it reads the CLI's source: a script outside the
 * package would import inside it, which `pnpm package-exports:check` refuses, and the definition
 * is not part of the published CLI's API. `files` in `package.json` does not ship this directory.
 *
 * `--write` rewrites both committed copies; `--check` renders the schema in memory and fails when
 * either committed copy differs, the rule `generate-openapi.mjs` applies to the OpenAPI document. Output
 * is deterministic: every object's keys are sorted, then the repository's Prettier format applies.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as prettier from 'prettier';

import { sortKeysDeep } from '../../../scripts/docs/generate-openapi.mjs';

/**
 * Repo-relative paths of the emitted schema: the workspace package's copy, and the copy the CLI's
 * `files` ships under `schema/`.
 */
const PROFILE_SCHEMA_OUTPUTS = [
  'packages/schemas/agent-workspace.schema.json',
  'packages/cli/schema/agent-workspace.schema.json',
];

/**
 * Build the schema. Node 24 runs the CLI's TypeScript source directly (type stripping); its
 * value imports from `@indx-workspace/contracts` resolve to that package's `dist`, so the root
 * `docs:check` / `docs:generate` scripts build the contracts first. The converted schema is the union of the cloud branches, envelope included;
 * the one rule of the CLI's first stage the branches do not carry — `kind` is required once
 * `apiVersion` is set — is added as `dependentRequired`. The specifier is a literal so the
 * repository's module-boundary gates can read it.
 * @returns {Promise<Record<string, unknown>>}
 */
async function buildProfileSchema() {
  /** @type {typeof import('../src/profile-schema.ts')} */
  const definition = await import('../src/profile-schema.ts');
  const branches = definition.profileDocumentSchemas.branches.toJSONSchema({
    target: 'draft-2020-12',
    io: 'output',
  });
  return sortKeysDeep({
    ...branches,
    title: `agent-workspace.yaml (${definition.PROFILE_API_VERSION}, ${definition.PROFILE_KIND})`,
    description:
      'The Agent Workspace deployment profile. Generated from packages/cli/src/profile-schema.ts ' +
      'by packages/cli/scripts/generate-profile-schema.mjs; never edit it by hand. ' +
      '`agent-workspace validate` is authoritative and also checks that connection strings and ' +
      'the OIDC issuer parse as URLs.',
    type: 'object',
    dependentRequired: { apiVersion: ['kind'] },
  });
}

/**
 * The schema as committed: sorted keys, in the repository's Prettier format — the file sits under
 * `packages/`, which `pnpm format:check` covers, so the generator writes what that check expects.
 * @param {string} outPath
 * @returns {Promise<string>}
 */
async function renderProfileSchema(outPath) {
  const json = JSON.stringify(await buildProfileSchema());
  const options = (await prettier.resolveConfig(outPath)) ?? {};
  return prettier.format(json, { ...options, filepath: outPath });
}

async function main() {
  const mode = process.argv[2];
  if (mode !== '--write' && mode !== '--check') {
    process.stderr.write('usage: generate-profile-schema.mjs --write | --check\n');
    process.exit(2);
  }
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  let current = true;
  for (const output of PROFILE_SCHEMA_OUTPUTS) {
    const outPath = path.join(repoRoot, ...output.split('/'));
    const rendered = await renderProfileSchema(outPath);
    if (mode === '--write') {
      await mkdir(path.dirname(outPath), { recursive: true });
      await writeFile(outPath, rendered, 'utf8');
      process.stdout.write(`wrote ${output}\n`);
      continue;
    }
    const existing = await readFile(outPath, 'utf8').catch(() => null);
    if (existing === rendered) {
      process.stdout.write(`${output} is current\n`);
      continue;
    }
    const state = existing === null ? 'missing' : 'stale';
    process.stderr.write(`${state}: ${output} — run \`pnpm docs:generate\`\n`);
    current = false;
  }
  if (!current) process.exit(1);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
