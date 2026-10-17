import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { pinnedImageBuilds, remainingBefore } from './images.mjs';
import {
  composeOverride,
  leftoversOf,
  parseCreateOutput,
  parseDotEnv,
  withTarballOverrides,
} from './project.mjs';
import { nodeImageOf, positiveIntegerVariable } from './run.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');

describe('the generated-project E2E reads what create prints', () => {
  it('takes the administrator, the one-time password and the next step', () => {
    const output = [
      'Host runtime detected: docker — detected; generated Compose uses isolated Docker',
      '',
      'Created /work/gp-e2e-1',
      '  compose.yaml',
      'Administrator: admin@example.com',
      'One-time setup password: Zk3_-x',
      'Next: cd /work/gp-e2e-1 && pnpm install --frozen-lockfile=false && pnpm start',
    ].join('\n');
    expect(parseCreateOutput(output)).toEqual({
      adminEmail: 'admin@example.com',
      adminPassword: 'Zk3_-x',
      nextStep: 'cd /work/gp-e2e-1 && pnpm install --frozen-lockfile=false && pnpm start',
    });
    expect(() => parseCreateOutput('Created /work/x\n')).toThrow(/no administrator/u);
  });

  it('reads a generated .env', () => {
    expect(parseDotEnv('# comment\nPORT=3000\nEMPTY=\nURL=postgres://a:b@c/d?x=1\n')).toEqual({
      PORT: '3000',
      EMPTY: '',
      URL: 'postgres://a:b@c/d?x=1',
    });
  });
});

describe('the generated-project E2E installs this change’s packages', () => {
  it('overrides every packed package with its tarball, once', () => {
    const yaml = withTarballOverrides('packages: []\n', {
      '@indx-workspace/sdk': '/w/packs/indx-workspace-sdk-0.1.2.tgz',
      '@indx-workspace/cli': '/w/packs/indx-workspace-cli-0.1.2.tgz',
    });
    expect(yaml).toBe(
      [
        'packages: []',
        'overrides:',
        "  '@indx-workspace/cli': 'file:/w/packs/indx-workspace-cli-0.1.2.tgz'",
        "  '@indx-workspace/sdk': 'file:/w/packs/indx-workspace-sdk-0.1.2.tgz'",
        '',
      ].join('\n'),
    );
    expect(() => withTarballOverrides(yaml, {})).toThrow(/already declares overrides/u);
  });

  it('the generated pnpm-workspace.yaml it extends declares no overrides of its own', () => {
    const template = readFileSync(
      path.join(ROOT, 'packages/cli/templates/pnpm-workspace.yaml'),
      'utf8',
    );
    expect(() => withTarballOverrides(template, {})).not.toThrow();
  });

  it('builds exactly the four images the generator pins, from the release plan', () => {
    const builds = pinnedImageBuilds('localhost:5000');
    expect(builds.map(({ field, variable }) => [field, variable])).toEqual([
      ['web', 'AW_WEB_IMAGE'],
      ['gateway', 'AW_GATEWAY_IMAGE'],
      ['runner', 'AW_RUNNER_IMAGE'],
      ['runtime', 'AW_RUNTIME_IMAGE'],
    ]);
    const runtime = builds.find((build) => build.field === 'runtime');
    expect(runtime?.reference).toBe('localhost:5000/agent-workspace/runtime-claude-agent-sdk:e2e');
    expect(runtime?.buildArgs['ENGINE']).toBe('claude-agent-sdk');
    expect(builds.find((build) => build.field === 'web')?.target).toBe('web');
    // Each override is one the generator reads (packages/cli/src/deployment.ts).
    const deployment = readFileSync(path.join(ROOT, 'packages/cli/src/deployment.ts'), 'utf8');
    expect(deployment).toContain('environment[`AW_${name.toUpperCase()}_IMAGE`]');
  });

  it('runs the fake provider on the digest-pinned Node image the platform images use', () => {
    const image = nodeImageOf(readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8'));
    expect(image).toMatch(/^node:[0-9.]+-bookworm-slim@sha256:[0-9a-f]{64}$/u);
    expect(() => nodeImageOf('ARG NODE_IMAGE=node:24\n')).toThrow(/by digest/u);
  });

  it('caps the preparation: a step gets only the time left, and none once the budget is spent', () => {
    expect(remainingBefore(10_000, 4_000)).toBe(6_000);
    expect(() => remainingBefore(10_000, 10_000)).toThrow(/budget is spent/u);
    expect(() => remainingBefore(Number.NaN, 0)).toThrow(/not a finite time/u);
    expect(() => remainingBefore(Number.POSITIVE_INFINITY, 0)).toThrow(/not a finite time/u);
  });

  it('takes a numeric harness variable only as a positive safe integer, naming it otherwise', () => {
    expect(positiveIntegerVariable('GP_REGISTRY_PORT', 5000, { max: 65_535 }, {})).toBe(5000);
    expect(
      positiveIntegerVariable(
        'GP_REGISTRY_PORT',
        5000,
        { max: 65_535 },
        { GP_REGISTRY_PORT: '5001' },
      ),
    ).toBe(5001);
    for (const raw of ['', 'abc', '0', '-5', '1.5', '1e3', '70000']) {
      expect(() =>
        positiveIntegerVariable(
          'GP_REGISTRY_PORT',
          5000,
          { max: 65_535 },
          { GP_REGISTRY_PORT: raw },
        ),
      ).toThrow(/^GP_REGISTRY_PORT must be a positive integer/u);
    }
    expect(() =>
      positiveIntegerVariable(
        'GP_PREPARE_TIMEOUT_MS',
        1,
        {},
        {
          GP_PREPARE_TIMEOUT_MS: '9007199254740993',
        },
      ),
    ).toThrow(/^GP_PREPARE_TIMEOUT_MS must be a positive integer/u);
  });
});

describe('the Compose override that adds the fake provider', () => {
  const override = composeOverride({ nodeImage: 'node:24@sha256:abc', controlPort: 18081 });

  it('puts the fake on the gateway’s and the web service’s way out, as api.anthropic.com', () => {
    expect(override).toContain('provider-egress: { aliases: [api.anthropic.com] }');
    expect(override).toContain('web-ingress: { aliases: [api.anthropic.com] }');
    expect(override).toContain("ports: ['127.0.0.1:18081:8081']");
    expect(override).toContain('image: node:24@sha256:abc');
  });

  it('makes web and gateway trust its CA and exempt only that host from the range check', () => {
    for (const service of ['gateway', 'web']) {
      const block = override.split(`\n  ${service}:\n`)[1]?.split(/\n {2}[a-z-]+:\n/u)[0] ?? '';
      expect(block).toContain('EGRESS_ALLOW_HOSTS: api.anthropic.com');
      expect(block).toContain('NODE_EXTRA_CA_CERTS: /e2e/ca.pem');
      expect(block).toContain('./.e2e/ca.pem:/e2e/ca.pem:ro');
      expect(block).toContain('fake-anthropic: { condition: service_healthy }');
    }
  });

  it('names only services and networks the generated compose.yaml defines', () => {
    const generated = readFileSync(path.join(ROOT, 'packages/cli/templates/compose.yaml'), 'utf8');
    for (const name of ['gateway', 'web']) expect(generated).toContain(`\n  ${name}:\n`);
    for (const name of ['provider-egress', 'web-ingress'])
      expect(generated).toContain(`\n  ${name}:`);
  });
});

describe('what of a project is left on the Docker host', () => {
  const project = 'gp-e2e-1';
  const ps = (...rows: (readonly [string, string, string, string])[]) =>
    rows.map((row) => row.join('\t')).join('\n');

  it('is nothing when the listing holds only other projects', () => {
    const listing = ps(
      ['a', 'other-web-1', 'com.docker.compose.project=other', 'other_control'],
      ['b', 'agent-workspace-x', 'agent-workspace.runtime=docker', 'other-runtime-control'],
    );
    expect(leftoversOf(project, listing, 'bridge\nother-runtime-control\n')).toEqual({
      containers: [],
      networks: [],
    });
  });

  it('finds Compose containers, the project’s sandboxes and its networks', () => {
    const listing = ps(
      ['a', `${project}-web-1`, `com.docker.compose.project=${project}`, `${project}_control`],
      ['b', 'agent-workspace-1', 'agent-workspace.runtime=docker', `${project}-runtime-control`],
      [
        'c',
        'agent-workspace-2',
        `agent-workspace.runtime=docker,agent-workspace.compose-project=${project}`,
        '',
      ],
    );
    const left = leftoversOf(
      project,
      listing,
      `bridge\n${project}-runtime-control\n${project}_control\n`,
    );
    expect(left.containers.map((container) => container.name)).toEqual([
      `${project}-web-1`,
      'agent-workspace-1',
      'agent-workspace-2',
    ]);
    expect(left.networks).toEqual([`${project}-runtime-control`, `${project}_control`]);
  });
});
