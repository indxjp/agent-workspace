#!/usr/bin/env node
/**
 * Generates `docs/sdk/api/<package>/<subpath>.api.md`, the API Extractor report of every
 * `exports` subpath of the published consumer packages (contracts, sdk, react, aw). A report is
 * the full public declaration (signatures, members, generics), so a breaking change reads as a
 * normal diff before the package is published. `--write` regenerates the reports
 * (`pnpm api:update`), `--check` renders them in a scratch directory and fails when a committed
 * file differs (`docs:check`). The reports are generated, never hand-edited.
 *
 * No build is needed (the ADR-0054 rule): the declarations are emitted from each package's own
 * `tsconfig.build.json` into a scratch directory, and API Extractor reads those.
 */
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Extractor, ExtractorConfig, ExtractorLogLevel } from '@microsoft/api-extractor';
import ts from 'typescript';

/** Repo-relative directory of the committed reports. */
export const API_DIR = 'docs/sdk/api';
export const API_PACKAGES = ['contracts', 'sdk', 'react', 'aw'];

/** @param {string} directory @returns {Promise<string[]>} every file under it, relative, sorted */
async function listFiles(directory) {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true }).catch(
    () => [],
  );
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(directory, path.join(entry.parentPath, entry.name)))
    .map((file) => file.split(path.sep).join('/'))
    .sort();
}

/** `./define` becomes `define`, `./tools/host` becomes `tools-host`, `.` becomes `index`. */
const reportName = (/** @type {string} */ subpath) =>
  subpath === '.' ? 'index' : subpath.slice(2).replaceAll('/', '-');

/**
 * API Extractor writes CRLF on Windows and names the scratch declarations in its warnings; the
 * repository is LF and those declarations are what `dist` holds.
 * @param {string} text @param {string} scratch
 */
function normalise(text, scratch) {
  let result = text.replaceAll('\r\n', '\n');
  for (const name of API_PACKAGES) {
    const declarations = path.join(scratch, name, 'declarations').split(path.sep).join('/');
    result = result.replaceAll(declarations, 'dist');
  }
  // Positions churn on unrelated edits; the symbol named in the message is the signal.
  return result.replaceAll(/^(\/\/ dist\/\S+?):\d+:\d+ - /gm, '$1 - ');
}

/**
 * Emits the declarations of one package into `declarations` (the layout `dist` would have).
 * @param {string} directory @param {string} declarations
 */
function emitDeclarations(directory, declarations) {
  const configPath = path.join(directory, 'tsconfig.build.json');
  const host = { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined };
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, host);
  if (parsed === undefined) throw new Error(`could not parse ${configPath}`);
  const program = ts.createProgram({
    rootNames: parsed.fileNames,
    options: {
      ...parsed.options,
      outDir: declarations,
      declarationMap: false,
      sourceMap: false,
      emitDeclarationOnly: true,
      noEmit: false,
    },
  });
  const result = program.emit();
  const errors = [...ts.getPreEmitDiagnostics(program), ...result.diagnostics].filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  if (errors.length > 0) {
    throw new Error(
      ts.formatDiagnostics(errors, {
        getCanonicalFileName: (file) => file,
        getNewLine: () => '\n',
        getCurrentDirectory: () => directory,
      }),
    );
  }
}

/**
 * Renders every report of one package into `<out>/<package>/`.
 * @param {string} repoRoot @param {string} name @param {string} scratch @param {string} out
 * @returns {Promise<string[]>} API Extractor error messages
 */
async function renderPackage(repoRoot, name, scratch, out) {
  const directory = path.join(repoRoot, 'packages', name);
  const manifestPath = path.join(directory, 'package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const declarations = path.join(scratch, name, 'declarations');
  emitDeclarations(directory, declarations);
  /** @type {string[]} */
  const failures = [];
  for (const [subpath, target] of Object.entries(manifest.exports)) {
    const types = typeof target === 'object' && target !== null ? target.types : undefined;
    // `styles.css` and its `.d.css.ts` are a stylesheet, not a code surface.
    if (typeof types !== 'string' || subpath.endsWith('.css')) continue;
    const entry = path.join(
      declarations,
      types.replace(/^\.\/src\//, '').replace(/\.ts$/, '.d.ts'),
    );
    const file = reportName(subpath);
    const tempFolder = path.join(scratch, name, 'temp', file);
    await mkdir(path.join(out, name), { recursive: true });
    await mkdir(tempFolder, { recursive: true });
    /** @type {import('@microsoft/api-extractor').IConfigFile} */
    const configObject = {
      projectFolder: directory,
      mainEntryPointFilePath: entry,
      compiler: { overrideTsconfig: { compilerOptions: { skipLibCheck: true } } },
      apiReport: {
        enabled: true,
        // A public type's forgotten dependencies are part of its shape; keep them in the report.
        includeForgottenExports: true,
        reportFileName: `${file}.api.md`,
        reportFolder: path.join(out, name),
        reportTempFolder: tempFolder,
      },
      docModel: { enabled: false },
      dtsRollup: { enabled: false },
      tsdocMetadata: { enabled: false },
      messages: {
        compilerMessageReporting: { default: { logLevel: ExtractorLogLevel.Error } },
        extractorMessageReporting: {
          default: { logLevel: ExtractorLogLevel.Error, addToApiReportFile: true },
          // Every export of these packages is public; a release tag per symbol would be noise.
          'ae-missing-release-tag': { logLevel: ExtractorLogLevel.None },
          // Documentation coverage, not API shape; the warning would also carry a scratch path.
          'ae-undocumented': { logLevel: ExtractorLogLevel.None },
          'ae-unresolved-link': { logLevel: ExtractorLogLevel.None },
        },
        // Comment-syntax lint, not API: the repository's own lint owns doc comments.
        tsdocMessageReporting: { default: { logLevel: ExtractorLogLevel.None } },
      },
    };
    const config = ExtractorConfig.prepare({
      configObject,
      configObjectFullPath: path.join(directory, 'api-extractor.json'),
      packageJsonFullPath: manifestPath,
    });
    const result = Extractor.invoke(config, {
      localBuild: true,
      showVerboseMessages: false,
      messageCallback: (message) => {
        if (message.logLevel === ExtractorLogLevel.Error)
          failures.push(`${name} ${subpath}: ${message.text}`);
        message.handled = true;
      },
    });
    if (!result.succeeded && failures.length === 0) failures.push(`${name} ${subpath}: failed`);
  }
  return failures;
}

/** @param {readonly string[]} argv @param {string} repoRoot */
async function main(argv, repoRoot) {
  const write = argv.includes('--write');
  // ponytail: test seam, lets the tamper test compare against a copy instead of docs/sdk/api.
  const reportsAt = argv.find((arg) => arg.startsWith('--reports='))?.slice('--reports='.length);
  if (!write && !argv.includes('--check')) {
    process.stderr.write('usage: generate-api-reports.mjs --write | --check\n');
    return 2;
  }
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'aw-api-reports-'));
  const rendered = path.join(scratch, 'reports');
  try {
    /** @type {string[]} */
    const failures = [];
    for (const name of API_PACKAGES) {
      failures.push(...(await renderPackage(repoRoot, name, scratch, rendered)));
    }
    if (failures.length > 0) {
      process.stderr.write(`API Extractor failed:\n${failures.join('\n')}\n`);
      return 1;
    }
    const committedDir = reportsAt === undefined ? path.join(repoRoot, API_DIR) : reportsAt;
    const files = await listFiles(rendered);
    if (write) {
      await rm(committedDir, { recursive: true, force: true });
      for (const file of files) {
        const target = path.join(committedDir, file);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(
          target,
          normalise(await readFile(path.join(rendered, file), 'utf8'), scratch),
        );
      }
      process.stdout.write(`wrote ${files.length} API reports under ${API_DIR}\n`);
      return 0;
    }
    const committed = await listFiles(committedDir);
    const stale = [];
    for (const file of new Set([...files, ...committed])) {
      const want = files.includes(file)
        ? normalise(await readFile(path.join(rendered, file), 'utf8'), scratch)
        : undefined;
      const have = committed.includes(file)
        ? await readFile(path.join(committedDir, file), 'utf8')
        : undefined;
      if (want !== have) stale.push(`${API_DIR}/${file}`);
    }
    if (stale.length === 0) {
      process.stdout.write(`${API_DIR} is current with source\n`);
      return 0;
    }
    process.stderr.write(
      `The public API changed: ${stale.join(', ')}.\n` +
        'If the change is intended, run `pnpm api:update` and commit the regenerated reports;\n' +
        'review the diff, because it is what consumers of the published package will see.\n',
    );
    return 1;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  pathToFileURL(path.resolve(invokedPath)).href === import.meta.url
) {
  const repoRoot = path.resolve(fileURLToPath(import.meta.url), '../../..');
  process.exitCode = await main(process.argv.slice(2), repoRoot);
}
