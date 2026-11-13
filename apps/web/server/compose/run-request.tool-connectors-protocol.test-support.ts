import { describe, expect, it } from 'vitest';

import type { AgentPolicy } from '../../contracts/agents';

import { GATEWAY, SETTINGS } from './run-request.fixture.test-support';
import type { createToolConnectorsFixture } from './run-request.tool-connectors.fixture.test-support';
export function registerProtocolCases({
  ORDERS_LOW,
  MCP_KEY,
  loaderWith,
  compose,
  orders,
  openaiAgents,
}: ReturnType<typeof createToolConnectorsFixture>) {
  it('seam check 1: an MCP connector entry is byte-identical with and without a tool connector', async () => {
    const before = await compose(loaderWith(undefined), undefined);
    const after = await compose(loaderWith(orders), () => Promise.resolve());
    expect(after.portable.mcpServers[MCP_KEY]).toEqual(before.portable.mcpServers[MCP_KEY]);
    expect(JSON.stringify(after.portable.mcpServers[MCP_KEY])).toBe(
      JSON.stringify(before.portable.mcpServers[MCP_KEY]),
    );
    // MCP entries keep their order; the tool entries follow.
    expect(Object.keys(after.portable.mcpServers)).toEqual([MCP_KEY, 'orders']);
  });
  it('hands an openapi connector over as an http server at the gateway holding only the run token', async () => {
    const request = await compose(loaderWith(orders), () => Promise.resolve());
    const token = request.env['ANTHROPIC_AUTH_TOKEN'];
    expect(request.portable.mcpServers['orders']).toEqual({
      type: 'http',
      url: `${GATEWAY.baseUrl}/v1/tools/${ORDERS_LOW}/mcp`,
      headers: { authorization: `Bearer ${String(token)}` },
    });
    expect(Object.keys(request.portable.mcpServers)).not.toContain(`connector-${ORDERS_LOW}`);
    // The loader handed compose no upstream URL or credential, so none can reach the request.
    const body = JSON.stringify(request);
    expect(body).not.toContain('orders.example.test');
    expect(body).not.toContain('upstream-secret');
  });
  describe('a write operation is implicitly requireApproval (ADR-0113 SD4)', () => {
    const quote = {
      key: 'erp',
      name: 'erp',
      connectorId: ORDERS_LOW,
      operationNames: ['getRate', 'createQuote'],
      approvalRules: ['mcp__erp__createQuote'],
    };
    const quotes = [quote];
    const claudeWithGate: AgentPolicy = {
      engine: 'claude-agent-sdk',
      tools: {
        base: 'claude_code_preset',
        autoApprove: [],
        deny: [],
        permissionMode: 'default',
        allowDangerouslySkipPermissions: false,
      },
      requireApproval: ['Bash', 'mcp__erp__createQuote'],
      skills: { mode: 'all' },
      limits: { maxTurns: null, maxBudgetUsd: null },
    };

    it('gives the Claude arm the connector write rule, carrying the run server key', async () => {
      const request = await compose(loaderWith(quotes), () => Promise.resolve());
      expect(request.policy).toMatchObject({ requireApproval: ['mcp__erp__createQuote'] });
      const suffixed = await compose(
        loaderWith([{ ...quote, key: 'erp_2', approvalRules: ['mcp__erp_2__createQuote'] }]),
        () => Promise.resolve(),
      );
      expect(suffixed.policy).toMatchObject({ requireApproval: ['mcp__erp_2__createQuote'] });
    });

    it('merges the stored rules with the connector rules, without a duplicate', async () => {
      const request = await compose(loaderWith(quotes), () => Promise.resolve(), claudeWithGate);
      expect(request.policy).toMatchObject({
        requireApproval: ['Bash', 'mcp__erp__createQuote'],
      });
    });

    it('leaves requireApproval out for a read-only connector', async () => {
      const request = await compose(loaderWith(orders), () => Promise.resolve());
      expect(request.policy).not.toHaveProperty('requireApproval');
    });

    it('sends a withholding engine no requireApproval; the gateway backstop refuses the write', async () => {
      const request = await compose(loaderWith(quotes), () => Promise.resolve(), openaiAgents);
      expect(request.policy).not.toHaveProperty('requireApproval');
    });
  });
  it('seam check 3: the tool url is on the gateway base the sandbox reaches, not the runner or web origin', async () => {
    const request = await compose(loaderWith(orders), () => Promise.resolve());
    const entry = request.portable.mcpServers['orders'];
    if (entry === undefined || !('url' in entry)) throw new Error('no http entry for orders');
    expect(new URL(entry.url).host).toBe(new URL(GATEWAY.baseUrl).host);
    expect(new URL(entry.url).host).toBe(request.env['ANTHROPIC_BASE_URL']?.replace('http://', ''));
    expect(new URL(entry.url).host).not.toBe(new URL(SETTINGS.runnerUrl).host);
  });
}
