import { toolSandboxRunToken } from '@agent-workspace/gateway/tokens';

import { describe, expect, it } from 'vitest';
import type { RunAgent } from '../agent-versions/session-version';

import { DomainError } from '../errors';

import { createRunTokenIssuer, type RunTokenIssuer } from '../gateway/issuer';

import { buildRunRequestFor, type RuntimeSettings } from './run-request';
import {
  ALL_ON,
  GATEWAY,
  SETTINGS,
  SIGNING_SECRET,
  issued,
  launchContext,
  rowRunAgent,
} from './run-request.fixture.test-support';
export function registerCodeToolsTests() {
  describe('buildRunRequestFor with code tools (ADR-0118 TS3, TS8)', () => {
    const TOOLS = [{ tool: 'get_order', digest: 'a'.repeat(64) }];
    const HOST_LOADER = {
      load: () =>
        Promise.resolve({
          files: [],
          skills: [],
          mcpServers: {
            host: { type: 'http' as const, url: 'https://tool-sandbox.invalid/mcp' },
            other: { type: 'http' as const, url: 'https://mcp.example.test' },
          },
          connectorNames: { host: 'aw-dev-tools', other: 'github' },
        }),
    };

    async function compose(
      settings: RuntimeSettings,
      loader: typeof HOST_LOADER | undefined,
      gateway: RunTokenIssuer = GATEWAY,
    ) {
      const { context, agents } = await launchContext();
      const runAgent: RunAgent = { ...(await rowRunAgent(agents, context)), toolBundles: TOOLS };
      return buildRunRequestFor(
        context,
        runAgent,
        settings,
        gateway,
        {},
        ALL_ON,
        null,
        loader,
      ).then(
        (request) => ({ request, error: undefined, runId: context.run.id }),
        (error: unknown) => {
          if (!(error instanceof DomainError)) throw error;
          return { request: undefined, error, runId: context.run.id };
        },
      );
    }

    it('points the tool host connector at the gateway with the run token, never at the sandbox', async () => {
      // The real issuer, keyed by the signing secret the sandbox bearer derives from.
      const { request, runId } = await compose(
        { ...SETTINGS, toolSandbox: true },
        HOST_LOADER,
        createRunTokenIssuer({
          baseUrl: GATEWAY.baseUrl,
          signingSecret: SIGNING_SECRET,
          ttlSeconds: 300,
        }),
      );
      expect(request?.portable.mcpServers['host']).toEqual({
        type: 'http',
        url: 'http://gateway:4000/v1/tool-sandbox/mcp',
        headers: {
          authorization: `Bearer ${String(request?.gateway?.token)}`,
          'x-aw-agent': 'General',
        },
      });
      expect(request?.portable.mcpServers['other']).toEqual({
        type: 'http',
        url: 'https://mcp.example.test',
      });
      expect(JSON.stringify(request)).not.toContain('tool-sandbox.invalid');
      // The sandbox's own bearer is derived from the signing secret and never enters the request.
      const toolToken = await toolSandboxRunToken(SIGNING_SECRET, runId);
      expect(JSON.stringify(request)).not.toContain(toolToken);
    });

    it('refuses by name, before a token is issued, when the runtime has no tool sandbox', async () => {
      const before = issued;
      const { error } = await compose(SETTINGS, HOST_LOADER);
      expect(error?.code).toBe('code_tool_needs_host');
      expect(error?.publicMessage).toContain('get_order');
      expect(issued).toBe(before);
    });

    it('keeps the loopback header path for a pin whose tool host is a real host and no sandbox (TS7)', async () => {
      const loopback = {
        load: () =>
          Promise.resolve({
            files: [],
            skills: [],
            mcpServers: {
              host: { type: 'http' as const, url: 'http://127.0.0.1:9/mcp' },
              other: { type: 'http' as const, url: 'https://mcp.example.test' },
            },
            connectorNames: { host: 'aw-dev-tools', other: 'github' },
          }),
      };
      const { request, error, runId } = await compose(SETTINGS, loopback);
      expect(error).toBeUndefined();
      expect(request?.portable.mcpServers['host']).toEqual({
        type: 'http',
        url: 'http://127.0.0.1:9/mcp',
        headers: { 'x-aw-run-id': runId, 'x-aw-agent': 'General' },
      });
    });

    it('refuses by name when the tool host connector is not among the run’s servers', async () => {
      const { error } = await compose({ ...SETTINGS, toolSandbox: true }, undefined);
      expect(error?.code).toBe('code_tool_connector_missing');
      expect(error?.publicMessage).toContain('get_order');
    });
  });
}
