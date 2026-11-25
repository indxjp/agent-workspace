/**
 * The planted source tree `architecture-rules.test.ts` writes to a temp directory and runs the
 * real dependency-cruiser config against. Each entry plants allowed edges and the forbidden ones the
 * test lists. Kept apart from the test so the expectations read without the fixture between them.
 */
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

export const fixture: Readonly<Record<string, string>> = {
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
  // use-cases/: a use case's own file reaches the platform through its packages, never an app, the
  // kit or a test; its test may use the kit and import its own files.
  'use-cases/kit/index.ts': 'export const kit = 1;\n',
  // The kit is test machinery: it may import itself, tests/ and test-support files.
  'use-cases/kit/scripted.ts': [
    "export * from './index';",
    "export * from './kit.test-support';",
    "export * from '../../tests/use-case-helper';",
    '',
  ].join('\n'),
  'use-cases/kit/kit.test-support.ts': 'export const kitSupport = 1;\n',
  'tests/use-case-helper.ts': 'export const helper = 1;\n',
  // A template is copied into every entry, so it may not import the kit either.
  'use-cases/templates/qa/agents/qa.ts': "export * from '../../../kit/index';\n",
  // One use case never imports another; the shared code belongs in the platform.
  'use-cases/faq/agents/faq.ts': 'export const faq = 1;\n',
  'use-cases/sample-entry/agents/sample-entry.ts': [
    "export * from '../../../apps/web/server/agents/ctx-target';",
    "export * from '../../kit/index';",
    "export * from '../../faq/agents/faq';",
    "export * from '../sample-entry.test-support';",
    "export * from '../../../packages/contracts/src/index';",
    '',
  ].join('\n'),
  'use-cases/sample-entry/sample-entry.test-support.ts': 'export const support = 1;\n',
  'use-cases/sample-entry/sample-entry.test.ts': [
    "export * from '../kit/index';",
    "export * from './agents/sample-entry';",
    "export * from './sample-entry.test-support';",
    '',
  ].join('\n'),
};
