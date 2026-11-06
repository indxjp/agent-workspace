import { log as webLogger } from '../telemetry/logger';

import { verifyIdentity } from '@indx-workspace/contracts/identity-assertion';

import { describe, expect, it, vi } from 'vitest';

import {
  apiKey,
  compose,
  KEY,
  MCP_ID,
  MCP_KEY,
  member,
  optedInMcp,
  optedInTool,
  RUN,
  USER,
  WORKSPACE,
} from './run-request.fixture.test-support';
export function registerIdentityAssertionTests() {
  describe('buildRunRequestFor — the identity assertion (ADR-0142)', () => {
    it('signs an assertion for the member, replaces a stored spelling of the header, and logs nothing', async () => {
      const spies = (['info', 'warn', 'error'] as const).map((level) =>
        vi.spyOn(webLogger, level).mockImplementation(() => undefined),
      );
      try {
        const { run, issued } = await compose(optedInMcp, member);
        const server = (await run()).portable.mcpServers[MCP_KEY] as {
          headers: Record<string, string>;
        };
        expect(Object.keys(server.headers).sort()).toEqual(['X-Api-Key', 'x-aw-identity']);
        const verified = await verifyIdentity(
          server.headers['x-aw-identity'] ?? '',
          KEY,
          new Date(),
          { audience: MCP_ID, workspace: WORKSPACE },
        );
        expect(verified).toMatchObject({
          ok: true,
          payload: { sub: USER, principalKind: 'membership', runId: RUN, aud: MCP_ID },
        });
        expect(issued).toEqual([
          expect.objectContaining({ caller: { sub: USER, principalKind: 'membership' } }),
        ]);
        for (const spy of spies) expect(spy).not.toHaveBeenCalled();
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
    });

    it('asserts the subject an API key names', async () => {
      const { run, issued } = await compose(optedInTool, apiKey, 'customer-42');
      await run();
      expect(issued).toEqual([
        expect.objectContaining({ caller: { sub: 'customer-42', principalKind: 'api-key' } }),
      ]);
    });

    it.each([
      ['an MCP connector', optedInMcp],
      ['a tool connector', optedInTool],
    ])(
      'refuses before a token is issued when %s opted in and the run has no caller',
      async (_name, resources) => {
        for (const principal of [apiKey, {}]) {
          const { run, issued } = await compose(resources, principal);
          await expect(run()).rejects.toMatchObject({ code: 'connector_identity_unsupported' });
          expect(issued).toEqual([]);
        }
      },
    );

    it('leaves a run with no opted-in connector, and no caller, as it was', async () => {
      const { run, issued } = await compose({ files: [], skills: [], mcpServers: {} }, {});
      await run();
      expect(issued).toEqual([
        expect.not.objectContaining({ caller: expect.anything() as unknown }),
      ]);
    });
  });
}
