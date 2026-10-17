/**
 * The only module that knows the Copilot Studio workspace YAML shapes. Every shape here is VERIFY:
 * it comes from Microsoft's own samples, not from a Learn page. Samples:
 * https://github.com/microsoft/skills-for-copilot-studio @ fd9653d0ec743b39443596d7132f907d0d993f1f
 * (`templates/**`, `evals/fixtures/**`, `reference/bot.schema.yaml-authoring.json`). The samples
 * each builder copies are committed verbatim in `vendor-fixtures/microsoft-samples/` (see its
 * SOURCE.md), and `vendor-samples.test.ts` pins every emitted key path to them. "Sample-confirmed"
 * below means that test proves the key exists in the sample; it is still not tenant-verified.
 * P3b (#970) verifies each builder against a real tenant clone; it changes this file, the goldens
 * and the mapping notes only. Key order is the order of the object literal, and the YAML writer
 * keeps it, so the goldens are stable.
 */

import { z } from 'zod';

export type YamlDocument = Readonly<Record<string, unknown>>;

export const CHILD_AGENT_KIND = 'AgentDialog';
export const URL_KNOWLEDGE_KIND = 'KnowledgeSourceConfiguration';
export const URL_KNOWLEDGE_SOURCE_KIND = 'PublicSiteSearchSource';
export const MCP_METADATA_KIND = 'ModelContextProtocolMetadata';

export interface AgentDocumentInput {
  readonly name: string;
  readonly description: string | undefined;
  readonly instructions: string;
  readonly modelNameHint: string | undefined;
  readonly webBrowsing: boolean;
  readonly codeInterpreter: boolean;
  readonly conversationStarters:
    readonly { readonly title: string; readonly text: string }[] | undefined;
}

/**
 * `agent/agent.mcs.yml`, `kind: GptComponentMetadata`. Sample: `templates/agents/agent.mcs.yml`.
 * Sample-confirmed: `mcs.metadata.componentName`, `kind`, `displayName`, `instructions`,
 * `aISettings.model.modelNameHint`, `conversationStarters[].{title,text}`.
 * VERIFY: `mcs.metadata.description` (in neither agent sample; the CustomMCP action sample has it),
 * `gptCapabilities.{webBrowsing,codeInterpreter}` (in the schema, not in the samples).
 */
export function agentDocument(input: AgentDocumentInput): YamlDocument {
  return {
    'mcs.metadata': {
      componentName: input.name,
      ...(input.description === undefined ? {} : { description: input.description }),
    },
    kind: 'GptComponentMetadata',
    displayName: input.name,
    instructions: input.instructions,
    ...(input.modelNameHint === undefined
      ? {}
      : { aISettings: { model: { modelNameHint: input.modelNameHint } } }),
    ...(input.webBrowsing || input.codeInterpreter
      ? {
          gptCapabilities: {
            ...(input.webBrowsing ? { webBrowsing: true } : {}),
            ...(input.codeInterpreter ? { codeInterpreter: true } : {}),
          },
        }
      : {}),
    ...(input.conversationStarters === undefined
      ? {}
      : {
          conversationStarters: input.conversationStarters.map(({ title, text }) => ({
            title,
            text,
          })),
        }),
  };
}

export interface SettingsDocumentInput {
  readonly name: string;
  readonly schemaName: string;
  readonly language: number;
}

/**
 * `agent/settings.mcs.yml` with generative orchestration on. Sample:
 * `evals/fixtures/agent-with-mcp-action/settings.mcs.yml`.
 * Sample-confirmed: every key, `accessControlPolicy: ChatbotReaders`, `authenticationMode: None`,
 * `recognizer.kind: GenerativeAIRecognizer`, `language`.
 * VERIFY: the value of `GenerativeActionsEnabled` (the sample has `false`; we emit `true`).
 */
export function settingsDocument(input: SettingsDocumentInput): YamlDocument {
  return {
    displayName: input.name,
    schemaName: input.schemaName,
    accessControlPolicy: 'ChatbotReaders',
    authenticationMode: 'None',
    configuration: {
      settings: { GenerativeActionsEnabled: true },
      recognizer: { kind: 'GenerativeAIRecognizer' },
    },
    language: input.language,
  };
}

export interface McpActionDocumentInput {
  readonly name: string;
  readonly connectionReference: string;
  readonly mode: 'Maker' | 'Invoker';
  /** When set, the action is limited to these tools of the server (`UseSpecificTools`). */
  readonly toolNames: readonly string[] | undefined;
}

/**
 * `agent/actions/<name>.mcs.yml`: a `TaskDialog` invoking one MCP server through its custom
 * connector. Sample: `templates/actions/mcp-action.mcs.yml` and
 * `evals/fixtures/agent-with-mcp-action/actions/CustomMCP.mcs.yml`.
 * Sample-confirmed: `mcs.metadata.{componentName,description}`, `TaskDialog`, `modelDisplayName`,
 * `modelDescription`, `InvokeExternalAgentTaskAction`, `connectionReference`,
 * `connectionProperties.mode: Maker`, `ModelContextProtocolMetadata`, `operationId: InvokeMCP`.
 * VERIFY: `tools.kind: UseSpecificTools` (schema `ToolsSelectionMode`, not in the samples) and the
 * connection reference name (the sample's is `<prefix>_<bot>.shared_<connector>.<id>`).
 */
export function mcpActionDocument(input: McpActionDocumentInput): YamlDocument {
  return {
    'mcs.metadata': {
      componentName: input.name,
      description: `MCP server ${input.name}`,
    },
    kind: 'TaskDialog',
    modelDisplayName: input.name,
    modelDescription: `Tools from the ${input.name} MCP server`,
    action: {
      kind: 'InvokeExternalAgentTaskAction',
      connectionReference: input.connectionReference,
      connectionProperties: { mode: input.mode },
      operationDetails: {
        kind: MCP_METADATA_KIND,
        operationId: 'InvokeMCP',
        ...(input.toolNames === undefined
          ? {}
          : { tools: { kind: 'UseSpecificTools', tools: [...input.toolNames] } }),
      },
    },
  };
}

export interface ChildAgentDocumentInput {
  readonly name: string;
  readonly description: string | undefined;
  readonly instructions: string;
}

/**
 * `agent/agents/<name>/agent.mcs.yml`: a child agent, `kind: AgentDialog`. Sample:
 * `templates/agents/child-agent.mcs.yml`.
 * Sample-confirmed: `AgentDialog`, `beginDialog.{kind: OnToolSelected, id: main, description}`,
 * `settings.instructions`, `inputType` / `outputType` (the sample says `{}` when unused).
 * VERIFY: the location, and `mcs.metadata.componentName`, which the sample does not have (it names
 * the child in comments only).
 */
export function childAgentDocument(input: ChildAgentDocumentInput): YamlDocument {
  return {
    'mcs.metadata': { componentName: input.name },
    kind: CHILD_AGENT_KIND,
    beginDialog: {
      kind: 'OnToolSelected',
      id: 'main',
      ...(input.description === undefined ? {} : { description: input.description }),
    },
    settings: { instructions: input.instructions },
    inputType: {},
    outputType: {},
  };
}

/**
 * `agent/knowledge/<slug>.knowledge.mcs.yml`: a public-website knowledge source. Sample:
 * `templates/knowledge/public-website.knowledge.mcs.yml`.
 * Sample-confirmed: `KnowledgeSourceConfiguration`, `source.{kind: PublicSiteSearchSource, site}`.
 * VERIFY: the location and file name.
 */
export function urlKnowledgeDocument(url: string): YamlDocument {
  return {
    kind: URL_KNOWLEDGE_KIND,
    source: { kind: URL_KNOWLEDGE_SOURCE_KIND, site: url },
  };
}

/*
 * Readers for the same shapes, used by the importer. They are loose on purpose: a cloned workspace
 * carries many keys this target never writes, and the importer reads only the keys named here.
 */

const text = z.string();

export const AgentFileSchema = z.looseObject({
  displayName: text,
  instructions: text.optional(),
  'mcs.metadata': z.looseObject({ description: text.optional() }).optional(),
  aISettings: z
    .looseObject({ model: z.looseObject({ modelNameHint: text.optional() }).optional() })
    .optional(),
  gptCapabilities: z
    .looseObject({ webBrowsing: z.boolean().optional(), codeInterpreter: z.boolean().optional() })
    .optional(),
});

export const SettingsFileSchema = z.looseObject({ schemaName: text.optional() });

export const ChildAgentFileSchema = z.looseObject({
  kind: text.optional(),
  beginDialog: z.looseObject({ description: text.optional() }).optional(),
  settings: z.looseObject({ instructions: text.optional() }).optional(),
});

export const UrlKnowledgeFileSchema = z.looseObject({
  kind: text.optional(),
  source: z.looseObject({ kind: text.optional(), site: text.optional() }).optional(),
});

export const ActionFileSchema = z.looseObject({
  action: z
    .looseObject({ operationDetails: z.looseObject({ kind: text.optional() }).optional() })
    .optional(),
});
