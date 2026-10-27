/** @type {import('dependency-cruiser').IConfiguration} */
export default {
  forbidden: [
    {
      name: 'no-circular-dependencies',
      severity: 'error',
      comment: 'Cycles obscure ownership and make module initialization order significant.',
      from: {
        path: '^(apps|packages)/',
        pathNot:
          '^packages/core/src/db/schema/(?:model-connections|workspaces|agents|agent-versions)\\.ts$',
      },
      to: { circular: true, viaOnly: { dependencyTypesNot: ['type-only'] } },
    },
    {
      name: 'schema-cycle-is-limited-to-agent-materialised-version',
      severity: 'error',
      comment:
        'agents.materialised_version_id and agent_versions.agent_id reference each other (issue #613); that cycle may contain only these two schema modules.',
      from: {
        path: '^packages/core/src/db/schema/(?:agents|agent-versions)\\.ts$',
      },
      to: {
        circular: true,
        pathNot: '^packages/core/src/db/schema/(?:agents|agent-versions)\\.ts$',
      },
    },
    {
      name: 'schema-cycle-is-limited-to-workspace-model-defaults',
      severity: 'error',
      comment:
        'The documented composite foreign-key cycle may contain only workspaces and model-connections.',
      from: {
        path: '^packages/core/src/db/schema/(?:model-connections|workspaces)\\.ts$',
      },
      to: {
        circular: true,
        pathNot: '^packages/core/src/db/schema/(?:model-connections|workspaces)\\.ts$',
      },
    },
    {
      name: 'no-unresolved-imports',
      severity: 'error',
      from: { path: '^(apps|packages)/' },
      to: { couldNotResolve: true },
    },
    {
      name: 'browser-ui-does-not-import-server-values',
      severity: 'error',
      comment: 'Browser code depends on HTTP contracts, never server implementation modules.',
      from: {
        path: '^apps/web/components/',
        pathNot: '\\.(?:test|spec)\\.[cm]?[jt]sx?$',
      },
      to: { path: '^apps/web/server/' },
    },
    {
      name: 'browser-ui-does-not-import-persistence',
      severity: 'error',
      from: { path: '^apps/web/components/' },
      to: { path: '^packages/core/src/db/' },
    },
    {
      name: 'web-contracts-do-not-import-persistence',
      severity: 'error',
      comment:
        'Refactoring plan, architecture enforcement end state: a domain wire contract never names a database record; mappers take structural inputs. Covers every `<domain>/contract.ts` and `projects/resource.ts`, the other record → wire-resource mapper that is clean today. `runtimes/connections.ts` is not listed because it still imports `core/db`: its port and store live in the same file as its mapper.',
      from: { path: '^apps/web/server/(?:[^/]+/contract|projects/resource)\\.ts$' },
      to: { path: '^packages/core/src/db/' },
    },
    {
      name: 'libraries-do-not-import-applications',
      severity: 'error',
      from: {
        path: '^packages/(core|runtime|gateway|contracts|sdk|react|aw|platforms|skills-office|engine|engine-[^/]+|cli|create|tool-host|egress-proxy)/',
      },
      to: { path: '^apps/' },
    },
    {
      name: 'skills-office-depends-only-on-contracts',
      severity: 'error',
      comment:
        'The built-in skill package ships files and names them; it reaches the wire contracts and nothing else in the workspace.',
      from: { path: '^packages/skills-office/' },
      to: { path: '^(apps|packages)/', pathNot: '^packages/(skills-office|contracts)/' },
    },
    {
      name: 'core-depends-only-on-contracts',
      severity: 'error',
      comment:
        'F-15, F-08: core is persistence, object storage and secrets; of the workspace it reaches only the wire contracts. The run protocol (RunRequest, the agent schemas, the agent.* mapping) and the engine port are not its business: callers import `@agent-workspace/run-protocol` directly (W2-9).',
      from: { path: '^packages/core/' },
      to: { path: '^(apps|packages)/', pathNot: '^packages/(core|contracts)/' },
    },
    {
      name: 'runtime-depends-on-nothing-in-the-workspace',
      severity: 'error',
      comment:
        'F-15: the runtime package is the in-sandbox execution layer; it must not drag the control plane, persistence or the wire contracts into a run image.',
      from: { path: '^packages/runtime/' },
      to: { path: '^(apps|packages)/', pathNot: '^packages/runtime/' },
    },
    {
      name: 'gateway-depends-only-on-core-and-contracts',
      severity: 'error',
      comment:
        'F-15: the model gateway reaches persistence through core and the wire contracts, never the runtime, an application or an SDK.',
      from: { path: '^packages/gateway/' },
      to: { path: '^(apps|packages)/', pathNot: '^packages/(gateway|core|contracts)/' },
    },
    {
      name: 'egress-proxy-depends-on-nothing-in-the-workspace',
      severity: 'error',
      comment:
        'F-15: the egress proxy is a standalone security fence in front of sandbox traffic; any workspace import widens what it must trust.',
      from: { path: '^packages/egress-proxy/' },
      to: { path: '^(apps|packages)/', pathNot: '^packages/egress-proxy/' },
    },
    {
      name: 'tool-host-depends-only-on-aw-contracts-and-egress-proxy',
      severity: 'error',
      comment:
        'F-15: the tool host runs inside the sandbox; it reaches the control plane through `aw`, the wire contracts and the egress proxy, never core, runtime or an application.',
      from: { path: '^packages/tool-host/' },
      to: {
        path: '^(apps|packages)/',
        pathNot: '^packages/(tool-host|aw|contracts|egress-proxy)/',
      },
    },
    {
      name: 'platforms-depend-only-on-contracts',
      severity: 'error',
      comment:
        'ADR-0133 D6: translators are pure data transforms shipped to browsers, aw and the control plane alike; they reach the wire contracts and nothing else in the workspace.',
      from: { path: '^packages/platforms/' },
      to: { path: '^(apps|packages)/', pathNot: '^packages/(platforms|contracts)/' },
    },
    {
      name: 'platforms-are-pure',
      severity: 'error',
      comment:
        'ADR-0133 D6: no file system, network or process access outside the conformance kit.',
      from: {
        path: '^packages/platforms/src/',
        pathNot: '^packages/platforms/src/testing/|\\.(?:test|spec)\\.[cm]?[jt]sx?$',
      },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'engine-testing-subpaths-are-for-tests',
      severity: 'error',
      comment:
        'W3-8: an engine package root exports its port (packages/engine) or its one factory (an adapter); `@agent-workspace/engine(-<id>)?/testing` carries the conformance kit and the adapter internals, and only tests may reach it.',
      from: {
        path: '^(apps|packages)/',
        pathNot: '^packages/engine[a-z-]*/src/testing[./]|\\.(?:test|spec)\\.[cm]?[jt]sx?$',
      },
      to: { path: '^packages/engine[a-z-]*/src/testing(?:\\.ts$|/)' },
    },
    {
      name: 'engine-port-depends-only-on-contracts',
      severity: 'error',
      comment:
        'ENG-04: the engine port is where a runner and an adapter meet, so anything it imported would become something every adapter has to carry — which is how a port turns back into a framework. `packages/contracts`, and nothing else — not even zod: the port is types and pure functions, and the trust-boundary parse belongs to the adapter that owns the policy arm.',
      from: { path: '^packages/engine/' },
      to: { path: '^(apps|packages)/', pathNot: '^packages/(engine|contracts)/' },
    },
    {
      name: 'run-protocol-depends-only-on-contracts-and-engine',
      severity: 'error',
      comment:
        'F-08: `run-protocol` is the private contract between the control plane, the runner and the engine adapters (`RunRequest`, the agent schemas, the Claude `agent.*` mapping). It sees the wire contracts and the engine port, whose frame builder the mapping shares with every adapter, and nothing else: importing core would give its callers the database and cloud SDKs back.',
      from: { path: '^packages/run-protocol/' },
      to: { path: '^(apps|packages)/', pathNot: '^packages/(run-protocol|contracts|engine)/' },
    },
    {
      name: 'engine-adapters-depend-only-on-the-port-and-contracts',
      severity: 'error',
      comment:
        'ENG-04: an adapter sees the port, the wire contracts, and its own third-party SDK. An adapter must never reach another adapter or `packages/core`.',
      // The capture group and its `$1` back-reference are what let this rule say "and never
      // another adapter" without naming the adapters: a module under `packages/engine-<x>/` may
      // reach `packages/engine-<x>/` and the two shared packages, and nothing else under
      // `packages/engine-*`. The Claude adapter has its own rule below.
      from: {
        path: '^packages/(engine-[^/]+)/',
        pathNot: '^packages/engine-claude-agent-sdk/',
      },
      to: {
        path: '^(apps|packages)/',
        pathNot: '^packages/(engine|contracts)/|^packages/$1/',
      },
    },
    {
      name: 'claude-adapter-depends-only-on-the-port-contracts-and-run-protocol',
      severity: 'error',
      comment:
        'ENG-04, F-08: an adapter sees the port, the wire contracts, and its own third-party SDK. This adapter may also see `packages/run-protocol`, because the private `/run` contract (`RunRequest`) and the Claude `agent.*` mapping live there: the control plane runs the same mapping over pre-ENG-03 rows and may not import an adapter (ADR-0070 Deviation 2, closed by W2-9). Never `packages/core`, never another adapter.',
      from: { path: '^packages/engine-claude-agent-sdk/' },
      to: {
        path: '^(apps|packages)/',
        pathNot: '^packages/(engine|contracts|run-protocol|engine-claude-agent-sdk)/',
      },
    },
    {
      name: 'web-does-not-import-an-engine-adapter',
      severity: 'error',
      comment:
        'ENG-04: which adapters a runtime image carries is the runner’s business. The control plane knows engines only through `@indx-workspace/contracts/engines` and its own registry, so adding an engine never touches `apps/web`. Test files are excluded, as they are from the browser-boundary rule above: two compose assertions are about what a composed request compiles to on the engine it named, and there is no way to assert that without the engine.',
      from: { path: '^apps/web/', pathNot: '\\.(?:test|spec)\\.[cm]?[jt]sx?$' },
      to: { path: '^packages/engine-[^/]+/' },
    },
    {
      name: 'runner-reaches-engine-adapters-only-through-engines-ts',
      severity: 'error',
      comment:
        'ENG-04: `apps/runner/src/engines.ts` holds the static id → adapter table and is the only file in the runner that names an adapter. Everything else talks to the port, which is what makes adding an engine a new package and a new row rather than an edit to a run path.',
      from: {
        path: '^apps/runner/',
        pathNot: '^apps/runner/src/engines\\.ts$|\\.(?:test|spec)\\.[cm]?[jt]sx?$',
      },
      to: { path: '^packages/engine-[^/]+/' },
    },
    {
      name: 'contracts-depend-on-nothing-in-the-workspace',
      severity: 'error',
      comment:
        'The wire contracts are consumed by browsers, external services and the control plane alike; a dependency on any workspace package would drag persistence or a runtime into every consumer.',
      from: { path: '^packages/contracts/' },
      to: { path: '^(apps|packages)/', pathNot: '^packages/contracts/' },
    },
    {
      name: 'sdk-depends-only-on-contracts',
      severity: 'error',
      comment:
        'The SDK is the HTTP client of the published contracts and nothing else; core, runtime and gateway are server-side implementations it must not reach.',
      from: { path: '^packages/sdk/' },
      to: { path: '^(apps|packages)/', pathNot: '^packages/(sdk|contracts)/' },
    },
    {
      name: 'react-depends-only-on-sdk-and-contracts',
      severity: 'error',
      comment:
        'Issue #623: `@indx-workspace/react` is the hosted surface chat, published for customer pages, so it reaches the API through the published SDK and the contracts only — never an application module or a server-side package.',
      from: { path: '^packages/react/' },
      to: { path: '^(apps|packages)/', pathNot: '^packages/(react|sdk|contracts)/' },
    },
    {
      name: 'aw-depends-only-on-sdk-and-contracts',
      severity: 'error',
      comment:
        'The `aw` CLI is a client of the control plane like any customer program: it reaches the API through the SDK and the contracts only, never through a server-side package. It may also import the pure platform translators (`packages/platforms`, ADR-0133).',
      from: { path: '^packages/aw/' },
      to: {
        path: '^(apps|packages)/',
        pathNot:
          '^packages/(aw|sdk|contracts|platforms)/|^packages/cli/src/deploy/project\\.ts$|^packages/cli/src/publish/index\\.ts$',
      },
    },
    {
      name: 'aw-reaches-cli-only-through-the-cli-bridge',
      severity: 'error',
      comment:
        'ADR-0103 (amendment for #621) and ADR-0133 D11: `aw deploy` and `aw platforms publish` run `@indx-workspace/cli/deploy` and `@indx-workspace/cli/publish` in-process, loaded by dynamic `import()` because the CLI is an optional peer. `packages/aw/src/cli-bridge.ts` is the one aw file that may reach the CLI; the two command suites only `vi.mock` it and import its types. The CLI itself reaches only the SDK and the contracts.',
      from: {
        path: '^packages/aw/',
        pathNot:
          '^packages/aw/src/(cli-bridge|commands/deploy\\.test|commands/platforms\\.test)\\.ts$',
      },
      to: { path: '^packages/cli/', dependencyTypesNot: ['type-only', 'type-import'] },
    },
    {
      name: 'cli-depends-only-on-sdk-and-contracts',
      severity: 'error',
      comment:
        'ADR-0082 (amendment for #364): `@indx-workspace/cli` is published, and every private member keeps a scope a third party owns on npm, so the project CLI may reach only the published SDK and contracts. The local runtime, which bundles the server, is `@indx-workspace/embedded` (`packages/embedded`, ADR-0109).',
      from: { path: '^packages/cli/' },
      to: { path: '^(apps|packages)/', pathNot: '^packages/(cli|sdk|contracts)/' },
    },
    {
      name: 'nothing-imports-embedded',
      severity: 'error',
      comment:
        'ADR-0109: `@indx-workspace/embedded` is the local runtime, a bundle of the server with no importable API. `aw dev` resolves its `./launch` export by path and forks it; nothing in the workspace imports it, which also keeps the server out of every package that would.',
      from: { path: '^(apps|packages)/', pathNot: '^packages/embedded/' },
      to: { path: '^packages/embedded/' },
    },
    {
      name: 'create-depends-only-on-cli',
      severity: 'error',
      comment:
        '`@indx-workspace/create` is the `npm create @indx-workspace` name for the CLI generator and nothing else.',
      from: { path: '^packages/create/' },
      to: { path: '^(apps|packages)/', pathNot: '^packages/(create|cli)/' },
    },
    {
      name: 'routes-do-not-import-routes',
      severity: 'error',
      comment:
        'F-15: a route handler is a delivery adapter; sharing logic between two routes belongs in a server domain, not in one route importing the other. Known violations live in .dependency-cruiser-known-violations.json and can only shrink.',
      from: {
        path: '^apps/web/app/.*/route\.ts$',
        pathNot: '\.(?:test|spec)\.[cm]?[jt]sx?$',
      },
      to: { path: '^apps/web/app/.*/route\.ts$' },
    },
    {
      name: 'app-does-not-import-core',
      severity: 'error',
      comment:
        'F-15: Next.js `app/**` reaches persistence and infrastructure through server domains and composition, never `@agent-workspace/core` directly. Known violations live in .dependency-cruiser-known-violations.json and can only shrink.',
      from: { path: '^apps/web/app/', pathNot: '\.(?:test|spec)\.[cm]?[jt]sx?$' },
      to: { path: '^packages/core/' },
    },
    {
      name: 'only-the-s3-boundary-imports-the-s3-sdk',
      severity: 'error',
      comment:
        'The storage design, §07 rule 1: only one file per cloud imports that cloud library, so each loads only when its cloud is used. The S3 boundary is `packages/core/src/storage/s3-store.ts`. `packages/cli/src/validate.ts` is the one named exception (owner decision Q-9): the published CLI probes a bucket and may not import `packages/core` (ADR-0082). Test, live and acceptance files may import the SDK. `@aws-sdk/client-kms` is a key-management library, not storage, and is left out on purpose.',
      from: {
        path: '^(apps|packages)/',
        pathNot:
          '^packages/core/src/storage/s3-store\\.ts$|^packages/cli/src/validate\\.ts$|\\.(?:test|spec|acceptance)\\.[cm]?[jt]sx?$|\\.live\\.',
      },
      to: { path: '(^|/)@aws-sdk/(client-s3|lib-storage|s3-request-presigner)(/|$)' },
    },
    {
      name: 'only-the-gcs-boundary-imports-the-gcs-sdk',
      severity: 'error',
      comment:
        'The storage design, §07 rule 1: only `packages/core/src/storage/gcs-store.ts` imports `@google-cloud/storage`. `packages/cli/src/validate.ts` is the one named exception (Q-9, ADR-0082: the published CLI probes a bucket and may not import `packages/core`). Test, live and acceptance files may import the SDK.',
      from: {
        path: '^(apps|packages)/',
        pathNot:
          '^packages/core/src/storage/gcs-store\\.ts$|^packages/cli/src/validate\\.ts$|\\.(?:test|spec|acceptance)\\.[cm]?[jt]sx?$|\\.live\\.',
      },
      to: { path: '(^|/)@google-cloud/storage(/|$)' },
    },
    {
      name: 'only-the-azure-boundary-imports-the-azure-sdk',
      severity: 'error',
      comment:
        'The storage design, §07 rule 1: only `packages/core/src/storage/azure-blob-store.ts` imports `@azure/storage-blob`. `@azure/identity` is a credential library also used by the Key Vault provider and the runtime, so it is left out on purpose. Test, live and acceptance files may import the SDK.',
      from: {
        path: '^(apps|packages)/',
        pathNot:
          '^packages/core/src/storage/azure-blob-store\\.ts$|\\.(?:test|spec|acceptance)\\.[cm]?[jt]sx?$|\\.live\\.',
      },
      to: { path: '(^|/)@azure/storage-blob(/|$)' },
    },
    {
      name: 'app-does-not-import-storage-adapters',
      severity: 'error',
      comment:
        'The storage design, §07 rule 2: pages and API routes never touch storage directly; they call a server domain service. `app/**` may not value-import a domain `store.ts` or `composition/storage.ts`; a type-only import is allowed.',
      from: { path: '^apps/web/app/', pathNot: '\\.(?:test|spec)\\.[cm]?[jt]sx?$' },
      to: {
        path: '^apps/web/server/(?:[^/]+/store|composition/storage)\\.ts$',
        dependencyTypesNot: ['type-only', 'type-import'],
      },
    },
    {
      name: 'domain-does-not-import-persistence',
      severity: 'error',
      comment:
        'F-15: a web server domain names no `packages/core/src/db` record or repository; only its `store.ts` adapter (and the test-only `catalog-store.memory.ts`) may. Known violations live in .dependency-cruiser-known-violations.json and can only shrink.',
      from: {
        path: '^apps/web/server/[^/]+/',
        pathNot: '/store\.ts$|/catalog-store\.memory\.ts$|\.(?:test|spec)\.[cm]?[jt]sx?$',
      },
      to: { path: '^packages/core/src/db/' },
    },
    {
      name: 'memory-catalog-store-is-for-tests',
      severity: 'error',
      comment:
        'The storage design, §07 rule 4: the in-memory catalog store backs tests only; production wires `createResourceCatalogStoreProvider`.',
      from: { path: '^(apps|packages)/', pathNot: '\\.(?:test|spec)\\.[cm]?[jt]sx?$' },
      to: { path: '^apps/web/server/resources/catalog-store\\.memory\\.ts$' },
    },
    {
      name: 'builder-core-is-pure',
      severity: 'error',
      comment:
        'Builder design §04 "The core and its ports" (ADR-0108 B-D5, #1844): `builder/core/` is a pure decision core. It may import only files inside `core/`, the wire contracts (`packages/contracts/src/`) and zod; every Node built-in, other server module, workspace package and npm package is refused.',
      from: {
        path: '^apps/web/server/builder/core/',
        pathNot: '\\.(?:test|spec)\\.[cm]?[jt]sx?$',
      },
      to: {
        pathNot: '^apps/web/server/builder/core/|^packages/contracts/src/|(?:^|/)node_modules/zod/',
      },
    },
    {
      name: 'builder-memory-adapters-are-for-tests',
      severity: 'error',
      comment:
        'Builder design §04 (#1844): the in-memory Builder adapters back tests only; production wires the real ports.',
      from: {
        pathNot:
          '\\.(?:test|spec)\\.[cm]?[jt]sx?$|^apps/web/server/builder/testing/|^apps/web/server/builder/adapters/.+/memory(?:\\.tsx?|/)',
      },
      to: { path: '^apps/web/server/builder/adapters/.+/memory(?:\\.tsx?|/)' },
    },
    {
      name: 'storage-backends-are-for-tests',
      severity: 'error',
      comment:
        'The storage design, §07 "Load test": `@agent-workspace/core/storage/backends` loads the Azure and Google Cloud libraries and backs tests only; production opens a store with `openObjectStore`.',
      from: { path: '^(apps|packages)/', pathNot: '\\.(?:test|spec)\\.[cm]?[jt]sx?$' },
      to: { path: '^packages/core/src/storage/backends\\.ts$' },
    },
    {
      name: 'production-does-not-import-tests',
      severity: 'error',
      from: { path: '^(apps|packages)/', pathNot: '\\.(?:test|spec)\\.[cm]?[jt]sx?$' },
      to: { path: '\\.(?:test|spec)\\.[cm]?[jt]sx?$' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    // Build output of a workspace package only. node_modules is kept out of the scan by `doNotFollow`;
    // an exclude that matched it (or a dependency's own `dist/`, as @azure/storage-blob has) would
    // drop the resolved npm edge itself, so a rule on an npm package could never fire.
    exclude: '^(?:apps|packages)/(?!.*node_modules/).*/(?:dist|coverage|\\.next(?:-embedded)?)/',
    tsConfig: { fileName: 'tsconfig.architecture.json' },
    // Type-only imports are real dependency edges; without this every rule is blind to them.
    tsPreCompilationDeps: 'specify',
    // Resolve a third-party subpath through its package's `exports` map, as Node does. ENG-09
    // (#308): `@openai/agents-extensions/ai-sdk` exists only as an `exports` entry (its files live
    // under `dist/ai-sdk/`), so without this the resolver reported a real import unresolvable.
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
    },
  },
};
