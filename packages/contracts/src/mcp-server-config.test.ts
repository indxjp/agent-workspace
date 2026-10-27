import { describe, expect, it } from 'vitest';

import { McpServerConfigSchema, McpServerRecordSchema } from './mcp-server-config.js';

describe('the MCP server record schemas', () => {
  it('the record schema refuses the streamable-http alias that the config schema normalises', () => {
    const entry = { type: 'streamable-http', url: 'https://mcp.example.com/mcp' };
    expect(McpServerRecordSchema.safeParse(entry).success).toBe(false);
    expect(McpServerConfigSchema.parse(entry)).toEqual({
      type: 'http',
      url: 'https://mcp.example.com/mcp',
    });
  });

  it('a timeout under 1000 ms is refused', () => {
    expect(McpServerRecordSchema.safeParse({ command: 'mcp-server', timeout: 999 }).success).toBe(
      false,
    );
    expect(McpServerRecordSchema.safeParse({ command: 'mcp-server', timeout: 1000 }).success).toBe(
      true,
    );
  });

  it('an unknown key is refused (strict)', () => {
    expect(McpServerRecordSchema.safeParse({ command: 'mcp-server', cwd: '/tmp' }).success).toBe(
      false,
    );
    expect(
      McpServerRecordSchema.safeParse({
        type: 'http',
        url: 'https://mcp.example.com/mcp',
        tools: [{ name: 'search', surprise: true }],
      }).success,
    ).toBe(false);
  });
});
