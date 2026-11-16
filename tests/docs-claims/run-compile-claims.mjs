/**
 * @typedef {import('./run.d.mts').Machine} Machine
 * @typedef {import('./extract.mjs').Claim} Claim
 * @typedef {import('./run.d.mts').Row} Row
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pinnedVersion, scrub } from '../journey/run.mjs';
import { ROOT } from './run-config.mjs';
import { compileSources, tscDiagnostics, whereOf } from './run-plans.mjs';

function writeCompileProject(work, sources) {
  const stage = path.join(work, 'compile-stage');
  mkdirSync(path.join(stage, 'src'), { recursive: true });
  for (const { name, text } of sources) writeFileSync(path.join(stage, name), text);
  writeFileSync(
    path.join(stage, 'package.json'),
    `${JSON.stringify({ name: 'docs-claims-compile', private: true }, null, 2)}\n`,
  );
  writeFileSync(
    path.join(stage, 'tsconfig.json'),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: 'es2023',
          module: 'esnext',
          moduleResolution: 'bundler',
          lib: ['es2023', 'dom'],
          jsx: 'react-jsx',
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          types: ['node'],
        },
        include: ['src'],
      },
      null,
      2,
    )}\n`,
  );
  return stage;
}

/**
 * Every compile claim in one scratch project with the packed packages, one `tsc --noEmit`.
 *
 * @param {Machine} machine @param {readonly Claim[]} claims @param {string} work
 * @returns {Promise<Row[]>}
 */
export async function compileRows(machine, claims, work) {
  const sources = compileSources(claims);
  if (sources.length === 0) return [];
  const stage = writeCompileProject(work, sources);
  const where = await machine.stageCompile(stage);
  const react = path.join(ROOT, 'packages', 'react');
  const started = performance.now();
  const install = await machine.exec(
    [
      'npm install --no-audit --no-fund',
      "'@indx-workspace/contracts'",
      "'@indx-workspace/sdk'",
      "'@indx-workspace/react'",
      `typescript@${pinnedVersion(ROOT, 'typescript')}`,
      `@types/node@${pinnedVersion(ROOT, '@types/node')}`,
      `vitest@${pinnedVersion(ROOT, 'vitest')}`,
      `react@${pinnedVersion(react, 'react')}`,
      `@types/react@${pinnedVersion(react, '@types/react')}`,
    ].join(' '),
    { cwd: where, timeoutMs: machine.commandMs },
  );
  const tsc =
    install.status === 0
      ? await machine.exec('npx tsc --noEmit --pretty false -p .', {
          cwd: where,
          timeoutMs: machine.commandMs,
        })
      : install;
  const output = scrub(tsc.output);
  writeFileSync(path.join(machine.logs, 'compile.log'), output);
  const seconds = (performance.now() - started) / 1000;
  const diagnostics = tscDiagnostics(output);
  const infrastructure = install.status !== 0 || (tsc.status !== 0 && diagnostics.size === 0);
  return sources.map(({ claim, name }) => {
    const found = diagnostics.get(name) ?? [];
    const first = found[0];
    const failed = infrastructure || first !== undefined;
    return {
      where:
        first === undefined ? whereOf(claim) : `${claim.page}:${String(claim.line + first.line)}`,
      state: 'compile',
      what: `${claim.lang} block, ${String(claim.body.split('\n').length)} lines`,
      result: failed ? 'FAIL: does not type-check' : 'pass',
      seconds: seconds / sources.length,
      detail: failed
        ? infrastructure
          ? output
          : found
              .map((d) => `${claim.page}:${String(claim.line + d.line)}: ${d.message}`)
              .join('\n')
        : undefined,
    };
  });
}
