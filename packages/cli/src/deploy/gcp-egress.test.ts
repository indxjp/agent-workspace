import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { PLATFORM_IMAGE_VERSION } from '../release-images.js';
import { digest, egressRelease, gcpProject, REGISTRY } from './gcp-fixtures.test-support.ts';
import { commandLine } from './gcp-runner.test-support.ts';
import { scenario, variablesOf } from './gcp-scenario.test-support.ts';
import type { ToolInvocation } from './runner.js';

const copies = (calls: readonly ToolInvocation[]) =>
  calls.map(commandLine).filter((line) => line.includes('imagetools create'));

const tfvarsOf = async (moduleDirectory: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(path.join(moduleDirectory, 'terraform.tfvars.json'), 'utf8')) as Record<
    string,
    unknown
  >;

it('copies five images and writes neither the variable nor the image while it is unset', async () => {
  const { run, calls, moduleDirectory, stateDirectory } = await scenario();

  await run();

  expect(copies(calls)).toHaveLength(5);
  expect(copies(calls).join('\n')).not.toContain('egress-proxy');
  expect(await tfvarsOf(moduleDirectory)).not.toHaveProperty('sandbox_internet');
  expect(Object.keys((await variablesOf(stateDirectory)).images)).toEqual([
    'web',
    'gateway',
    'runner',
    'runtime',
    'tool_host',
  ]);
});

it('copies the egress proxy as a sixth image and pins its Artifact Registry digest', async () => {
  const { run, calls, moduleDirectory, stateDirectory } = await scenario({
    project: await gcpProject('acme-ai', { sandboxInternet: true }),
    images: egressRelease,
  });

  await run();

  expect(copies(calls)).toHaveLength(6);
  expect(copies(calls)).toContain(
    `docker buildx imagetools create --tag ${REGISTRY}/egress-proxy:${PLATFORM_IMAGE_VERSION} ${egressRelease.egressProxy}`,
  );
  expect((await tfvarsOf(moduleDirectory))['sandbox_internet']).toBe(true);
  expect((await variablesOf(stateDirectory)).images['egress_proxy']).toBe(
    `${REGISTRY}/egress-proxy@${digest('7')}`,
  );
});

it('copies nothing on a second run once the pin is in the registry', async () => {
  const { run, calls } = await scenario({
    project: await gcpProject('acme-ai', { sandboxInternet: true }),
    images: egressRelease,
  });
  await run();
  calls.length = 0;

  await run();

  expect(copies(calls)).toEqual([]);
});

it('pins an AW_EGRESS_PROXY_IMAGE override instead of the release image', async () => {
  const override = `ghcr.io/example/proxy@${digest('8')}`;
  const { run, calls, stateDirectory } = await scenario({
    project: await gcpProject('acme-ai', { sandboxInternet: true }),
    images: egressRelease,
    env: { AW_EGRESS_PROXY_IMAGE: override },
  });

  await run();

  expect(copies(calls)).toContain(
    `docker buildx imagetools create --tag ${REGISTRY}/egress-proxy:${PLATFORM_IMAGE_VERSION} ${override}`,
  );
  expect((await variablesOf(stateDirectory)).images['egress_proxy']).toBe(
    `${REGISTRY}/egress-proxy@${digest('8')}`,
  );
});
