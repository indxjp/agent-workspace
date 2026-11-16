import {
  SAMPLE_PORTABLE_PROJECT,
  SAMPLE_PORTABLE_PROJECT_WITHOUT_TOOL_ENDPOINT,
} from '../../testing/index.js';
import { describe, expect, it } from 'vitest';

import {
  ROOT,
  parse,
  sampleWith,
  compile,
  versionOf,
  verdictAt,
  sample,
} from '../../testing/foundry-compile.fixture.test-support.js';

const report = compile(sample).report;
const sampleVerdictAt = (path: string) => report.find((entry) => entry.path === path);

describe('Foundry tool mapping', () => {
  it('maps a bearer MCP server to a tool and a plan connection', () => {
    expect(sampleVerdictAt(`${ROOT}.tools.0`)?.verdict).toBe('mapped');
    const body = versionOf(compile(sample));
    expect(body.definition.tools?.[0]).toEqual({
      type: 'mcp',
      server_label: 'zendesk',
      server_url: 'https://mcp.example.com/zendesk',
      require_approval: 'always',
      project_connection_id: 'aw-zendesk',
    });
  });

  it('drops a stdio MCP server', () => {
    expect(sampleVerdictAt(`${ROOT}.tools.1`)).toMatchObject({
      verdict: 'dropped',
      code: 'stdio_mcp_unsupported',
    });
  });

  it('maps code tools to one shared aw-tools server, or drops them without an endpoint', () => {
    expect(sampleVerdictAt(`${ROOT}.tools.2`)?.verdict).toBe('mapped');
    expect(versionOf(compile(sample)).definition.tools?.[1]).toMatchObject({
      server_label: 'aw-tools',
      allowed_tools: ['get_order'],
      project_connection_id: 'aw-tools',
    });
    const bare = compile(parse(SAMPLE_PORTABLE_PROJECT_WITHOUT_TOOL_ENDPOINT));
    expect(verdictAt(bare, `${ROOT}.tools.2`)).toMatchObject({
      verdict: 'dropped',
      code: 'code_tool_needs_public_mcp',
    });
    expect(JSON.stringify(versionOf(bare))).not.toContain('aw-tools');
  });

  it('warns when a code tool schema uses anyOf', () => {
    const base = SAMPLE_PORTABLE_PROJECT.agents[0];
    const tools = (base?.tools ?? []).map((tool) =>
      tool.kind === 'code'
        ? { ...tool, inputSchema: { anyOf: [{ type: 'string' }, { type: 'number' }] } }
        : tool,
    );
    const result = compile(sampleWith({ tools }));
    expect(verdictAt(result, `${ROOT}.tools.2`)).toMatchObject({ verdict: 'mapped' });
    expect(verdictAt(result, `${ROOT}.tools.2`).note).toContain('Invalid tool schema');
  });
});
