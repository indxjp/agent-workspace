// scripts/ci/check-nx-cache-config.mjs (docs/adr/0110): every rule gets a failing and a passing
// fixture, plus one run over the real repository.
import { describe, expect, it } from 'vitest';

import {
  checkCiText,
  checkLockfile,
  checkNxJson,
  checkPackageJson,
  checkTrackedFiles,
  runAll,
} from '../../scripts/ci/check-nx-cache-config.mjs';

const rules = (problems: { rule: string }[]) => problems.map((p) => p.rule);
const workflow = (body: string) =>
  checkCiText(body, '.github/workflows/x.yml', { isWorkflow: true });

// A minimal workflow that uses the action correctly; each test below breaks one thing.
const plan =
  "env:\n  NX_REMOTE_CACHE_KIND: ${{ github.event_name == 'push' && 'write' || 'read' }}\n";
const assertion = '      - name: Assert pull_request runs cannot select remote-cache write\n';
const connect =
  '      - uses: ./.github/actions/nx-remote-cache\n        with:\n          kind: ${{ env.NX_REMOTE_CACHE_KIND }}\n';
const goodWorkflow = `${plan}jobs:\n  a:\n    steps:\n${assertion}${connect}      - run: scripts/ci/nx.sh run-many -t build\n`;

describe('nx.json', () => {
  const ok = {
    neverConnectToCloud: true,
    targetDefaults: { build: { outputs: ['{projectRoot}/dist'] } },
  };

  it('accepts a clean config', () => {
    expect(checkNxJson(ok)).toEqual([]);
  });

  it('rejects nxCloudId and an nx-cloud tasks runner', () => {
    expect(rules(checkNxJson({ ...ok, nxCloudId: '6ab088fdc29e7750ce5efd3f' }))).toEqual([
      'no-nx-cloud-id',
    ]);
    expect(
      rules(checkNxJson({ ...ok, tasksRunnerOptions: { default: { runner: 'nx-cloud' } } })),
    ).toContain('no-nx-cloud-id');
  });

  it('requires neverConnectToCloud: true', () => {
    expect(rules(checkNxJson({ targetDefaults: {} }))).toEqual(['never-connect']);
    expect(rules(checkNxJson({ neverConnectToCloud: false }))).toEqual(['never-connect']);
  });

  it('rejects access-token keys, token-like values and .env outputs', () => {
    expect(rules(checkNxJson({ ...ok, nxCloudAccessToken: 'x' }))).toContain('no-token-keys');
    expect(rules(checkNxJson({ ...ok, foo: { bar: 'abcDEF0123456789abcDEF0123' } }))).toContain(
      'no-token-values',
    );
    expect(
      rules(checkNxJson({ ...ok, targetDefaults: { x: { outputs: ['{projectRoot}/.env*'] } } })),
    ).toContain('no-env-outputs');
  });

  it('ignores // documentation keys', () => {
    expect(checkNxJson({ ...ok, '//x': 'abcDEF0123456789abcDEF0123 mentions nxCloudId' })).toEqual(
      [],
    );
  });
});

describe('package.json and the lockfile', () => {
  it.each(['@nx/s3-cache', '@nx/gcs-cache', '@nx/azure-cache', '@nx/shared-fs-cache'])(
    'rejects the deprecated bucket cache %s',
    (name) => {
      expect(
        rules(checkPackageJson({ devDependencies: { [name]: '1.0.0' } }, 'package.json')),
      ).toEqual(['no-bucket-cache']);
    },
  );

  it('accepts ordinary Nx packages', () => {
    expect(checkPackageJson({ devDependencies: { nx: '23.2.1' } }, 'package.json')).toEqual([]);
  });

  it('rejects a lockfile that resolves a bucket cache', () => {
    expect(rules(checkLockfile("  '@nx/gcs-cache@4.0.0':\n    resolution: {}\n"))).toEqual([
      'no-bucket-cache',
    ]);
    expect(checkLockfile('  nx@23.2.1:\n')).toEqual([]);
  });
});

describe('active CI files', () => {
  it('accepts a workflow that uses the action as designed', () => {
    expect(workflow(goodWorkflow)).toEqual([]);
  });

  it('rejects Nx Cloud tokens, the old kill switch, CI runs and agents', () => {
    expect(rules(workflow('env:\n  NX_CLOUD_ACCESS_TOKEN: ${{ secrets.X }}\n'))).toEqual([
      'no-cloud-ci',
    ]);
    expect(rules(workflow("env:\n  NX_NO_CLOUD: 'true'\n"))).toEqual(['no-cloud-ci']);
    expect(rules(workflow('run: pnpm exec nx-cloud start-ci-run --stop-agents-after=x\n'))).toEqual(
      ['no-cloud-ci'],
    );
    expect(
      rules(workflow('run: nx-cloud start-ci-run --distribute-on="8 linux-medium-js"\n')),
    ).toEqual(['no-cloud-ci', 'no-cloud-ci']);
    expect(rules(checkCiText('NX_CLOUD_ACCESS_TOKEN=x nx run a:b\n', 'scripts/ci/x.sh'))).toEqual([
      'no-cloud-ci',
    ]);
  });

  it('rejects a static write token and cache env set outside the action', () => {
    expect(
      rules(workflow('token: ${{ secrets.NX_SELF_HOSTED_REMOTE_CACHE_WRITE_TOKEN }}\n')),
    ).toEqual(['no-write-token-in-ci']);
    expect(
      rules(workflow('env:\n  NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN: ${{ secrets.X }}\n')),
    ).toEqual(['cache-env-via-action']);
    expect(rules(workflow('env:\n  NX_SELF_HOSTED_REMOTE_CACHE_SERVER: https://x\n'))).toEqual([
      'cache-env-via-action',
    ]);
  });

  it('requires the pull_request write assertion', () => {
    expect(rules(workflow(goodWorkflow.replace(assertion, '')))).toEqual(['pr-write-assertion']);
  });

  it('requires the kind to come from the one plan', () => {
    expect(
      rules(workflow(goodWorkflow.replace('${{ env.NX_REMOTE_CACHE_KIND }}', 'write'))),
    ).toEqual(['cache-kind-plan']);
    expect(rules(workflow(goodWorkflow.replace(plan, '')))).toEqual(['cache-kind-plan']);
    expect(rules(workflow(`${plan}${goodWorkflow}`))).toEqual(['cache-kind-plan']);
  });

  it.each([
    'run: pnpm nx run-many -t build',
    'pnpm nx affected -t test --base=origin/main',
    'run: pnpm exec nx run @agent-workspace/core:build',
    'npx nx run-many -t lint',
    'run: pnpm build',
    'run: pnpm typecheck',
  ])('rejects a raw task-running nx call once the action is used: %s', (line) => {
    expect(rules(workflow(`${goodWorkflow}      - ${line}\n`))).toEqual(['nx-via-wrapper']);
  });

  it('does not apply the wrapper rule to a workflow without the remote cache', () => {
    expect(workflow('      - run: pnpm nx run-many -t build\n')).toEqual([]);
  });
});

it('rejects tracked .env and .nx files but allows examples', () => {
  expect(
    rules(
      checkTrackedFiles(['.env', 'a/.env.local', '.nx/cache/x', 'apps/web/.env.example', 'env.ts']),
    ),
  ).toEqual(['no-tracked-secrets', 'no-tracked-secrets', 'no-tracked-secrets']);
});

it('passes over the repository itself', () => {
  const problems = runAll();
  expect(problems.map((p) => `[${p.rule}] ${p.file}: ${p.message}`)).toEqual([]);
});
