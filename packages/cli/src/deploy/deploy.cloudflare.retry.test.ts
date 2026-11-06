import { describe, expect, it } from 'vitest';

import { isWorkerPropagating } from './cloudflare.js';
import { runDeployCommand } from './command.js';
import type { ToolInvocation } from './runner.js';
import { captured, capturedFailure, stubRunner, type Respond } from './deploy.test-support.js';
import {
  bulksOf,
  cloudflareEnvironment,
  cloudflareProject,
  cloudflareResponder,
} from './deploy.cloudflare.test-support.js';

const propagating =
  '✘ [ERROR] A request to the Cloudflare API (/accounts/acct123/workers/workers/acme-ai-gateway) ' +
  'failed.\n  This Worker does not exist on your account. [code: 10007]';
const delaysMs = [1, 1, 1];

/** `wrangler deploy` of the gateway Worker fails with `stderr` for its first `failures` runs. */
function failingGatewayDeploy(failures: number, stderr: string) {
  const { respond } = cloudflareResponder(false);
  let seen = 0;
  const wrapped: Respond = (invocation) => {
    const { args } = invocation;
    if (args[0] === 'deploy' && args[4] === 'acme-ai-gateway') {
      seen += 1;
      if (seen <= failures) return { status: 1, stderr };
    }
    return respond(invocation);
  };
  return stubRunner(wrapped);
}
const gatewayDeploys = (calls: readonly ToolInvocation[]) =>
  calls.filter(({ args }) => args[0] === 'deploy' && args[4] === 'acme-ai-gateway').length;

function classifyAndRetryCases(): void {
  it('matches code 10007 only', () => {
    expect(isWorkerPropagating(propagating)).toBe(true);
    expect(isWorkerPropagating('Authentication error [code: 10000]')).toBe(false);
    expect(isWorkerPropagating('The bucket does not exist. [code: 10006]')).toBe(false);
    expect(isWorkerPropagating('Worker 10007 not found')).toBe(false);
  });

  it('runs the deploy again until Cloudflare knows the Worker, then carries on', async () => {
    const target = await cloudflareProject();
    const { runner, calls } = failingGatewayDeploy(2, propagating);

    const { result, output } = await captured(() =>
      runDeployCommand([target, '--yes'], {
        runner,
        environment: cloudflareEnvironment,
        workerRetryDelaysMs: delaysMs,
      }),
    );

    expect(result).toEqual({ changes: true, applied: true });
    expect(gatewayDeploys(calls)).toBe(3);
    expect(output).toContain('[code: 10007]');
    expect(output).toContain('That failure is transient');
    expect(output).toContain('Applied.');
  });

  it('stops after the last delay with the typed failure', async () => {
    const target = await cloudflareProject();
    const { runner, calls } = failingGatewayDeploy(Infinity, propagating);

    const { message } = await capturedFailure(() =>
      runDeployCommand([target, '--yes'], {
        runner,
        environment: cloudflareEnvironment,
        workerRetryDelaysMs: delaysMs,
      }),
    );

    expect(gatewayDeploys(calls)).toBe(1 + delaysMs.length);
    expect(message).toBe('`wrangler deploy` failed (exit status 1); its output is above.');
    expect(calls.some(({ args }) => args[0] === 'secret' && args[1] === 'bulk')).toBe(false);
  });
}

function noRetryCases(): void {
  it('does not retry any other error', async () => {
    const target = await cloudflareProject();
    const { runner, calls } = failingGatewayDeploy(Infinity, 'Authentication error [code: 10000]');

    const { message } = await capturedFailure(() =>
      runDeployCommand([target, '--yes'], {
        runner,
        environment: cloudflareEnvironment,
        workerRetryDelaysMs: delaysMs,
      }),
    );

    expect(gatewayDeploys(calls)).toBe(1);
    expect(message).toContain('`wrangler deploy` failed');
  });

  it('reads 10007 from `secret list` as a missing Worker, without retrying it', async () => {
    const target = await cloudflareProject();
    const { respond } = cloudflareResponder(false);
    const { runner, calls } = stubRunner((invocation) => {
      const { args } = invocation;
      if (args[0] === 'secret' && args[1] === 'list') {
        return { status: 1, stderr: 'This Worker does not exist on your account. [code: 10007]' };
      }
      return respond(invocation);
    });

    const { result } = await captured(() =>
      runDeployCommand([target, '--yes'], {
        runner,
        environment: cloudflareEnvironment,
        workerRetryDelaysMs: delaysMs,
      }),
    );

    expect(result).toEqual({ changes: true, applied: true });
    expect(calls.filter(({ args }) => args[0] === 'secret' && args[1] === 'list')).toHaveLength(1);
    expect(calls.some(({ args }) => args[0] === 'deploy' && args[4] === 'acme-ai')).toBe(true);
  });
}

function bulkRetryCase(): void {
  it('runs `secret bulk` again while Cloudflare does not know the Worker yet', async () => {
    const target = await cloudflareProject();
    const { respond } = cloudflareResponder(false);
    let failed = false;
    const { runner, calls } = stubRunner((invocation) => {
      const { args } = invocation;
      if (args[0] === 'secret' && args[1] === 'bulk' && args[3] === 'acme-ai-gateway' && !failed) {
        failed = true;
        return { status: 1, stderr: propagating };
      }
      return respond(invocation);
    });

    const { result } = await captured(() =>
      runDeployCommand([target, '--yes'], {
        runner,
        environment: cloudflareEnvironment,
        workerRetryDelaysMs: delaysMs,
      }),
    );

    expect(result).toEqual({ changes: true, applied: true });
    expect(bulksOf(calls).filter(({ args }) => args[3] === 'acme-ai-gateway')).toHaveLength(2);
  });
}

describe('agent-workspace deploy to Cloudflare', () => {
  describe('tolerates Cloudflare not knowing a Worker it just uploaded (error 10007)', () => {
    classifyAndRetryCases();
    noRetryCases();
    bulkRetryCase();
  });
});
