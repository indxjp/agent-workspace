/**
 * The whole `RunRequest` that `buildRunRequestFor` composes, pinned for a few launches, so moving
 * its pure decisions into `compose/core/run-request.ts` (refactoring plan part 07, step 3) cannot
 * change one field a runner receives. Only the agent's generated id is normalized.
 */
import { describe, expect, it } from 'vitest';

import type { RunTokenIssuer } from '../gateway/issuer';
import type { LaunchContext } from '../runs/environment';
import { buildRunRequestFor } from './run-request';
import { ALL_ON, launchContext, rowRunAgent, SETTINGS } from './run-request.fixture.test-support';

/** A gateway that records the claims each run token is issued for. */
function recordingGateway(): { gateway: RunTokenIssuer; claims: unknown[] } {
  const claims: unknown[] = [];
  return {
    claims,
    gateway: {
      baseUrl: 'http://gateway:4000',
      issue: (claim) => {
        claims.push(claim);
        return Promise.resolve('run-token');
      },
    },
  };
}

async function golden(
  launch: (context: LaunchContext) => LaunchContext,
  extra: {
    agentSecrets?: Record<string, string>;
    allOn?: boolean;
    noConnection?: boolean;
    resolvedModel?: { connectionId: string; model: string };
  } = {},
): Promise<unknown> {
  const { context, agents, agentId } = await launchContext();
  const row = await rowRunAgent(agents, context);
  const runAgent = {
    ...row,
    agent: {
      ...row.agent,
      ...(extra.allOn === true ? { permissions: ALL_ON } : {}),
      ...(extra.noConnection === true ? { modelConnectionId: null } : {}),
    },
  };
  const { gateway, claims } = recordingGateway();
  const request = await buildRunRequestFor({
    context: launch(context),
    runAgent,
    settings: SETTINGS,
    gateway,
    resourceLoader: {
      load: () => Promise.resolve({ files: [], skills: [], mcpServers: {} }),
    },
    snapshotTools: () => Promise.resolve(),
    ...(extra.agentSecrets === undefined ? {} : { agentSecrets: extra.agentSecrets }),
    ...(extra.resolvedModel === undefined ? {} : { resolvedModel: extra.resolvedModel }),
  });
  // The token claims carry the model connection the run resolved, which the request itself does not.
  return JSON.parse(
    JSON.stringify({ request, tokenClaims: claims }).replaceAll(agentId, '<agent-id>'),
  ) as unknown;
}

describe('buildRunRequestFor, the whole RunRequest', () => {
  it('a plain fresh run', async () => {
    expect(await golden((context) => context)).toMatchSnapshot();
  });

  it('an override wins over the legacy id and the agent', async () => {
    expect(
      await golden((context) => ({
        ...context,
        modelConnectionId: '99999999-9999-4999-8999-999999999999',
        modelOverride: {
          connectionId: '88888888-8888-4888-8888-888888888888',
          model: 'claude-haiku-5-5',
        },
      })),
    ).toMatchSnapshot();
  });

  it('a resolved model wins over an override', async () => {
    expect(
      await golden(
        (context) => ({
          ...context,
          modelOverride: {
            connectionId: '88888888-8888-4888-8888-888888888888',
            model: 'claude-haiku-5-5',
          },
        }),
        {
          resolvedModel: {
            connectionId: '55555555-5555-4555-8555-555555555555',
            model: 'claude-sonnet-5-5',
          },
        },
      ),
    ).toMatchSnapshot();
  });

  it('a resumed run with a model override, agent secrets and an output schema', async () => {
    expect(
      await golden(
        (context) => ({
          ...context,
          session: { ...context.session, resume: true },
          modelOverride: {
            connectionId: '88888888-8888-4888-8888-888888888888',
            model: 'claude-haiku-5-5',
          },
          outputSchema: { type: 'object' },
        }),
        { agentSecrets: { CRM_TOKEN: 'secret' } },
      ),
    ).toMatchSnapshot();
  });

  it('an all-permissions agent with attachments: read grants, and no shell', async () => {
    expect(
      await golden(
        (context) => ({
          ...context,
          attachments: [
            { fileId: 'f1', path: '.attachments/a/report.pdf', kind: 'file' },
            { fileId: 'f2', path: '.attachments/a/folder', kind: 'directory' },
          ],
        }),
        { allOn: true },
      ),
    ).toMatchSnapshot();
  });

  it('a legacy model connection id with no model of its own', async () => {
    expect(
      await golden((context) => ({
        ...context,
        modelConnectionId: '99999999-9999-4999-8999-999999999999',
      })),
    ).toMatchSnapshot();
  });

  it('refuses a session id that is not safe as a path segment', async () => {
    await expect(
      golden((context) => ({ ...context, session: { ...context.session, id: '../x' } })),
    ).rejects.toThrow('session "../x" is not safe to use as a path segment');
  });

  it('refuses a run whose agent has no model connection', async () => {
    await expect(golden((context) => context, { noConnection: true })).rejects.toThrow(
      /^agent [0-9a-f-]{36} has no model connection; a run-scoped gateway token cannot be resolved$/u,
    );
  });
});
