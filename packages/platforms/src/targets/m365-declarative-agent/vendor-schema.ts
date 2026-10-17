import { z } from 'zod';

/**
 * The Microsoft 365 documents this target writes, as strict schemas. Microsoft rejects "unrecognized
 * or extraneous properties in any JSON object", so every object here is strict and a test validates
 * each emitted document against them. They describe the subset this target emits, not the whole
 * vendor schema.
 */
export const DECLARATIVE_AGENT_SCHEMA_URL =
  'https://developer.microsoft.com/json-schemas/copilot/declarative-agent/v1.8/schema.json';
export const PLUGIN_SCHEMA_URL =
  'https://developer.microsoft.com/json-schemas/copilot/plugin/v2.4/schema.json';
export const APP_MANIFEST_SCHEMA_URL =
  'https://developer.microsoft.com/json-schemas/teams/v1.24/MicrosoftTeams.schema.json';

const NonEmpty = z.string().min(1);

const WebSearchCapabilitySchema = z.strictObject({
  name: z.literal('WebSearch'),
  sites: z
    .array(z.strictObject({ url: NonEmpty }))
    .min(1)
    .max(4)
    .optional(),
});
const CodeInterpreterCapabilitySchema = z.strictObject({ name: z.literal('CodeInterpreter') });

/** Declarative agent manifest v1.8, https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/declarative-agent-manifest-1.8 */
export const DeclarativeAgentManifestV18Schema = z.strictObject({
  $schema: z.literal(DECLARATIVE_AGENT_SCHEMA_URL),
  version: z.literal('v1.8'),
  name: z
    .string()
    .min(1)
    .max(100)
    .refine((value) => value.trim() !== '', 'must have a non-whitespace character'),
  description: z.string().min(1).max(1_000),
  instructions: z.string().min(1).max(8_000),
  capabilities: z
    .array(
      z.discriminatedUnion('name', [WebSearchCapabilitySchema, CodeInterpreterCapabilitySchema]),
    )
    .max(2)
    .refine(
      (capabilities) => new Set(capabilities.map(({ name }) => name)).size === capabilities.length,
      'takes at most one capability of each type',
    )
    .optional(),
  conversation_starters: z
    .array(z.strictObject({ title: NonEmpty.optional(), text: NonEmpty }))
    .max(12)
    .optional(),
  actions: z
    .array(z.strictObject({ id: NonEmpty, file: NonEmpty }))
    .min(1)
    .max(10)
    .optional(),
  behavior_overrides: z
    .strictObject({
      default_response_mode: z.enum(['Auto', 'Quick response', 'Think deeper']).optional(),
      special_instructions: z.strictObject({ discourage_model_knowledge: z.boolean() }).optional(),
    })
    .optional(),
  disclaimer: z.strictObject({ text: NonEmpty.max(500) }).optional(),
});
export type DeclarativeAgentManifestV18 = z.infer<typeof DeclarativeAgentManifestV18Schema>;

const PluginAuthSchema = z.strictObject({
  type: z.enum(['None', 'OAuthPluginVault', 'ApiKeyPluginVault']),
  reference_id: NonEmpty.optional(),
});

const PluginRuntimeSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('RemoteMCPServer'),
    auth: PluginAuthSchema,
    run_for_functions: z.array(NonEmpty).min(1).optional(),
    spec: z.strictObject({ url: NonEmpty }),
  }),
  z.strictObject({
    type: z.literal('OpenApi'),
    auth: PluginAuthSchema,
    run_for_functions: z.array(NonEmpty).min(1).optional(),
    spec: z.strictObject({ url: NonEmpty }),
  }),
]);

/** API plugin manifest v2.4, https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/plugin-manifest-2.4 */
export const PluginManifestV24Schema = z.strictObject({
  $schema: z.literal(PLUGIN_SCHEMA_URL).optional(),
  schema_version: z.literal('v2.4'),
  name_for_human: NonEmpty,
  namespace: z.string().regex(/^[A-Za-z0-9]+$/u),
  description_for_human: NonEmpty,
  description_for_model: NonEmpty.optional(),
  /** Only the empty list: tools are discovered from the MCP server or inferred from the OpenAPI document. */
  functions: z.tuple([]).optional(),
  runtimes: z.array(PluginRuntimeSchema).min(1),
});
export type PluginManifestV24 = z.infer<typeof PluginManifestV24Schema>;

/** The Teams app manifest v1.24 fields this target writes, https://learn.microsoft.com/en-us/microsoft-365/extensibility/schema/root */
export const AppManifestSchema = z.strictObject({
  $schema: z.literal(APP_MANIFEST_SCHEMA_URL),
  manifestVersion: z.literal('1.24'),
  version: z.string().regex(/^\d+\.\d+\.\d+$/u),
  id: NonEmpty,
  developer: z.strictObject({
    name: NonEmpty.max(32),
    websiteUrl: NonEmpty,
    privacyUrl: NonEmpty,
    termsOfUseUrl: NonEmpty,
  }),
  name: z.strictObject({ short: NonEmpty.max(30), full: NonEmpty.max(100) }),
  description: z.strictObject({ short: NonEmpty.max(80), full: NonEmpty.max(4_000) }),
  icons: z.strictObject({ color: NonEmpty, outline: NonEmpty }),
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/u),
  copilotAgents: z.strictObject({
    declarativeAgents: z.tuple([z.strictObject({ id: NonEmpty, file: NonEmpty })]),
  }),
});
export type AppManifest = z.infer<typeof AppManifestSchema>;

/**
 * What the importer reads, as tolerant schemas: Microsoft's schemas grow (the Agents Toolkit already
 * writes app manifest 1.30 and a newer agent version), so an unknown key is not an error here. A key
 * that is present with the wrong type is.
 */
export const ImportedDeclarativeAgentSchema = z.looseObject({
  name: NonEmpty,
  description: z.string().optional(),
  instructions: NonEmpty,
  capabilities: z
    .array(
      z.looseObject({
        name: NonEmpty,
        sites: z.array(z.looseObject({ url: NonEmpty })).optional(),
        files: z.array(z.looseObject({ file: NonEmpty })).optional(),
      }),
    )
    .optional(),
  conversation_starters: z
    .array(z.looseObject({ title: NonEmpty.optional(), text: NonEmpty }))
    .optional(),
  actions: z.array(z.looseObject({ id: NonEmpty, file: NonEmpty })).optional(),
  behavior_overrides: z
    .looseObject({
      default_response_mode: z.string().optional(),
      special_instructions: z
        .looseObject({ discourage_model_knowledge: z.boolean().optional() })
        .optional(),
    })
    .optional(),
  disclaimer: z.looseObject({ text: NonEmpty }).optional(),
});
export type ImportedDeclarativeAgent = z.infer<typeof ImportedDeclarativeAgentSchema>;

export const ImportedPluginSchema = z.looseObject({
  runtimes: z
    .array(
      z.looseObject({
        type: NonEmpty,
        auth: z.looseObject({ type: NonEmpty }).optional(),
        spec: z.looseObject({ url: NonEmpty.optional() }).optional(),
      }),
    )
    .optional(),
});

export const ImportedAppManifestSchema = z.looseObject({
  version: z.string().optional(),
  accentColor: z.string().optional(),
  developer: z
    .looseObject({
      name: z.string().optional(),
      websiteUrl: z.string().optional(),
      privacyUrl: z.string().optional(),
      termsOfUseUrl: z.string().optional(),
    })
    .optional(),
  copilotAgents: z
    .looseObject({
      declarativeAgents: z.array(z.looseObject({ file: NonEmpty })).optional(),
    })
    .optional(),
});
