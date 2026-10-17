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
      to: { circular: true },
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
      name: 'libraries-do-not-import-applications',
      severity: 'error',
      from: {
        path: '^packages/(core|runtime|gateway|contracts|sdk|react|aw|platforms|engine|engine-[^/]+)/',
      },
      to: { path: '^apps/' },
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
      name: 'engine-port-depends-only-on-contracts',
      severity: 'error',
      comment:
        'ENG-04: the engine port is where a runner and an adapter meet, so anything it imported would become something every adapter has to carry — which is how a port turns back into a framework. `packages/contracts`, and nothing else — not even zod: the port is types and pure functions, and the trust-boundary parse belongs to the adapter that owns the policy arm.',
      from: { path: '^packages/engine/' },
      to: { path: '^(apps|packages)/', pathNot: '^packages/(engine|contracts)/' },
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
      name: 'claude-adapter-depends-only-on-the-port-contracts-and-core',
      severity: 'error',
      comment:
        "ENG-04: an adapter sees the port, the wire contracts, and its own third-party SDK. `packages/core` is on this list for one transitional reason, stated rather than implied: the private `/run` contract (`RunRequest`) and the ENG-03 `agent.*` mapping still live there, because the control plane runs the same mapping over pre-ENG-03 rows and may not import an adapter. The private contract's v2 (#303's follow-up) moves both and this entry goes with them. Only this adapter: the reason is Claude's `RunRequest` and mapping.",
      from: { path: '^packages/engine-claude-agent-sdk/' },
      to: {
        path: '^(apps|packages)/',
        pathNot: '^packages/(engine|contracts|core|engine-claude-agent-sdk)/',
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
      to: { path: '^packages/cli/' },
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
      name: 'production-does-not-import-tests',
      severity: 'error',
      from: { path: '^(apps|packages)/', pathNot: '\\.(?:test|spec)\\.[cm]?[jt]sx?$' },
      to: { path: '\\.(?:test|spec)\\.[cm]?[jt]sx?$' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: '(^|/)(?:dist|coverage|\\.next(?:-embedded)?|node_modules)/',
    tsConfig: { fileName: 'tsconfig.architecture.json' },
    // Resolve a third-party subpath through its package's `exports` map, as Node does. ENG-09
    // (#308): `@openai/agents-extensions/ai-sdk` exists only as an `exports` entry (its files live
    // under `dist/ai-sdk/`), so without this the resolver reported a real import unresolvable.
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
    },
  },
};
