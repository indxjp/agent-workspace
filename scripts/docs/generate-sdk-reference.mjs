#!/usr/bin/env node
/**
 * Generates `docs/sdk/site/reference/**` from `packages/contracts`, `packages/sdk` and
 * `packages/aw` source, through the TypeScript compiler API (ADR-0054). `--write` regenerates the
 * committed pages and deletes ones the generator no longer produces; `--check` renders the same
 * pages in memory and fails when a committed page differs, is missing, or is no longer produced.
 */
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { familyClientNames } from './lib/families.mjs';
import { contractsModules, renderContractsModulePage } from './lib/render-contracts.mjs';
import { renderCliPage, commandArrayOrder, importSpecifiers } from './lib/render-cli.mjs';
import { renderClientPage } from './lib/render-client.mjs';
import { renderEventsPage, renderSubpathPage } from './lib/render-events.mjs';
import { renderFamilyPage } from './lib/render-families.mjs';
import { buildProbeProgram, createPackageProgram, sourceFileOf } from './lib/ts-project.mjs';
import { moduleExports } from './lib/ts-nodes.mjs';
import { isZodSchemaType } from './lib/zod-shape.mjs';

const REFERENCE_DIR = 'docs/sdk/site/reference';

/** The `@indx-workspace/sdk/define` files the `sdk/define.mdx` page is generated from. */
const DEFINE_SOURCES = [
  'packages/sdk/src/define/index.ts',
  'packages/sdk/src/define/agent.ts',
  'packages/sdk/src/define/surface.ts',
  'packages/sdk/src/define/references.ts',
  'packages/sdk/src/define/version-body.ts',
  'packages/sdk/src/define/errors.ts',
  'packages/sdk/src/define/brand.ts',
];

/** The `@indx-workspace/sdk/project` files the `sdk/project.mdx` page is generated from. */
const PROJECT_SOURCES = [
  'packages/sdk/src/project/index.ts',
  'packages/sdk/src/project/reader.ts',
  'packages/sdk/src/project/writer.ts',
  'packages/sdk/src/project/parse.ts',
  'packages/sdk/src/project/render.ts',
  'packages/sdk/src/project/errors.ts',
];

/** @param {string} repoRoot @param {string} relativePath */
function abs(repoRoot, relativePath) {
  return path.join(repoRoot, ...relativePath.split('/'));
}

/** @param {string} repoRoot */
function renderSdkPages(repoRoot) {
  const sdk = createPackageProgram(abs(repoRoot, 'packages/sdk/tsconfig.json'));
  const indexFile = sourceFileOf(sdk.program, abs(repoRoot, 'packages/sdk/src/index.ts'));
  const httpFile = sourceFileOf(sdk.program, abs(repoRoot, 'packages/sdk/src/http.ts'));
  const errorsFile = sourceFileOf(sdk.program, abs(repoRoot, 'packages/sdk/src/errors.ts'));
  const eventsIndexFile = sourceFileOf(
    sdk.program,
    abs(repoRoot, 'packages/sdk/src/events/index.ts'),
  );

  const defineIndexFile = sourceFileOf(
    sdk.program,
    abs(repoRoot, 'packages/sdk/src/define/index.ts'),
  );
  const projectIndexFile = sourceFileOf(
    sdk.program,
    abs(repoRoot, 'packages/sdk/src/project/index.ts'),
  );

  const pages = new Map();
  pages.set('sdk/client.mdx', renderClientPage(sdk.checker, { indexFile, httpFile, errorsFile }));
  pages.set('sdk/events.mdx', renderEventsPage(sdk.checker, eventsIndexFile));
  pages.set(
    'sdk/define.mdx',
    renderSubpathPage(sdk.checker, defineIndexFile, {
      title: 'Define',
      description:
        'The `@indx-workspace/sdk/define` exports: defineAgent, defineSurface, mcp, skill, files and toAgentVersionBody — agents and surfaces as code.',
      sources: DEFINE_SOURCES,
    }),
  );
  pages.set(
    'sdk/project.mdx',
    renderSubpathPage(sdk.checker, projectIndexFile, {
      title: 'Project',
      description:
        'The `@indx-workspace/sdk/project` exports: readProjectFileText, parseProjectFile, renderProjectFiles, renderProjectShell and projectNameFor — the one reader and the one renderer of agent-workspace.yaml and the project files.',
      sources: PROJECT_SOURCES,
    }),
  );
  for (const family of familyClientNames(sdk.checker, indexFile)) {
    const familyFile = sourceFileOf(
      sdk.program,
      abs(repoRoot, `packages/sdk/src/resources/${family.property}.ts`),
    );
    pages.set(`sdk/${family.property}.mdx`, renderFamilyPage(sdk.checker, family, familyFile));
  }
  return pages;
}

/** @param {string} repoRoot */
function contractsModuleFiles(repoRoot) {
  return [
    { label: 'index', file: abs(repoRoot, 'packages/contracts/src/index.ts') },
    ...contractsModules(repoRoot).map((name) => ({
      label: name,
      file: abs(repoRoot, `packages/contracts/src/${name}.ts`),
    })),
  ];
}

/**
 * Every zod-schema `const` export across every contracts module, keyed by its declaring file.
 * @param {import('typescript').TypeChecker} checker
 * @param {readonly { readonly sourceFile: import('typescript').SourceFile }[]} modules
 */
function zodProbeRequests(checker, modules) {
  /** @type {Map<string, string[]>} */
  const requests = new Map();
  for (const { sourceFile } of modules) {
    for (const entry of moduleExports(checker, sourceFile)) {
      if (entry.kind !== 'variable' || !isZodSchemaType(checker.getTypeAtLocation(entry.node)))
        continue;
      const declaringFile = entry.node.getSourceFile().fileName;
      const exportName = entry.symbol.getName();
      const existing = requests.get(declaringFile) ?? [];
      if (!existing.includes(exportName)) existing.push(exportName);
      requests.set(declaringFile, existing);
    }
  }
  return requests;
}

/** @param {string} repoRoot */
function renderContractsPages(repoRoot) {
  const configPath = abs(repoRoot, 'packages/contracts/tsconfig.json');
  const real = createPackageProgram(configPath);
  const modules = contractsModuleFiles(repoRoot).map(({ label, file }) => ({
    label,
    sourceFile: sourceFileOf(real.program, file),
  }));
  const probe = buildProbeProgram(configPath, zodProbeRequests(real.checker, modules));

  const pages = new Map();
  for (const { label, sourceFile } of modules) {
    const probeSourceFile = sourceFileOf(probe.program, sourceFile.fileName);
    pages.set(
      `contracts/${label}.mdx`,
      renderContractsModulePage(probe.checker, probe.program, label, probeSourceFile),
    );
  }
  return pages;
}

/** @param {string} repoRoot */
function renderCliPages(repoRoot) {
  const aw = createPackageProgram(abs(repoRoot, 'packages/aw/tsconfig.json'));
  const indexFile = sourceFileOf(aw.program, abs(repoRoot, 'packages/aw/src/commands/index.ts'));
  const helpFile = sourceFileOf(aw.program, abs(repoRoot, 'packages/aw/src/help.ts'));
  const outputFile = sourceFileOf(aw.program, abs(repoRoot, 'packages/aw/src/output.ts'));

  const specifiers = importSpecifiers(indexFile);
  const commandsDir = path.dirname(abs(repoRoot, 'packages/aw/src/commands/index.ts'));
  const filesByIdentifier = new Map();
  for (const identifier of commandArrayOrder(indexFile)) {
    const specifier = specifiers.get(identifier);
    if (specifier === undefined) {
      // A miss is a generator bug (an import shape it cannot read), not a missing group.
      throw new Error(`no import declares ${identifier} in commands/index.ts`);
    }
    const filePath = path.join(commandsDir, specifier.replace(/\.js$/u, '.ts'));
    filesByIdentifier.set(identifier, sourceFileOf(aw.program, filePath));
  }

  const pages = new Map();
  pages.set(
    'cli/commands.mdx',
    renderCliPage({ indexFile, helpFile, outputFile }, filesByIdentifier),
  );
  return pages;
}

/**
 * Render every `docs/sdk/site/reference/**` page from source, keyed by its path relative to that
 * directory (e.g. `sdk/client.mdx`), sorted.
 * @param {string} repoRoot
 * @returns {Promise<Map<string, string>>}
 */
export async function renderReferencePages(repoRoot) {
  const pages = new Map([
    ...renderSdkPages(repoRoot),
    ...renderContractsPages(repoRoot),
    ...renderCliPages(repoRoot),
  ]);
  return new Map([...pages.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

/**
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function listFilesRecursively(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const results = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const nested = await listFilesRecursively(path.join(dir, entry.name));
      results.push(...nested.map((relativePath) => `${entry.name}/${relativePath}`));
    } else {
      results.push(entry.name);
    }
  }
  return results;
}

/**
 * Compare rendered pages against what is committed under `outDir`, byte for byte.
 * @param {ReadonlyMap<string, string>} pages
 * @param {string} outDir
 * @returns {Promise<{ readonly ok: boolean, readonly issues: readonly string[] }>}
 */
export async function compareWithDisk(pages, outDir) {
  const issues = [];
  for (const [relativePath, content] of pages) {
    const diskPath = path.join(outDir, ...relativePath.split('/'));
    let existing;
    try {
      existing = await readFile(diskPath, 'utf8');
    } catch {
      issues.push(`missing: ${relativePath} — run \`pnpm docs:generate\``);
      continue;
    }
    if (existing !== content) issues.push(`stale: ${relativePath} — run \`pnpm docs:generate\``);
  }
  const known = new Set(pages.keys());
  for (const relativePath of await listFilesRecursively(outDir)) {
    if (!known.has(relativePath))
      issues.push(`extra: ${relativePath} — run \`pnpm docs:generate\``);
  }
  return { ok: issues.length === 0, issues };
}

/** @param {ReadonlyMap<string, string>} pages @param {string} outDir */
async function writePages(pages, outDir) {
  const existing = await listFilesRecursively(outDir);
  for (const [relativePath, content] of pages) {
    const diskPath = path.join(outDir, ...relativePath.split('/'));
    await mkdir(path.dirname(diskPath), { recursive: true });
    await writeFile(diskPath, content, 'utf8');
  }
  const known = new Set(pages.keys());
  await Promise.all(
    existing
      .filter((relativePath) => !known.has(relativePath))
      .map((relativePath) => rm(path.join(outDir, ...relativePath.split('/')))),
  );
}

/** @param {readonly string[]} argv @param {string} repoRoot */
async function main(argv, repoRoot) {
  const outDir = abs(repoRoot, REFERENCE_DIR);
  if (argv.includes('--write')) {
    const pages = await renderReferencePages(repoRoot);
    await writePages(pages, outDir);
    process.stdout.write(`wrote ${String(pages.size)} reference pages under ${REFERENCE_DIR}\n`);
    return 0;
  }
  if (argv.includes('--check')) {
    const pages = await renderReferencePages(repoRoot);
    const result = await compareWithDisk(pages, outDir);
    if (result.ok) {
      process.stdout.write(`${REFERENCE_DIR} is current with source\n`);
      return 0;
    }
    process.stderr.write(
      `${REFERENCE_DIR} is stale:\n${result.issues.map((issue) => `  ${issue}\n`).join('')}`,
    );
    return 1;
  }
  process.stderr.write('usage: generate-sdk-reference.mjs --write | --check\n');
  return 2;
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  pathToFileURL(path.resolve(invokedPath)).href === import.meta.url
) {
  const repoRoot = path.resolve(fileURLToPath(import.meta.url), '../../..');
  process.exitCode = await main(process.argv.slice(2), repoRoot);
}
