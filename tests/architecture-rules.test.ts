/**
 * Proof that the dependency-cruiser rules fire: #1154 (engine adapter boundaries), #1188 (wire
 * modules never name a database record), #1621 (the storage design, §07 rules 1 and 2), #1678
 * (§07 rule 3), #1500 (the app kit's fences) and AGENTS.md hexagonal rule 2 (a domain core is pure).
 *
 * A rule nothing tests can lose its `pathNot` or `from` pattern in an edit and keep reporting a
 * green `pnpm architecture:check`. This runs the real CLI with the real config, exactly as that
 * script does, against a small tree of planted violations written to a temp directory. Writing the
 * tree at run time keeps deliberately violating sources out of the type-checked and knip-scanned
 * repository. The expected violations are listed exhaustively, so the allowed edges, and an
 * import that stopped resolving, are covered too.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cruiseBin = path.join(repoRoot, 'node_modules/dependency-cruiser/bin/dependency-cruiser.mjs');
const cruiseConfig = path.join(repoRoot, 'dependency-cruiser.config.mjs');

const dbImport =
  "import type { Row } from '@agent-workspace/core/db';\nexport type Mapped = Row;\n";

const routeImports = [
  "export { b } from '../b/route';",
  "export * from '../../../../../packages/core/src/index';",
  '',
].join('\n');

// A fake package under the temp tree's node_modules resolves the way the real SDK does, so the
// planted SDK edges prove the rules see resolved npm imports, not only unresolved specifiers.
// Azure's entry sits under `dist/` because the real package's does.
function fakePackage(name: string, entry = 'index.js'): Readonly<Record<string, string>> {
  return {
    [`node_modules/${name}/package.json`]: JSON.stringify({ name, main: entry }),
    [`node_modules/${name}/${entry}`]: 'exports.x = 1;\n',
  };
}

const objectStorageImports = [
  "import type { ObjectStore } from '../../../../packages/core/src/storage/object-store';",
  "export * from '../../../../packages/core/src/storage/key-safety';",
  "export * from '../../../../packages/core/src/storage/content-type';",
  "export * from '../../../../packages/core/src/storage/object-name';",
  'export type Store = ObjectStore;',
  '',
].join('\n');

const sdkImport = (...specifiers: readonly string[]): string =>
  `${specifiers.map((specifier) => `import '${specifier}';`).join('\n')}\nexport {};\n`;

const fixture: Readonly<Record<string, string>> = {
  ...fakePackage('@aws-sdk/client-s3'),
  ...fakePackage('@aws-sdk/s3-request-presigner'),
  ...fakePackage('@google-cloud/storage'),
  ...fakePackage('@azure/storage-blob', 'dist/commonjs/index.js'),
  ...fakePackage('@azure/identity'),
  'tsconfig.architecture.json': JSON.stringify({
    compilerOptions: {
      module: 'esnext',
      moduleResolution: 'bundler',
      paths: { '@agent-workspace/core/db': ['./packages/core/src/db/index.ts'] },
    },
  }),
  'packages/engine/src/index.ts': 'export const port = 1;\n',
  'packages/contracts/src/index.ts': 'export const contract = 1;\n',
  'packages/core/src/index.ts': 'export const core = 1;\n',
  'packages/core/src/db/index.ts': 'export interface Row {\n  id: string;\n}\n',
  'packages/engine-mastra/src/index.ts': 'export const mastra = 1;\n',
  // The adapter may see the port and the contracts, and nothing else (#1154).
  'packages/engine-pi/src/index.ts': [
    "export * from '../../engine/src/index';",
    "export * from '../../contracts/src/index';",
    "export * from '../../core/src/index';",
    "export * from '../../engine-mastra/src/index';",
    '',
  ].join('\n'),
  // The Claude adapter may also see run-protocol, but neither core nor another adapter (#1154,
  // F-08).
  'packages/engine-claude-agent-sdk/src/index.ts': [
    "export * from '../../run-protocol/src/index';",
    "export * from '../../core/src/index';",
    "export * from '../../engine-pi/src/index';",
    '',
  ].join('\n'),
  'packages/sdk/src/index.ts': 'export const sdk = 1;\n',
  'packages/aw/src/index.ts': 'export const aw = 1;\n',
  'packages/react/src/index.ts': 'export const react = 1;\n',
  // #1500: the app kit reaches only the published sdk, contracts and react, never core or an
  // application; and nothing else in the workspace imports the app kit.
  'packages/app/src/index.ts': [
    "export * from '../../sdk/src/index';",
    "export * from '../../contracts/src/index';",
    "export * from '../../react/src/index';",
    "export * from '../../core/src/index';",
    "export * from '../../../apps/web/server/agents/store';",
    '',
  ].join('\n'),
  'packages/react/src/uses-app.ts': "export * from '../../app/src/index';\n",
  'apps/web/server/agents/app-kit.ts': "export * from '../../../../packages/app/src/index';\n",
  // F-15 boundaries. Each file below plants allowed edges and one forbidden edge.
  'packages/core/src/bad.ts': [
    "export * from '../../contracts/src/index';",
    "export * from '../../engine/src/index';",
    "export * from '../../run-protocol/src/index';",
    "export * from '../../sdk/src/index';",
    '',
  ].join('\n'),
  'packages/run-protocol/src/index.ts': [
    "export * from '../../contracts/src/index';",
    "export * from '../../engine/src/index';",
    "export * from '../../sdk/src/index';",
    '',
  ].join('\n'),
  'packages/runtime/src/index.ts': "export * from '../../contracts/src/index';\n",
  'packages/gateway/src/index.ts': [
    "export * from '../../core/src/index';",
    "export * from '../../contracts/src/index';",
    "export * from '../../runtime/src/index';",
    '',
  ].join('\n'),
  'packages/egress-proxy/src/index.ts': "export * from '../../contracts/src/index';\n",
  'packages/tool-host/src/index.ts': [
    "export * from '../../aw/src/index';",
    "export * from '../../contracts/src/index';",
    "export * from '../../egress-proxy/src/index';",
    "export * from '../../runtime/src/index';",
    '',
  ].join('\n'),
  // A library never imports an application, including the packages that were missing from the list.
  'packages/cli/src/index.ts': "export * from '../../../apps/web/server/agents/store';\n",
  'packages/create/src/index.ts': "export * from '../../../apps/web/server/agents/store';\n",
  // Wire modules never name a database record (#1188); a store may.
  'apps/web/server/secrets/contract.ts': dbImport,
  'apps/web/server/projects/resource.ts': dbImport,
  'apps/web/server/agents/store.ts': dbImport,
  // F-15 baseline rules: a route importing a route, app/** importing core, a domain importing db.
  'apps/web/app/api/a/route.ts': routeImports,
  'apps/web/app/api/b/route.ts': 'export const b = 1;\n',
  'apps/web/app/api/a/route.test.ts': routeImports,
  'apps/web/server/agents/service.ts': dbImport,
  'apps/web/server/agents/service.test.ts': dbImport,
  // The storage design, §07 rule 1: one boundary file per cloud, the CLI's bucket probe, and tests.
  'packages/core/src/storage/s3-store.ts': sdkImport('@aws-sdk/client-s3'),
  'packages/core/src/storage/gcs-store.ts': sdkImport('@google-cloud/storage'),
  'packages/core/src/storage/azure-blob-store.ts': sdkImport(
    '@azure/storage-blob',
    '@azure/identity',
  ),
  'packages/cli/src/validate.ts': sdkImport('@google-cloud/storage', '@aws-sdk/client-s3'),
  'packages/core/src/storage/signed-url.test.ts': sdkImport('@aws-sdk/client-s3'),
  'packages/core/src/storage/aws-s3-live.test.ts': sdkImport('@aws-sdk/client-s3'),
  'packages/core/src/storage/gcs-store.live.test.ts': sdkImport('@google-cloud/storage'),
  'packages/core/src/storage/azure-blob-store.live.acceptance.ts': sdkImport('@azure/storage-blob'),
  // Any other file is forbidden; `@azure/identity` is a credential library and stays allowed.
  'packages/core/src/storage/other.ts': sdkImport(
    '@aws-sdk/client-s3',
    '@aws-sdk/s3-request-presigner',
    '@google-cloud/storage',
    '@azure/storage-blob',
    '@azure/identity',
  ),
  // The storage design, §07 rule 2: app/** may not value-import a storage adapter.
  'apps/web/server/files/store.ts': 'export const filesStore = 1;\n',
  'apps/web/server/composition/storage.ts': 'export const storage = 1;\n',
  'apps/web/app/api/x/route.ts': [
    "export * from '../../../server/files/store';",
    "export * from '../../../server/composition/storage';",
    "export type * from '../../../server/agents/store';",
    '',
  ].join('\n'),
  'apps/web/app/api/x/route.test.ts': "export * from '../../../server/files/store';\n",
  // The storage design, §07 "Load test": the backends subpath loads two cloud SDKs; tests only.
  'packages/core/src/storage/backends.ts': 'export const backends = 1;\n',
  'packages/core/src/storage/uses-backends.ts': "export * from './backends';\n",
  'packages/core/src/storage/uses-backends.test.ts': "export * from './backends';\n",
  // #1746: a raw backend factory's createSignedUrl is unbounded, so only the storage module
  // itself (which wraps each in the scoped store) and tests may import a backend file.
  'packages/core/src/storage/open.ts': [
    "export * from './s3-store';",
    "export * from './gcs-store';",
    "export * from './azure-blob-store';",
    '',
  ].join('\n'),
  'apps/web/server/files/raw-store.ts': [
    "export * from '../../../../packages/core/src/storage/s3-store';",
    "export * from '../../../../packages/core/src/storage/gcs-store';",
    "export * from '../../../../packages/core/src/storage/azure-blob-store';",
    '',
  ].join('\n'),
  'apps/web/server/files/raw-store.test.ts':
    "export * from '../../../../packages/core/src/storage/s3-store';\n",
  // The storage design, §07 rule 3: only the catalog service reaches object storage. A domain may
  // import the pure helpers (content type, key safety, object name); a type-only import of
  // `ObjectStore` counts. The catalog service, the composition root, tests and the tool bundles
  // (not workspace files) may import the rest.
  'packages/core/src/storage/object-store.ts': 'export interface ObjectStore {\n  id: string;\n}\n',
  'packages/core/src/storage/key-safety.ts': 'export const toObjectKey = 1;\n',
  'packages/core/src/storage/content-type.ts': 'export const inferContentType = 1;\n',
  'packages/core/src/storage/object-name.ts': 'export const storageObjectName = 1;\n',
  'apps/web/server/foo/upload.ts': objectStorageImports,
  'apps/web/server/foo/upload.test.ts': objectStorageImports,
  'apps/web/server/storage/service.ts': objectStorageImports,
  'apps/web/server/composition/objects.ts': objectStorageImports,
  'apps/web/server/tool-bundles/handlers.ts': objectStorageImports,
  // AGENTS.md "Hexagonal rules" 2: a domain core imports only its own core/, the contracts and zod.
  // A Node built-in, an npm package, another server module (its own store and ports, type-only
  // too) and another domain's core are refused; a test beside the core may import anything.
  ...fakePackage('zod'),
  ...fakePackage('left-pad'),
  'apps/web/server/pilot/core/facts.ts': 'export const fact = 1;\n',
  'apps/web/server/pilot/core/decide.ts': [
    "export * from './facts';",
    "export * from '../../../../../packages/contracts/src/index';",
    "import 'zod';",
    "import 'node:fs';",
    "import 'left-pad';",
    "export * from '../store';",
    "export type * from '../ports';",
    "export * from '../../other/core/rules';",
    '',
  ].join('\n'),
  'apps/web/server/pilot/core/decide.test.ts': "import 'node:fs';\nexport * from '../store';\n",
  'apps/web/server/pilot/store.ts': 'export const pilotStore = 1;\n',
  'apps/web/server/pilot/ports.ts': 'export interface PilotPort {\n  id: string;\n}\n',
  'apps/web/server/other/core/rules.ts': 'export const rule = 1;\n',
  // Refactoring plan part 04: contexts import upstream only (apps/web/server/contexts.json). runs
  // (execution) may reach auth (identity) and http (shared kernel) but not agents; the shared kernel
  // reaches no context; no context reaches composition/, which may reach every context; a test may
  // import anything.
  'apps/web/server/agents/ctx-target.ts': 'export const agentsTarget = 1;\n',
  'apps/web/server/auth/ctx-target.ts': 'export const authTarget = 1;\n',
  'apps/web/server/http/ctx-target.ts': 'export const httpTarget = 1;\n',
  'apps/web/server/composition/ctx-target.ts': 'export const compositionTarget = 1;\n',
  'apps/web/server/evaluations/ctx-target.ts': 'export const evaluationsTarget = 1;\n',
  'apps/web/server/runs/ctx.ts': [
    "export * from '../agents';",
    "export * from '../auth/ctx-target';",
    "export * from '../http/ctx-target';",
    '',
  ].join('\n'),
  'apps/web/server/runs/ctx.test.ts': "export * from '../agents/ctx-target';\n",
  'apps/web/server/http/ctx.ts': "export * from '../auth/ctx-target';\n",
  'apps/web/server/agents/ctx.ts': [
    "export * from '../composition/ctx-target';",
    "export * from '../evaluations';",
    '',
  ].join('\n'),
  // evaluations has an entry (part 04, step 7), so the planted downstream import above goes through
  // it and only the direction rule fires.
  'apps/web/server/evaluations/index.ts': "export * from './ctx-target';\n",
  'apps/web/server/composition/ctx.ts': "export * from '../agents/ctx-target';\n",
  'apps/web/server/evaluations/ctx.ts': "export * from '../agents';\n",
  // agents has an entry too (part 04, step 7): the planted imports of agents above go through it, so
  // runs/ctx.ts fires only the direction rule and evaluations/ctx.ts fires nothing.
  'apps/web/server/agents/index.ts': "export * from './ctx-target';\n",
  // Part 04, step 7: identity has an entry (contexts.json), so another context reaches it only
  // through identity/index.ts. runs/ctx.ts above reaches auth/ deeply and is reported; the entry,
  // identity's own modules, composition/ and a test may still import auth/ directly.
  'apps/web/server/identity/index.ts': "export * from '../auth/ctx-target';\n",
  'apps/web/server/runs/ctx-entry.ts': "export * from '../identity';\n",
  'apps/web/server/rbac/ctx.ts': "export * from '../auth/ctx-target';\n",
  'apps/web/server/composition/ctx-identity.ts': "export * from '../auth/ctx-target';\n",
  'apps/web/server/runs/ctx-deep.test.ts': "export * from '../auth/ctx-target';\n",
};

const reportSchema = z.object({
  summary: z.object({
    violations: z.array(
      z.object({ rule: z.object({ name: z.string() }), from: z.string(), to: z.string() }),
    ),
  }),
});

interface Violation {
  readonly rule: string;
  readonly from: string;
  readonly to: string;
}

let workDir = '';
let violations: readonly Violation[] = [];

function violationsOf(rule: string): readonly Violation[] {
  return violations.filter((violation) => violation.rule === rule);
}

function edgesOf(rule: string): readonly string[] {
  return violationsOf(rule).map(({ from, to }) => `${from} -> ${to}`);
}

beforeAll(() => {
  workDir = mkdtempSync(path.join(tmpdir(), 'architecture-rules-'));
  for (const [file, content] of Object.entries(fixture)) {
    mkdirSync(path.dirname(path.join(workDir, file)), { recursive: true });
    writeFileSync(path.join(workDir, file), content);
  }
  const result = spawnSync(
    process.execPath,
    [cruiseBin, '--config', cruiseConfig, '--output-type', 'json', 'apps', 'packages'],
    { cwd: workDir, encoding: 'utf8' },
  );
  // dependency-cruiser exits with the violation count, so a non-zero status is expected here.
  if (result.error !== undefined || result.stdout.trim() === '') {
    throw new Error(
      `dependency-cruiser produced no report: ${result.error?.message ?? result.stderr}`,
    );
  }
  const report = reportSchema.parse(JSON.parse(result.stdout));
  violations = report.summary.violations
    .map(({ rule, from, to }) => ({ rule: rule.name, from, to }))
    .sort((a, b) => `${a.rule} ${a.from} ${a.to}`.localeCompare(`${b.rule} ${b.from} ${b.to}`));
}, 60_000);

afterAll(() => {
  if (workDir !== '') rmSync(workDir, { recursive: true, force: true });
});

describe('the dependency-cruiser rules fire on planted violations', () => {
  it('#1154: an engine adapter reaches neither core nor another adapter', () => {
    expect(violationsOf('engine-adapters-depend-only-on-the-port-and-contracts')).toStrictEqual([
      {
        rule: 'engine-adapters-depend-only-on-the-port-and-contracts',
        from: 'packages/engine-pi/src/index.ts',
        to: 'packages/core/src/index.ts',
      },
      {
        rule: 'engine-adapters-depend-only-on-the-port-and-contracts',
        from: 'packages/engine-pi/src/index.ts',
        to: 'packages/engine-mastra/src/index.ts',
      },
    ]);
  });

  it('#1154, F-08: the Claude adapter reaches run-protocol but neither core nor another adapter', () => {
    expect(
      edgesOf('claude-adapter-depends-only-on-the-port-contracts-and-run-protocol'),
    ).toStrictEqual([
      'packages/engine-claude-agent-sdk/src/index.ts -> packages/core/src/index.ts',
      'packages/engine-claude-agent-sdk/src/index.ts -> packages/engine-pi/src/index.ts',
    ]);
  });

  it('#1188: a wire module imports no database record, even type-only', () => {
    expect(violationsOf('web-contracts-do-not-import-persistence')).toStrictEqual([
      {
        rule: 'web-contracts-do-not-import-persistence',
        from: 'apps/web/server/projects/resource.ts',
        to: 'packages/core/src/db/index.ts',
      },
      {
        rule: 'web-contracts-do-not-import-persistence',
        from: 'apps/web/server/secrets/contract.ts',
        to: 'packages/core/src/db/index.ts',
      },
    ]);
  });

  it('F-15, F-08: core reaches only contracts', () => {
    expect(edgesOf('core-depends-only-on-contracts')).toStrictEqual([
      'packages/core/src/bad.ts -> packages/engine/src/index.ts',
      'packages/core/src/bad.ts -> packages/run-protocol/src/index.ts',
      'packages/core/src/bad.ts -> packages/sdk/src/index.ts',
    ]);
  });

  it('F-08: run-protocol reaches only contracts and the engine port', () => {
    expect(edgesOf('run-protocol-depends-only-on-contracts-and-engine')).toStrictEqual([
      'packages/run-protocol/src/index.ts -> packages/sdk/src/index.ts',
    ]);
  });

  it('F-15: runtime and egress-proxy depend on nothing in the workspace', () => {
    expect(edgesOf('runtime-depends-on-nothing-in-the-workspace')).toStrictEqual([
      'packages/runtime/src/index.ts -> packages/contracts/src/index.ts',
    ]);
    expect(edgesOf('egress-proxy-depends-on-nothing-in-the-workspace')).toStrictEqual([
      'packages/egress-proxy/src/index.ts -> packages/contracts/src/index.ts',
    ]);
  });

  it('F-15: gateway reaches only core and contracts', () => {
    expect(edgesOf('gateway-depends-only-on-core-and-contracts')).toStrictEqual([
      'packages/gateway/src/index.ts -> packages/runtime/src/index.ts',
    ]);
  });

  it('F-15: tool-host reaches only aw, contracts and egress-proxy', () => {
    expect(edgesOf('tool-host-depends-only-on-aw-contracts-and-egress-proxy')).toStrictEqual([
      'packages/tool-host/src/index.ts -> packages/runtime/src/index.ts',
    ]);
  });

  it('F-10: the app kit reaches only sdk, contracts and react', () => {
    expect(edgesOf('app-kit-depends-only-on-published-packages')).toStrictEqual([
      'packages/app/src/index.ts -> apps/web/server/agents/store.ts',
      'packages/app/src/index.ts -> packages/core/src/index.ts',
    ]);
  });

  it('F-10: neither an application nor another package imports the app kit', () => {
    expect(edgesOf('platform-never-imports-the-app-kit')).toStrictEqual([
      'apps/web/server/agents/app-kit.ts -> packages/app/src/index.ts',
      'packages/react/src/uses-app.ts -> packages/app/src/index.ts',
    ]);
    // react's own fence reports the same edge.
    expect(edgesOf('react-depends-only-on-sdk-and-contracts')).toStrictEqual([
      'packages/react/src/uses-app.ts -> packages/app/src/index.ts',
    ]);
  });

  it('F-15: cli and create are libraries that never import an application', () => {
    expect(edgesOf('libraries-do-not-import-applications')).toStrictEqual([
      'packages/app/src/index.ts -> apps/web/server/agents/store.ts',
      'packages/cli/src/index.ts -> apps/web/server/agents/store.ts',
      'packages/create/src/index.ts -> apps/web/server/agents/store.ts',
    ]);
  });

  it('F-15: a route does not import another route; tests may', () => {
    expect(edgesOf('routes-do-not-import-routes')).toStrictEqual([
      'apps/web/app/api/a/route.ts -> apps/web/app/api/b/route.ts',
    ]);
  });

  it('F-15: app/** does not import core; tests may', () => {
    expect(edgesOf('app-does-not-import-core')).toStrictEqual([
      'apps/web/app/api/a/route.ts -> packages/core/src/index.ts',
    ]);
  });

  it('F-15: a domain module other than store.ts does not import persistence', () => {
    expect(edgesOf('domain-does-not-import-persistence')).toStrictEqual([
      'apps/web/server/agents/service.ts -> packages/core/src/db/index.ts',
      // wire modules are also covered by the stricter rule above; the two overlap by design
      'apps/web/server/projects/resource.ts -> packages/core/src/db/index.ts',
      'apps/web/server/secrets/contract.ts -> packages/core/src/db/index.ts',
    ]);
  });

  it('design §07 rule 1: only the boundary file imports a cloud storage SDK', () => {
    expect(edgesOf('only-the-s3-boundary-imports-the-s3-sdk')).toStrictEqual([
      'packages/core/src/storage/other.ts -> node_modules/@aws-sdk/client-s3/index.js',
      'packages/core/src/storage/other.ts -> node_modules/@aws-sdk/s3-request-presigner/index.js',
    ]);
    expect(edgesOf('only-the-gcs-boundary-imports-the-gcs-sdk')).toStrictEqual([
      'packages/core/src/storage/other.ts -> node_modules/@google-cloud/storage/index.js',
    ]);
    expect(edgesOf('only-the-azure-boundary-imports-the-azure-sdk')).toStrictEqual([
      'packages/core/src/storage/other.ts -> node_modules/@azure/storage-blob/dist/commonjs/index.js',
    ]);
  });

  it('design §07 rule 2: app/** never imports a storage adapter', () => {
    expect(edgesOf('app-does-not-import-storage-adapters')).toStrictEqual([
      'apps/web/app/api/x/route.ts -> apps/web/server/composition/storage.ts',
      'apps/web/app/api/x/route.ts -> apps/web/server/files/store.ts',
    ]);
  });

  it('design §07 "Load test": only a test imports the storage backends subpath', () => {
    expect(edgesOf('storage-backends-are-for-tests')).toStrictEqual([
      'packages/core/src/storage/uses-backends.ts -> packages/core/src/storage/backends.ts',
    ]);
  });

  it('#1746: only the storage module and tests import a raw backend factory', () => {
    expect(edgesOf('raw-storage-backends-stay-in-core-storage')).toStrictEqual([
      'apps/web/server/files/raw-store.ts -> packages/core/src/storage/azure-blob-store.ts',
      'apps/web/server/files/raw-store.ts -> packages/core/src/storage/gcs-store.ts',
      'apps/web/server/files/raw-store.ts -> packages/core/src/storage/s3-store.ts',
    ]);
  });

  it('design §07 rule 3: only the catalog service reaches object storage', () => {
    expect(edgesOf('only-the-catalog-service-reaches-object-storage')).toStrictEqual([
      // the raw backend files are object storage too; the #1746 rule reports the same three edges
      'apps/web/server/files/raw-store.ts -> packages/core/src/storage/azure-blob-store.ts',
      'apps/web/server/files/raw-store.ts -> packages/core/src/storage/gcs-store.ts',
      'apps/web/server/files/raw-store.ts -> packages/core/src/storage/s3-store.ts',
      'apps/web/server/foo/upload.ts -> packages/core/src/storage/object-store.ts',
    ]);
  });

  it('AGENTS.md hexagonal rule 2: a domain core imports only its own core, contracts and zod', () => {
    expect(edgesOf('domain-core-is-pure')).toStrictEqual([
      'apps/web/server/pilot/core/decide.ts -> apps/web/server/other/core/rules.ts',
      'apps/web/server/pilot/core/decide.ts -> apps/web/server/pilot/ports.ts',
      'apps/web/server/pilot/core/decide.ts -> apps/web/server/pilot/store.ts',
      'apps/web/server/pilot/core/decide.ts -> fs',
      'apps/web/server/pilot/core/decide.ts -> node_modules/left-pad/index.js',
    ]);
  });

  it('refactoring part 04: a context imports only the shared kernel and the contexts before it', () => {
    expect(edgesOf('context-execution-imports-only-upstream')).toStrictEqual([
      'apps/web/server/runs/ctx.ts -> apps/web/server/agents/index.ts',
    ]);
    expect(edgesOf('context-agents-imports-only-upstream')).toStrictEqual([
      'apps/web/server/agents/ctx.ts -> apps/web/server/evaluations/index.ts',
    ]);
    expect(edgesOf('shared-kernel-imports-no-context')).toStrictEqual([
      'apps/web/server/http/ctx.ts -> apps/web/server/auth/ctx-target.ts',
    ]);
    expect(edgesOf('no-context-imports-the-composition-root')).toStrictEqual([
      'apps/web/server/agents/ctx.ts -> apps/web/server/composition/ctx-target.ts',
    ]);
  });

  it('refactoring part 04, step 7: another context enters identity only through its entry', () => {
    expect(edgesOf('context-identity-entered-through-its-entry')).toStrictEqual([
      'apps/web/server/runs/ctx.ts -> apps/web/server/auth/ctx-target.ts',
    ]);
  });

  it('reports nothing else: the allowed edges stay allowed and every import resolves', () => {
    // 5 earlier + 7 F-15 + the cli and create fence rules firing on the same planted imports
    // + 3 baseline-rule cases + the 2 wire modules the domain rule also reports + 1 F-08 (run-protocol)
    // + 3 F-08 (the Claude adapter's core import; core's engine and run-protocol imports)
    // + 4 design §07 rule 1 (one per cloud, two S3 libraries) + 2 design §07 rule 2
    // + 1 storage backends subpath + 3 raw backend factories (#1746) + 4 design §07 rule 3
    // + 2 app kit fence (#1500) + its application import, which the library rule also reports
    // + 2 imports of the app kit + react's fence on one of them + 5 domain core imports
    // + 4 context direction (part 04) + 1 deep import into identity (part 04, step 7)
    expect(violations).toHaveLength(
      2 + 1 + 2 + 7 + 2 + 3 + 2 + 1 + 3 + 4 + 2 + 1 + 3 + 4 + 2 + 1 + 2 + 1 + 5 + 4 + 1,
    );
  });
});

/**
 * F-15 baselines. `.dependency-cruiser-known-violations.json` lists the violations of the baseline
 * rules that existed when the rules were added; `architecture:check` ignores exactly
 * those. It may only shrink: a new violation fails the check, and a fixed one must be removed from
 * the file (`pnpm exec depcruise --config dependency-cruiser.config.mjs --output-type baseline
 * apps packages > .dependency-cruiser-known-violations.json`), after which the ceiling below drops.
 */
const baselineCeiling: Readonly<Record<string, number>> = {
  'routes-do-not-import-routes': 0,
  'app-does-not-import-core': 0,
  // Part 09 step 6: runs/environment.ts names its own evaluation record, not the stored row.
  'domain-does-not-import-persistence': 31,
  // Refactoring plan part 04, step 2: the imports against the context direction when it landed.
  'shared-kernel-imports-no-context': 5,
  'no-context-imports-the-composition-root': 0,
  'context-identity-imports-only-upstream': 5,
  'context-storage-and-sharing-imports-only-upstream': 14,
  // Part 09 step 2: the launcher's target types moved into execution (runs/launch-target.ts).
  // Part 09 step 3: run-delivery-fixtures became *.test-support.ts (5 here, 5 from three entry rules).
  'context-execution-imports-only-upstream': 11,
  'context-integrations-imports-only-upstream': 0,
  'context-agents-imports-only-upstream': 1,
  // Part 04, step 7: deep imports into identity left when its entry landed (rbac/http and
  // auth/index load start-up work, oauth/resource would close a cycle; see identity/index.ts).
  'context-identity-entered-through-its-entry': 14,
  // Evaluations: the Builder's runner adapter still imports handlers.ts, which loads the
  // application context (see evaluations/index.ts).
  'context-evaluations-entered-through-its-entry': 1,
  // Secrets: no deep import was left when its entry landed.
  'context-secrets-entered-through-its-entry': 0,
  // Agents: upstream callers' value imports of modules with start-up work, most also against the
  // direction (see agents/index.ts). The direction ceilings above dropped by 6 when several deep
  // imports from one file became one import of the entry.
  'context-agents-entered-through-its-entry': 14,
  // Execution: other contexts still call runs/environment (application context), runs/api and
  // runs/service (start-up work), runs/failures and runs/transcription (would close a cycle) and
  // runtimes/connections (database driver); see execution/index.ts. Storage and sharing's direction
  // ceiling dropped by 1 when two deep imports from one file became one import of the entry.
  'context-execution-entered-through-its-entry': 22,
  // Integrations: other contexts still call tool-endpoint/handler.ts (object-store SDKs, database
  // driver, agents context), tool-endpoint/close.ts (application context) and a run fixture's
  // in-memory models store (secret-manager SDKs); identity's oauth/resource.ts and execution's
  // runs/transcription.ts import against the direction and stay deep; see integrations/index.ts.
  'context-integrations-entered-through-its-entry': 8,
  // Storage and sharing: other contexts still call storage/objects.ts (object-store SDKs),
  // storage/store.ts (database driver), storage/service.ts and storage/testing.ts (fixtures; SDKs and
  // driver) and files/handlers, files/http and files/search-http (about 330 modules each, including
  // the agents context); see storage-and-sharing/index.ts.
  'context-storage-and-sharing-entered-through-its-entry': 20,
  // The storage design, §07 rule 3: landed with no known violation, and none may be added.
  'only-the-catalog-service-reaches-object-storage': 0,
};

describe('the known-violations baseline only shrinks', () => {
  const baselineSchema = z.array(
    z.object({ rule: z.object({ name: z.string() }), from: z.string(), to: z.string() }),
  );
  const key = (v: { rule: string; from: string; to: string }): string =>
    `${v.rule}: ${v.from} -> ${v.to}`;
  let actual: readonly string[] = [];
  let known: readonly { rule: string; from: string; to: string }[] = [];

  beforeAll(() => {
    known = baselineSchema
      .parse(
        JSON.parse(
          readFileSync(path.join(repoRoot, '.dependency-cruiser-known-violations.json'), 'utf8'),
        ),
      )
      .map(({ rule, from, to }) => ({ rule: rule.name, from, to }));
    const result = spawnSync(
      process.execPath,
      [cruiseBin, '--config', cruiseConfig, '--output-type', 'json', 'apps', 'packages'],
      { cwd: repoRoot, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
    );
    if (result.error !== undefined || result.stdout.trim() === '') {
      throw new Error(`dependency-cruiser produced no report: ${result.error?.message}`);
    }
    actual = reportSchema
      .parse(JSON.parse(result.stdout))
      .summary.violations.filter(({ rule }) => rule.name in baselineCeiling)
      .map(({ rule, from, to }) => key({ rule: rule.name, from, to }));
  }, 240_000);

  it('holds only the baseline rules, within their committed ceilings', () => {
    const counts: Record<string, number> = {};
    for (const { rule } of known) counts[rule] = (counts[rule] ?? 0) + 1;
    for (const rule of Object.keys(counts)) expect(baselineCeiling).toHaveProperty(rule);
    for (const [rule, ceiling] of Object.entries(baselineCeiling)) {
      expect(counts[rule] ?? 0).toBeLessThanOrEqual(ceiling);
    }
  });

  it('has no stale entries: every known violation still exists', () => {
    expect(known.map(key).filter((entry) => !actual.includes(entry))).toStrictEqual([]);
  });

  it('lists every violation of the baseline rules: no new ones', () => {
    const listed = known.map(key);
    expect(actual.filter((entry) => !listed.includes(entry))).toStrictEqual([]);
  });
});
