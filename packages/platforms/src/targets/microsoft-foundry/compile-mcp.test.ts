import { type PortableProject } from '@indx-workspace/contracts/portable-agent';
import { SAMPLE_PORTABLE_PROJECT } from '../../testing/index.js';
import { describe, expect, it } from 'vitest';

import {
  ROOT,
  parse,
  sampleWith,
  compile,
  versionOf,
  verdictAt,
  sample,
  planOf,
} from '../../testing/foundry-compile.fixture.test-support.js';

const report = compile(sample).report;
const sampleVerdictAt = (path: string) => report.find((entry) => entry.path === path);

describe('Foundry MCP credentials and builtins', () => {
  it('maps the builtin tools', () => {
    expect(sampleVerdictAt(`${ROOT}.tools.4`)?.verdict).toBe('native');
    expect(sampleVerdictAt(`${ROOT}.tools.5`)?.verdict).toBe('native');
    const tools = versionOf(compile(sample)).definition.tools;
    expect(tools).toContainEqual({ type: 'web_search' });
    expect(tools).toContainEqual({ type: 'code_interpreter', container: { type: 'auto' } });
  });

  it('drops web_fetch and file_access', () => {
    const result = compile(
      sampleWith({
        tools: [
          { kind: 'builtin', id: 'web_fetch' },
          { kind: 'builtin', id: 'file_access' },
        ],
      }),
    );
    for (const index of [0, 1]) {
      expect(verdictAt(result, `${ROOT}.tools.${index}`)).toMatchObject({
        verdict: 'dropped',
        code: 'builtin_unsupported',
      });
    }
  });

  it('maps an SSE MCP server with the unconfirmed-support note', () => {
    const result = compile(
      sampleWith({
        tools: [
          { kind: 'mcp', name: 'legacy', transport: 'sse', url: 'https://mcp.example.com/sse' },
        ],
      }),
    );
    expect(verdictAt(result, `${ROOT}.tools.0`)).toMatchObject({ verdict: 'mapped' });
    expect(verdictAt(result, `${ROOT}.tools.0`).note).toContain('V2');
    expect(versionOf(result).definition.tools?.[0]).not.toHaveProperty('project_connection_id');
  });

  it.each(['api-key', 'oauth2'] as const)(
    'plans a %s MCP connection by secret name and leaves the ARM authType to the publish step',
    (scheme) => {
      const result = compile(
        sampleWith({
          tools: [
            {
              kind: 'mcp',
              name: 'keyed',
              transport: 'streamable-http',
              url: 'https://mcp.example.com/keyed',
              auth: { scheme, secretRef: 'KEYED_SECRET' },
            },
          ],
        }),
      );
      expect(verdictAt(result, `${ROOT}.tools.0`).note).toContain(`scheme ${scheme}`);
      expect(versionOf(result).definition.tools?.[0]).toMatchObject({
        project_connection_id: 'aw-keyed',
      });
      const plan = planOf(result);
      expect(plan.connections).toContainEqual({
        name: 'aw-keyed',
        kind: 'mcp',
        target: 'https://mcp.example.com/keyed',
        auth: { type: scheme, secretRef: 'KEYED_SECRET' },
      });
      expect(plan.notes.map((note) => note.id)).toContain('V6');
    },
  );

  it('plans an oauth2 tool endpoint credential the same way', () => {
    const project = parse({
      ...SAMPLE_PORTABLE_PROJECT,
      toolEndpoint: {
        url: 'https://aw.example.com/mcp/projects/acme-support',
        auth: { scheme: 'oauth2', secretRef: 'ACME_TOOL_ENDPOINT_TOKEN' },
      },
    });
    const result = compile(project);
    const plan = planOf(result);
    expect(plan.connections).toContainEqual(
      expect.objectContaining({
        name: 'aw-tools',
        auth: { type: 'oauth2', secretRef: 'ACME_TOOL_ENDPOINT_TOKEN' },
      }),
    );
    expect(verdictAt(result, 'toolEndpoint').note).toContain('scheme oauth2');
  });

  it('notes V5 only for an Anthropic model and V6 only when an MCP connection is planned', () => {
    const notesOf = (project: PortableProject) =>
      planOf(compile(project, {})).notes.map((note) => note.id);
    expect(notesOf(sample)).toEqual(['V5', 'V6']);
    const plain = parse({
      root: 'plain',
      agents: [
        {
          apiVersion: 'agentworkspace.dev/v1',
          kind: 'Agent',
          name: 'plain',
          instructions: 'Help.',
          model: { provider: 'openai', id: 'gpt-5-mini' },
          permissions: {
            readFiles: false,
            writeFiles: false,
            runCommands: false,
            unrestrictedNetwork: false,
          },
        },
      ],
    });
    expect(notesOf(plain)).toEqual([]);
  });
});
