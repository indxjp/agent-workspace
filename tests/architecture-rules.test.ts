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

import {
  compareWithBaseline,
  KNOWN_VIOLATIONS,
  REGENERATE_BASELINE,
} from '../scripts/policy-check-architecture.mjs';
import { fixture } from './architecture-rules-fixture.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cruiseBin = path.join(repoRoot, 'node_modules/dependency-cruiser/bin/dependency-cruiser.mjs');
const cruiseConfig = path.join(repoRoot, 'dependency-cruiser.config.mjs');

const reportSchema = z.object({
  summary: z.object({
    violations: z.array(
      z.object({ rule: z.object({ name: z.string() }), from: z.string(), to: z.string() }),
    ),
  }),
});

/** Runs the real dependency-cruiser config over `apps` and `packages` under `cwd`. */
function cruise(cwd: string): z.infer<typeof reportSchema> {
  const result = spawnSync(
    process.execPath,
    [cruiseBin, '--config', cruiseConfig, '--output-type', 'json', 'apps', 'packages'],
    { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  );
  if (result.error !== undefined || result.stdout.trim() === '') {
    throw new Error(
      `dependency-cruiser produced no report: ${result.error?.message ?? result.stderr}`,
    );
  }
  return reportSchema.parse(JSON.parse(result.stdout));
}

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
  // dependency-cruiser exits with the violation count, so a non-zero status is expected here.
  const report = cruise(workDir);
  violations = report.summary.violations
    .map(({ rule, from, to }) => ({ rule: rule.name, from, to }))
    .sort((a, b) => `${a.rule} ${a.from} ${a.to}`.localeCompare(`${b.rule} ${b.from} ${b.to}`));
}, 60_000);

afterAll(() => {
  if (workDir !== '') rmSync(workDir, { recursive: true, force: true });
});

describe('dependency-cruiser fires on planted violations: engine adapters, wire modules and core', () => {
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
});

describe('dependency-cruiser fires on planted violations: package fences and the app kit', () => {
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
});

describe('dependency-cruiser fires on planted violations: libraries, routes and domains', () => {
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
});

describe('dependency-cruiser fires on planted violations: storage boundaries', () => {
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
});

describe('dependency-cruiser fires on planted violations: domain cores and contexts', () => {
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
});

describe('dependency-cruiser reports nothing else on the planted tree', () => {
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
 * those. It may only shrink: a new violation fails the check, and so does an entry the tree no
 * longer has, which must be removed from the file (`REGENERATE_BASELINE`), after which the ceiling
 * below drops. Both are decided by `pnpm architecture:check` on the real tree
 * (scripts/policy-check-architecture.mjs), in one dependency-cruiser run; that the file stays
 * within these ceilings depends on the file alone, and is checked here.
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

  it('holds only the baseline rules, within their committed ceilings', () => {
    const known = baselineSchema.parse(
      JSON.parse(readFileSync(path.join(repoRoot, KNOWN_VIOLATIONS), 'utf8')),
    );
    const counts: Record<string, number> = {};
    for (const { rule } of known) counts[rule.name] = (counts[rule.name] ?? 0) + 1;
    for (const rule of Object.keys(counts)) expect(baselineCeiling).toHaveProperty(rule);
    for (const [rule, ceiling] of Object.entries(baselineCeiling)) {
      expect(counts[rule] ?? 0).toBeLessThanOrEqual(ceiling);
    }
  });

  // `pnpm architecture:check` reads one `--ignore-known` run: a listed violation still present
  // comes back with the severity `ignore`, so a listed one that does not is stale.
  const violation = (name: string, severity: string, from: string) => ({
    rule: { name, severity },
    from,
    to: 'packages/core/src/db/index.ts',
  });

  it('architecture:check refuses a violation the baseline does not list, and a stale entry', () => {
    const known = [violation('r', 'error', 'a.ts'), violation('r', 'error', 'fixed.ts')];
    const run = [violation('r', 'ignore', 'a.ts'), violation('r', 'error', 'new.ts')];
    expect(compareWithBaseline(run, known)).toStrictEqual({
      unlisted: ['r: new.ts -> packages/core/src/db/index.ts'],
      stale: ['r: fixed.ts -> packages/core/src/db/index.ts'],
    });
  });

  it('architecture:check accepts a run whose every violation is a listed one still present', () => {
    const known = [violation('r', 'error', 'a.ts'), violation('s', 'error', 'b.ts')];
    const run = [violation('r', 'ignore', 'a.ts'), violation('s', 'ignore', 'b.ts')];
    expect(compareWithBaseline(run, known)).toStrictEqual({ unlisted: [], stale: [] });
    expect(REGENERATE_BASELINE).toContain(`> ${KNOWN_VIOLATIONS}`);
  });
});
