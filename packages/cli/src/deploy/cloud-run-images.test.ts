import { describe, expect, it } from 'vitest';

import { PLATFORM_IMAGE_SIGNER } from '../release-images.js';
import { copyImagesToArtifactRegistry } from './cloud-run-images.js';
import { digest, stubRunner, type Respond } from './deploy.test-support.js';
import type { ToolInvocation, ToolRunner } from './runner.js';
import type { DeployContext } from './steps.js';

const registry = 'asia-northeast1-docker.pkg.dev/acme-prod/agent-workspace';
const references = {
  web: `ghcr.io/indxjp/agent-workspace/web@${digest('1')}`,
  gateway: `ghcr.io/indxjp/agent-workspace/gateway@${digest('2')}`,
  runner: `ghcr.io/indxjp/agent-workspace/runner@${digest('3')}`,
  runtime: `ghcr.io/indxjp/agent-workspace/runtime@${digest('4')}`,
};

/** A registry that holds what `imagetools create` copied, and a cosign that answers `cosign`. */
function harness(cosign: 'ok' | 'missing' | 'rejects' | 'old') {
  const present = new Set<string>();
  const respond: Respond = ({ tool, args }) => {
    if (tool === 'cosign') {
      if (args[0] === 'version') {
        return { stdout: `GitVersion:    v${cosign === 'old' ? '2.4.1' : '3.1.4'}\n` };
      }
      return cosign === 'rejects'
        ? { status: 12, stderr: 'Error: no matching signatures\nmore' }
        : {};
    }
    if (tool !== 'docker') return {};
    if (args[2] === 'create') {
      const [tagged = '', source = ''] = args.slice(4);
      present.add(
        `${tagged.slice(0, tagged.lastIndexOf(':'))}${source.slice(source.indexOf('@'))}`,
      );
      return {};
    }
    const reference = args[3] ?? '';
    return present.has(reference)
      ? { stdout: JSON.stringify({ digest: reference.slice(reference.indexOf('@') + 1) }) }
      : { status: 1, stderr: 'not found' };
  };
  const stub = stubRunner(respond);
  const runner: ToolRunner = (invocation) =>
    invocation.tool === 'cosign' && cosign === 'missing'
      ? (stub.calls.push(invocation),
        Promise.reject(Object.assign(new Error('spawn cosign ENOENT'), { code: 'ENOENT' })))
      : stub.runner(invocation);
  const out: string[] = [];
  const context: DeployContext = {
    runner,
    directory: '/tmp',
    env: {},
    cloud: 'gcp',
    out: (text) => void out.push(text),
    err: (text) => void out.push(text),
  };
  return { context, calls: stub.calls, out };
}

const request = (context: DeployContext, apply: boolean, signed: ReadonlySet<string>) => ({
  context,
  moduleDirectory: '/module',
  references,
  apply,
  tag: '0.1.0',
  ownerEmail: 'owner@example.com',
  registry,
  signed,
});
const cosignCalls = (calls: readonly ToolInvocation[]) =>
  calls.filter(({ tool, args }) => tool === 'cosign' && args[0] === 'verify');
const isCreate = ({ tool, args }: ToolInvocation) => tool === 'docker' && args[2] === 'create';

describe('cosign verification of the release images', () => {
  it('verifies only the pinned sources, with the images.yml identity and issuer', async () => {
    const { context, calls, out } = harness('ok');
    await copyImagesToArtifactRegistry(
      request(context, true, new Set([references.web, references.gateway])),
    );
    expect(cosignCalls(calls).map(({ args }) => args)).toEqual(
      [references.web, references.gateway].map((source) => [
        'verify',
        source,
        '--certificate-identity-regexp',
        PLATFORM_IMAGE_SIGNER.identityRegexp,
        '--certificate-oidc-issuer',
        PLATFORM_IMAGE_SIGNER.issuer,
      ]),
    );
    expect(out.join('')).toContain('Verified the cosign signatures of 2 release images.');
    expect(calls.filter(isCreate)).toHaveLength(4);
  });

  it('does not call cosign for sources that are not in the pinned set', async () => {
    const { context, calls, out } = harness('ok');
    await copyImagesToArtifactRegistry(request(context, true, new Set()));
    expect(cosignCalls(calls)).toEqual([]);
    expect(out.join('')).not.toContain('cosign');
  });

  it('continues with a notice when cosign is not on PATH', async () => {
    const { context, calls, out } = harness('missing');
    await copyImagesToArtifactRegistry(request(context, true, new Set([references.web])));
    expect(
      out
        .join('')
        .split('cosign is not on PATH, so the release image signatures were not verified.'),
    ).toHaveLength(2);
    expect(calls.filter(isCreate)).toHaveLength(4);
  });

  it('refuses before any copy when cosign rejects a signature', async () => {
    const { context, calls } = harness('rejects');
    const failure = await copyImagesToArtifactRegistry(
      request(context, true, new Set([references.web])),
    ).then(
      () => '',
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    expect(failure).toContain(references.web);
    expect(failure).toContain('Error: no matching signatures');
    expect(failure).not.toContain('more');
    expect(failure.endsWith('Nothing was applied.')).toBe(true);
    expect(calls.filter(isCreate)).toEqual([]);
  });

  it('continues with a notice when cosign is older than v3', async () => {
    const { context, calls, out } = harness('old');
    await copyImagesToArtifactRegistry(request(context, true, new Set([references.web])));
    expect(cosignCalls(calls)).toEqual([]);
    expect(out.join('')).toContain('cosign is older than v3');
    expect(calls.filter(isCreate)).toHaveLength(4);
  });

  it('does not call cosign without apply', async () => {
    const { context, calls } = harness('ok');
    await copyImagesToArtifactRegistry(request(context, false, new Set([references.web])));
    expect(cosignCalls(calls)).toEqual([]);
  });
});
