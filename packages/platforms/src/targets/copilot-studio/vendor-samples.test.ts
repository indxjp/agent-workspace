import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import {
  agentDocument,
  childAgentDocument,
  mcpActionDocument,
  settingsDocument,
  urlKnowledgeDocument,
  type YamlDocument,
} from './vendor-shapes.js';

// Pins every VERIFY builder to Microsoft's own samples, committed verbatim under
// `vendor-fixtures/microsoft-samples/` (repo, commit, blob SHAs and licence in its SOURCE.md:
// microsoft/skills-for-copilot-studio @ fd9653d0ec743b39443596d7132f907d0d993f1f, MIT).
// Each builder is run with every optional key on, and every key path it emits must exist in the
// paired sample, except the paths listed in `notInSample`. That list must stay exact: a builder
// key that drifts away from the sample fails, and so does a gap the sample later closes.
// The samples are pinned as they are; where they disagree with what we emit, the note says so and
// P3b (#970) decides against a real tenant clone. The translator is not changed here.

const SAMPLES = join(
  fileURLToPath(new URL('.', import.meta.url)),
  'vendor-fixtures',
  'microsoft-samples',
);

function sample(path: string): unknown {
  return parse(readFileSync(join(SAMPLES, path), 'utf8'));
}

/** Every key path in a parsed document; array items share one `[]` segment. */
function keyPaths(value: unknown, prefix = ''): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => keyPaths(item, `${prefix}[]`));
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) => {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    return [path, ...keyPaths(child, path)];
  });
}

/** Value at a key path, following the first item of an array. */
function valueAt(value: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (node, segment) =>
        segment.endsWith('[]')
          ? (node as Record<string, unknown[]>)[segment.slice(0, -2)]?.[0]
          : (node as Record<string, unknown> | undefined)?.[segment],
      value,
    );
}

interface Pairing {
  readonly builder: string;
  readonly sample: string;
  readonly emitted: YamlDocument;
  /** Emitted key paths the sample does not carry, each with why it is still emitted. */
  readonly notInSample: Readonly<Record<string, string>>;
}

const FULL_AGENT = agentDocument({
  name: 'support-triage',
  description: 'd',
  instructions: 'i',
  modelNameHint: 'm',
  webBrowsing: true,
  codeInterpreter: true,
  conversationStarters: [{ title: 't', text: 'x' }],
});

const FULL_ACTION = mcpActionDocument({
  name: 'zendesk',
  connectionReference: 'acme_supportTriage.mcp.zendesk',
  mode: 'Maker',
  toolNames: ['get_order'],
});

// #970: not in either agent sample. The schema (`reference/bot.schema.yaml-authoring.json`) has
// `GptComponentMetadata.gptCapabilities` with `webBrowsing` and `codeInterpreter`, so those are
// schema-confirmed; `mcs.metadata` is a file-level block the schema does not describe.
const AGENT_GAPS = {
  'mcs.metadata.description':
    'not in the agent samples; the CustomMCP action sample carries mcs.metadata.description (#970)',
  gptCapabilities: 'schema-confirmed (GptComponentMetadata.gptCapabilities), not in samples (#970)',
  'gptCapabilities.webBrowsing': 'schema-confirmed (GptCapabilities.webBrowsing) (#970)',
  'gptCapabilities.codeInterpreter': 'schema-confirmed (GptCapabilities.codeInterpreter) (#970)',
};

// #970: the schema has `ModelContextProtocolMetadata.tools` and `UseSpecificTools {kind, tools}`;
// neither MCP action sample limits the tools.
const TOOLS_GAPS = {
  'action.operationDetails.tools': 'schema-confirmed (ModelContextProtocolMetadata.tools) (#970)',
  'action.operationDetails.tools.kind': 'schema-confirmed (UseSpecificTools.kind) (#970)',
  'action.operationDetails.tools.tools': 'schema-confirmed (UseSpecificTools.tools) (#970)',
};

const PAIRINGS: readonly Pairing[] = [
  {
    builder: 'agentDocument',
    sample: 'templates/agents/agent.mcs.yml',
    emitted: FULL_AGENT,
    notInSample: AGENT_GAPS,
  },
  {
    builder: 'agentDocument',
    sample: 'evals/fixtures/agent-with-mcp-action/agent.mcs.yml',
    emitted: FULL_AGENT,
    notInSample: AGENT_GAPS,
  },
  {
    builder: 'settingsDocument',
    sample: 'evals/fixtures/agent-with-mcp-action/settings.mcs.yml',
    emitted: settingsDocument({
      name: 'support-triage',
      schemaName: 'acme_supportTriage',
      language: 1033,
    }),
    notInSample: {},
  },
  {
    builder: 'mcpActionDocument',
    sample: 'evals/fixtures/agent-with-mcp-action/actions/CustomMCP.mcs.yml',
    emitted: FULL_ACTION,
    notInSample: TOOLS_GAPS,
  },
  {
    builder: 'mcpActionDocument',
    sample: 'templates/actions/mcp-action.mcs.yml',
    emitted: FULL_ACTION,
    notInSample: {
      // The template names the action in `# Name:` / `# Description:` comments; the filled
      // CustomMCP sample uses this block.
      'mcs.metadata': 'template uses comments; CustomMCP sample confirms it',
      'mcs.metadata.componentName': 'template uses comments; CustomMCP sample confirms it',
      'mcs.metadata.description': 'template uses comments; CustomMCP sample confirms it',
      ...TOOLS_GAPS,
    },
  },
  {
    builder: 'childAgentDocument',
    sample: 'templates/agents/child-agent.mcs.yml',
    emitted: childAgentDocument({
      name: 'billing-specialist',
      description: 'd',
      instructions: 'i',
    }),
    notInSample: {
      // CONTRADICTION (#970): the child-agent template has no `mcs.metadata` block; it names the
      // agent only in `# Name:` comments. We still emit `mcs.metadata.componentName` (the importer
      // does not read it); P3b decides from a tenant clone.
      'mcs.metadata': 'child sample has no mcs.metadata block (#970)',
      'mcs.metadata.componentName': 'child sample has no mcs.metadata block (#970)',
    },
  },
  {
    builder: 'urlKnowledgeDocument',
    sample: 'templates/knowledge/public-website.knowledge.mcs.yml',
    emitted: urlKnowledgeDocument('https://help.example.com'),
    notInSample: {},
  },
];

describe('vendor shapes against the Microsoft samples', () => {
  it.each(PAIRINGS)(
    '$builder emits only key paths found in $sample',
    ({ sample: path, emitted, notInSample }) => {
      const sampleKeys = new Set(keyPaths(sample(path)));
      const missing = keyPaths(emitted).filter((key) => !sampleKeys.has(key));
      expect(missing.sort()).toEqual(Object.keys(notInSample).sort());
    },
  );

  it.each(PAIRINGS)(
    '$builder uses the same discriminator values as $sample',
    ({ sample: path, emitted }) => {
      const parsed = sample(path);
      const kinds = keyPaths(emitted).filter(
        (key) => key.endsWith('kind') && valueAt(parsed, key) !== undefined,
      );
      expect(kinds.length).toBeGreaterThan(0);
      for (const key of kinds)
        expect([key, valueAt(emitted, key)]).toEqual([key, valueAt(parsed, key)]);
    },
  );

  it('matches the filled MCP action sample value for value where both are fixed', () => {
    const parsed = sample('evals/fixtures/agent-with-mcp-action/actions/CustomMCP.mcs.yml');
    for (const key of ['action.connectionProperties.mode', 'action.operationDetails.operationId'])
      expect([key, valueAt(FULL_ACTION, key)]).toEqual([key, valueAt(parsed, key)]);
  });

  it('pins where the settings sample differs from what we emit', () => {
    const parsed = sample('evals/fixtures/agent-with-mcp-action/settings.mcs.yml');
    const emitted = settingsDocument({ name: 'a', schemaName: 'p_a', language: 1033 });
    for (const key of ['accessControlPolicy', 'authenticationMode', 'language'])
      expect([key, valueAt(emitted, key)]).toEqual([key, valueAt(parsed, key)]);
    // CONTRADICTION (#970): the eval sample has generative actions off; we emit `true` because
    // this target is a generative-orchestration agent. P3b confirms the key's meaning.
    const generative = 'configuration.settings.GenerativeActionsEnabled';
    expect(valueAt(parsed, generative)).toBe(false);
    expect(valueAt(emitted, generative)).toBe(true);
  });
});
