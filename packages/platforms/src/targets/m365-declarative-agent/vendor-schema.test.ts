import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  APP_MANIFEST_SCHEMA_URL,
  AppManifestSchema,
  DECLARATIVE_AGENT_SCHEMA_URL,
  DeclarativeAgentManifestV18Schema,
  ImportedAppManifestSchema,
  ImportedDeclarativeAgentSchema,
  ImportedPluginSchema,
  PluginManifestV24Schema,
} from './vendor-schema.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__');

const agent = {
  $schema: DECLARATIVE_AGENT_SCHEMA_URL,
  version: 'v1.8',
  name: 'Support',
  description: 'Helps.',
  instructions: 'Be helpful.',
};
const plugin = {
  schema_version: 'v2.4',
  name_for_human: 'zendesk',
  namespace: 'zendesk',
  description_for_human: 'Tools from the zendesk MCP server.',
  functions: [],
  runtimes: [
    {
      type: 'RemoteMCPServer',
      auth: { type: 'None' },
      run_for_functions: ['*'],
      spec: { url: 'https://mcp.example.com/zendesk' },
    },
  ],
};
const app = {
  $schema: APP_MANIFEST_SCHEMA_URL,
  manifestVersion: '1.24',
  version: '1.0.0',
  id: '${{TEAMS_APP_ID}}',
  developer: { name: 'a', websiteUrl: 'b', privacyUrl: 'c', termsOfUseUrl: 'd' },
  name: { short: 'Support', full: 'Support' },
  description: { short: 'Helps.', full: 'Helps.' },
  icons: { color: 'color.png', outline: 'outline.png' },
  accentColor: '#5B5FC7',
  copilotAgents: { declarativeAgents: [{ id: 'declarativeAgent', file: 'declarativeAgent.json' }] },
};

describe('vendor schemas', () => {
  it.each([
    ['declarative agent', DeclarativeAgentManifestV18Schema, agent],
    ['plugin', PluginManifestV24Schema, plugin],
    ['app manifest', AppManifestSchema, app],
  ])('accept a minimal %s and reject an extra property', (_, schema, value) => {
    expect(schema.safeParse(value).success).toBe(true);
    expect(schema.safeParse({ ...value, foo: 1 }).success).toBe(false);
  });

  it('rejects two capabilities of one type and more than ten actions', () => {
    const twice = [{ name: 'CodeInterpreter' }, { name: 'CodeInterpreter' }];
    expect(
      DeclarativeAgentManifestV18Schema.safeParse({ ...agent, capabilities: twice }).success,
    ).toBe(false);
    const actions = Array.from({ length: 11 }, (_, index) => ({ id: `a${index}`, file: 'f.json' }));
    expect(DeclarativeAgentManifestV18Schema.safeParse({ ...agent, actions }).success).toBe(false);
  });

  describe('against the vendor fixtures', () => {
    const fixture = (path: string): unknown =>
      JSON.parse(readFileSync(join(fixtures, path), 'utf8'));
    const learnAgent = fixture('learn-declarative-agent-v1.8.json');
    const atkAgent = fixture('atk-new-declarative-agent/appPackage/declarativeAgent.json');
    const atkApp = fixture('atk-new-declarative-agent/appPackage/manifest.json');

    it('accepts the Learn plugin example as a strict v2.4 plugin', () => {
      expect(
        PluginManifestV24Schema.safeParse(fixture('learn-plugin-v2.4-mcp-dynamic.json')).success,
      ).toBe(true);
    });

    it('accepts the atk new agent as a strict v1.8 agent, and the Learn example only loosely', () => {
      expect(DeclarativeAgentManifestV18Schema.safeParse(atkAgent).success).toBe(true);
      expect(DeclarativeAgentManifestV18Schema.safeParse(learnAgent).success).toBe(false);
      expect(ImportedDeclarativeAgentSchema.safeParse(learnAgent).success).toBe(true);
      expect(ImportedDeclarativeAgentSchema.safeParse(atkAgent).success).toBe(true);
    });

    it('reads the atk new app manifest (1.30) loosely though the strict schema is 1.24', () => {
      expect(AppManifestSchema.safeParse(atkApp).success).toBe(false);
      expect(ImportedAppManifestSchema.safeParse(atkApp).success).toBe(true);
    });

    it('rejects a key of the wrong type in the tolerant schemas', () => {
      expect(
        ImportedDeclarativeAgentSchema.safeParse({ ...agent, actions: [{ id: 1, file: 'f' }] })
          .success,
      ).toBe(false);
      expect(ImportedPluginSchema.safeParse({ runtimes: [{ type: 1 }] }).success).toBe(false);
    });
  });
});
