import { readFileSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { consumerEnvironment, runInConsumer } from './consumer-process.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FOREIGN_SCOPE = '@agent-workspace/';

/**
 * Every `@indx-workspace/*` module specifier the given documents import, in any of the forms
 * `import { x } from '…'`, `import '…'` and `import('…')`.
 * @param {readonly string[]} documents
 * @returns {string[]}
 */
export function importedSpecifiers(documents) {
  const pattern =
    /(?:\bfrom\s+|\bimport\s*\(?\s*)['"](@indx-workspace\/[a-z-]+(?:\/[a-z-]+)*)['"]/gu;
  /** @type {Set<string>} */
  const specifiers = new Set();
  for (const document of documents) {
    for (const match of document.matchAll(pattern)) specifiers.add(match[1] ?? '');
  }
  return [...specifiers].sort();
}

/** @param {string} directory @returns {Promise<string[]>} */
async function siteDocuments(directory) {
  /** @type {string[]} */
  const documents = [];
  for (const entry of await readdir(directory, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name.endsWith('.mdx')) {
      documents.push(await readFile(path.join(entry.parentPath, entry.name), 'utf8'));
    }
  }
  return documents;
}

const CONSUMER_SOURCE = `import '@indx-workspace/react/styles.css';
import { createClient, ApiProblemError } from '@indx-workspace/sdk';
import { fetchDouble, fixtures, jsonResponse, type RecordedRequest } from '@indx-workspace/sdk/testing';
import { RunResourceSchema, type RunResource } from '@indx-workspace/contracts/runs';

const run: RunResource = fixtures.run({ status: 'completed' });
const api = fetchDouble((request: RecordedRequest) => jsonResponse(200, { run: RunResourceSchema.parse(run) }, { 'x-request': request.method }));
const aw = createClient({ baseUrl: 'https://aw.example.com', auth: { kind: 'api-key', apiKey: 'k' }, fetch: api.fetch });
const settled: Promise<RunResource> = aw.runs.get(run.id);
export const checks: readonly unknown[] = [settled, ApiProblemError, fixtures.agent().name, fixtures.session().status];
`;

/**
 * Type-check a strict consumer against the installed packages' published declarations. TypeScript
 * is imported here, not at the top, so `publish-packages.mjs`, which imports this module, runs in
 * the publish job with no `node_modules`.
 */
async function typecheckConsumer(/** @type {string} */ consumer) {
  const { default: ts } = await import('typescript');
  const file = path.join(consumer, 'consumer.ts');
  const program = ts.createProgram([file], {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2023,
    lib: ['lib.es2023.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
    types: [],
    strict: true,
    exactOptionalPropertyTypes: true,
    noUncheckedIndexedAccess: true,
    skipLibCheck: false,
    noEmit: true,
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length > 0) {
    const host = {
      getCanonicalFileName: (/** @type {string} */ name) => name,
      getCurrentDirectory: () => consumer,
      getNewLine: () => '\n',
    };
    throw new Error(
      `the consumer does not type-check:\n${ts.formatDiagnostics(diagnostics, host)}`,
    );
  }
}

/** A digest reference no registry is asked about: the generator accepts it without a network. */
const OFFLINE_DIGEST = (/** @type {string} */ image, /** @type {number} */ n) =>
  `registry.invalid/${image}@sha256:${String(n).repeat(64)}`;

/**
 * The `npm create @indx-workspace <directory> ...args` runs of the smoke, each with the exact
 * dependencies its generated `package.json` must declare at the release version. The flags follow
 * npm's `--`, so they reach the bin: before it, npm would take `--yes` as its own and drop it.
 *
 * - `generated`: `-- --cloud local`, the v1 Compose project, whose four answers are the defaults without a person.
 * - `v2`: `-- --yes --no-install`, the default v2 project with the recommended answers (S1-16); the smoke installs from the tarballs itself.
 *   Besides the three packages it pins the default engine's (#691), which `enginePackages` names:
 *   the smoke reads them from the `ENGINE_PACKAGES` of the SDK it installed from its tarball.
 * @type {ReadonlyArray<Readonly<{ directory: string, args: readonly string[], dependencies: (version: string, enginePackages: Readonly<Record<string, string>>) => Record<string, string> }>>}
 */
export const CREATE_SMOKE_CASES = Object.freeze([
  Object.freeze({
    directory: 'generated',
    args: Object.freeze(['--offline', '--', '--cloud', 'local']),
    dependencies: (/** @type {string} */ version) => ({ '@indx-workspace/cli': version }),
  }),
  Object.freeze({
    directory: 'v2',
    args: Object.freeze(['--offline', '--', '--yes', '--no-install']),
    dependencies: (
      /** @type {string} */ version,
      /** @type {Readonly<Record<string, string>>} */ enginePackages,
    ) => ({
      '@indx-workspace/aw': version,
      '@indx-workspace/embedded': version,
      '@indx-workspace/sdk': version,
      ...enginePackages,
    }),
  }),
]);

/**
 * Every problem with a `package.json` that `npm create` wrote: text that is not a JSON object,
 * `dependencies` that are not exactly `expected` (compared as sorted entries, so the key order the
 * generator writes does not matter, but an extra, a missing or a different version does), and a
 * `workspace:` specifier or an `@agent-workspace/` name anywhere in the text.
 * @param {string} text @param {Readonly<Record<string, string>>} expected
 * @returns {string[]}
 */
export function checkCreatedManifest(text, expected) {
  /** @type {string[]} */
  const problems = [];
  if (text.includes('workspace:')) problems.push('keeps a workspace: specifier');
  if (text.includes(FOREIGN_SCOPE)) problems.push(`names ${FOREIGN_SCOPE}`);
  /** @type {unknown} */
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch {
    return [...problems, 'is not JSON'];
  }
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    return [...problems, 'is not a JSON object'];
  }
  const dependencies = /** @type {Record<string, unknown>} */ (manifest)['dependencies'];
  const sorted = (/** @type {object} */ value) =>
    JSON.stringify(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  if (
    typeof dependencies !== 'object' ||
    dependencies === null ||
    Array.isArray(dependencies) ||
    sorted(dependencies) !== sorted(expected)
  ) {
    problems.push(
      `dependencies are ${JSON.stringify(dependencies)}, not exactly ${JSON.stringify(expected)}`,
    );
  }
  return problems;
}

/**
 * Run every {@link CREATE_SMOKE_CASES} entry in `consumer`, where the tarballs are installed,
 * without the network: npm runs the installed `@indx-workspace/create`, every image override is a
 * digest reference (so nothing is resolved from a registry), and no person is there (stdin is
 * empty, so every v1 answer is the default, and the v2 run relies on `--yes`). Each generated `package.json` must
 * pass {@link checkCreatedManifest} with its case's dependencies at the release version.
 * @param {string} consumer @param {string} version
 */
function smokeCreate(consumer, version) {
  // The default engine's packages as the SDK installed from its tarball names them, read by a
  // child Node in `consumer` so the specifier resolves there.
  const printed = runInConsumer(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "import { ENGINE_PACKAGES } from '@indx-workspace/sdk/project'; " +
        "process.stdout.write(JSON.stringify(ENGINE_PACKAGES['claude-agent-sdk']));",
    ],
    consumer,
  );
  const defaultEnginePackages = /** @type {Record<string, string>} */ (JSON.parse(printed));
  const images = ['web', 'gateway', 'runner', 'runtime', 'postgres', 'seaweedfs'];
  /** @type {NodeJS.ProcessEnv} */
  const env = {
    ...consumerEnvironment(process.env),
    npm_config_offline: 'true',
    npm_config_update_notifier: 'false',
  };
  images.forEach((image, index) => {
    env[`AW_${image.toUpperCase()}_IMAGE`] = OFFLINE_DIGEST(image, index + 1);
  });
  for (const { directory, args, dependencies } of CREATE_SMOKE_CASES) {
    runInConsumer('npm', ['create', '@indx-workspace', directory, ...args], consumer, {
      env,
      input: '',
    });
    const text = readFileSync(path.join(consumer, directory, 'package.json'), 'utf8');
    const problems = checkCreatedManifest(text, dependencies(version, defaultEnginePackages));
    if (problems.length > 0) {
      throw new Error(
        `npm create @indx-workspace ${directory} ${args.join(' ')} wrote a package.json that ${problems.join('; ')}:\n${text}`,
      );
    }
  }
}

/**
 * The module that imports every specifier, as a customer would. A specifier whose export target is
 * a JSON file (`@indx-workspace/embedded/package.json`) is imported with `{ type: 'json' }`: Node
 * refuses a JSON module without the attribute (`ERR_IMPORT_ATTRIBUTE_MISSING`). A specifier whose
 * target is a stylesheet (`@indx-workspace/react/styles.css`) cannot be imported at all
 * (`ERR_UNKNOWN_FILE_EXTENSION`): it is resolved inside the install and must be a non-empty file.
 * @param {Iterable<string>} specifiers
 * @param {ReadonlySet<string>} jsonSpecifiers
 * @param {ReadonlySet<string>} [cssSpecifiers]
 * @returns {string}
 */
export function resolveProbe(specifiers, jsonSpecifiers, cssSpecifiers = new Set()) {
  const lines = [...specifiers].map((specifier) => {
    const name = JSON.stringify(specifier);
    if (cssSpecifiers.has(specifier)) {
      return `if (readFileSync(fileURLToPath(import.meta.resolve(${name}))).length === 0) throw new Error(${JSON.stringify(`${specifier} is empty`)});`;
    }
    return jsonSpecifiers.has(specifier)
      ? `await import(${name}, { with: { type: 'json' } });`
      : `await import(${name});`;
  });
  const head = cssSpecifiers.size
    ? "import { readFileSync } from 'node:fs';\nimport { fileURLToPath } from 'node:url';\n"
    : '';
  return `${head}${lines.join('\n')}\n`;
}

/**
 * Install the tarballs into an empty project and use them the way a customer would.
 * @param {ReadonlyArray<{ tarball: string, manifest: Record<string, unknown> }>} packed
 * @param {string} version
 */
export async function smoke(packed, version) {
  const consumer = await mkdtemp(path.join(tmpdir(), 'indx-workspace-consumer-'));
  try {
    /** @type {Record<string, string>} */
    const dependencies = {};
    for (const { tarball, manifest } of packed) {
      const relative = path.relative(consumer, tarball).split(path.sep).join('/');
      dependencies[String(manifest['name'])] = `file:${relative}`;
    }
    await writeFile(
      path.join(consumer, 'package.json'),
      JSON.stringify({
        name: 'consumer',
        private: true,
        type: 'module',
        dependencies,
        overrides: dependencies,
      }),
    );
    runInConsumer('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts'], consumer);

    const specifiers = new Set(
      importedSpecifiers(await siteDocuments(path.join(ROOT, 'docs/sdk/site'))),
    );
    /** @type {Set<string>} */
    const jsonSpecifiers = new Set();
    /** @type {Set<string>} */
    const cssSpecifiers = new Set();
    for (const { manifest } of packed) {
      const exportsMap = /** @type {Record<string, unknown>} */ (manifest['exports'] ?? {});
      for (const [key, target] of Object.entries(exportsMap)) {
        const specifier =
          key === '.' ? String(manifest['name']) : `${String(manifest['name'])}/${key.slice(2)}`;
        specifiers.add(specifier);
        // A stylesheet export is `{ types, default }`, so a strict consumer can import it.
        const file =
          typeof target === 'object' && target !== null
            ? /** @type {Record<string, unknown>} */ (target)['default']
            : target;
        if (typeof file === 'string' && file.endsWith('.json')) jsonSpecifiers.add(specifier);
        if (typeof file === 'string' && file.endsWith('.css')) cssSpecifiers.add(specifier);
      }
    }
    await writeFile(
      path.join(consumer, 'resolve.mjs'),
      resolveProbe(specifiers, jsonSpecifiers, cssSpecifiers),
    );
    runInConsumer(process.execPath, ['resolve.mjs'], consumer);

    await writeFile(path.join(consumer, 'consumer.ts'), CONSUMER_SOURCE);
    await typecheckConsumer(consumer);

    const printed = runInConsumer('npx', ['--no-install', 'aw', '--version'], consumer);
    const expected = `aw ${version} (contracts ${version})`;
    if (printed.trim() !== expected)
      throw new Error(`npx aw --version printed ${printed}, not ${expected}`);

    const operatorVersion = runInConsumer(
      'npx',
      ['--no-install', 'agent-workspace', '--version'],
      consumer,
    );
    const operatorExpected = `agent-workspace ${version} (contracts ${version})`;
    if (operatorVersion.trim() !== operatorExpected) {
      throw new Error(
        `npx agent-workspace --version printed ${operatorVersion}, not ${operatorExpected}`,
      );
    }

    const help = runInConsumer('npx', ['--no-install', 'agent-workspace', '--help'], consumer);
    if (!help.startsWith('Usage: agent-workspace start|stop|validate')) {
      throw new Error(`npx agent-workspace --help printed ${help}`);
    }
    smokeCreate(consumer, version);
    return [...specifiers].sort();
  } finally {
    await rm(consumer, { recursive: true, force: true });
  }
}
