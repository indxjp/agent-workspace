import { z } from 'zod';

/** The Foundry Agent Service REST version every emitted body is written for. */
export const FOUNDRY_API_VERSION = 'v1';

/** Vendor rule: starts and ends alphanumeric, hyphens inside, at most 63 characters. */
export const FOUNDRY_AGENT_NAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u;

const CONNECTION_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/u;
const METADATA_MAX_PAIRS = 16;
const METADATA_KEY_MAX = 64;
const METADATA_VALUE_MAX = 512;

/** `extensions.platforms['microsoft-foundry']`. */
export const FoundryOptionsSchema = z
  .object({
    /** The Foundry model deployment used as `definition.model`. Absent: the agent's model id. */
    modelDeployment: z.string().min(1).max(256).optional(),
    /** `require_approval` of every emitted MCP tool; the vendor default is `always`. */
    requireApproval: z.enum(['always', 'never']).default('always'),
    /** Project-connection name per tool or subagent name. */
    connections: z.record(z.string(), z.string().regex(CONNECTION_NAME_PATTERN)).optional(),
    /** An existing vector store id per agent name; one store per agent is the vendor limit. */
    vectorStores: z.record(z.string(), z.string().min(1)).optional(),
    /** Read by `aw platforms publish` only (the project API root, https); the compiler ignores it. */
    projectEndpoint: z
      .url()
      .refine(
        (endpoint) => {
          const url = new URL(endpoint);
          return url.protocol === 'https:' && url.search === '' && url.hash === '';
        },
        { message: 'must be an https URL without a query or fragment' },
      )
      .optional(),
  })
  .strict();
export type FoundryOptions = z.infer<typeof FoundryOptionsSchema>;

const McpToolSchema = z
  .object({
    type: z.literal('mcp'),
    server_label: z.string().min(1),
    server_url: z.string().min(1),
    require_approval: z.enum(['always', 'never']),
    allowed_tools: z.array(z.string().min(1)).min(1).optional(),
    project_connection_id: z.string().regex(CONNECTION_NAME_PATTERN).optional(),
  })
  .strict();

const OpenApiToolSchema = z
  .object({
    type: z.literal('openapi'),
    openapi: z
      .object({
        name: z.string().min(1),
        spec: z.record(z.string(), z.unknown()),
        auth: z.discriminatedUnion('type', [
          z.object({ type: z.literal('anonymous') }).strict(),
          z
            .object({
              type: z.literal('connection'),
              security_scheme: z
                .object({ project_connection_id: z.string().regex(CONNECTION_NAME_PATTERN) })
                .strict(),
            })
            .strict(),
        ]),
      })
      .strict(),
  })
  .strict();

const FoundryToolSchema = z.discriminatedUnion('type', [
  McpToolSchema,
  OpenApiToolSchema,
  z.object({ type: z.literal('web_search') }).strict(),
  z
    .object({
      type: z.literal('code_interpreter'),
      container: z.object({ type: z.literal('auto') }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('file_search'),
      vector_store_ids: z.array(z.string().min(1)).length(1),
    })
    .strict(),
  z
    .object({
      type: z.literal('a2a'),
      a2a_version: z.literal('1.0'),
      project_connection_id: z.string().regex(CONNECTION_NAME_PATTERN),
    })
    .strict(),
]);
export type FoundryTool = z.infer<typeof FoundryToolSchema>;

/** The body of `POST {projectEndpoint}/agents/{name}/versions?api-version=v1`. */
export const FoundryAgentVersionBodySchema = z
  .object({
    description: z.string().min(1).optional(),
    metadata: z
      .record(z.string().max(METADATA_KEY_MAX), z.string().max(METADATA_VALUE_MAX))
      .refine((metadata) => Object.keys(metadata).length <= METADATA_MAX_PAIRS, {
        message: `at most ${METADATA_MAX_PAIRS} pairs`,
      }),
    definition: z
      .object({
        kind: z.literal('prompt'),
        model: z.string().min(1),
        instructions: z.string(),
        tools: z
          .array(FoundryToolSchema)
          .min(1)
          .superRefine((tools, context) => {
            const labels = new Set<string>();
            tools.forEach((tool, index) => {
              if (tool.type !== 'mcp') return;
              if (labels.has(tool.server_label)) {
                context.addIssue({
                  code: 'custom',
                  message: `server_label ${tool.server_label} is not unique`,
                  path: [index, 'server_label'],
                });
              }
              labels.add(tool.server_label);
            });
          })
          .optional(),
      })
      .strict(),
  })
  .strict();
export type FoundryAgentVersionBody = z.infer<typeof FoundryAgentVersionBodySchema>;

/** The body of `PATCH {projectEndpoint}/agents/{name}?api-version=v1` that turns on incoming A2A. */
export const FoundryEndpointPatchSchema = z
  .object({
    agent_card: z
      .object({
        description: z.string().min(1),
        version: z.string().min(1),
        skills: z.array(
          z
            .object({
              id: z.string().min(1),
              name: z.string().min(1),
              description: z.string().min(1),
            })
            .strict(),
        ),
      })
      .strict(),
    agent_endpoint: z
      .object({
        protocol_configuration: z
          .object({ responses: z.object({}).strict(), a2a: z.object({}).strict() })
          .strict(),
      })
      .strict(),
  })
  .strict();
export type FoundryEndpointPatch = z.infer<typeof FoundryEndpointPatchSchema>;

const FoundryConnectionSchema = z.discriminatedUnion('kind', [
  z
    .object({
      name: z.string().regex(CONNECTION_NAME_PATTERN),
      kind: z.literal('mcp'),
      target: z.string().min(1),
      auth: z.discriminatedUnion('type', [
        z
          .object({
            type: z.literal('custom-keys'),
            header: z.string().min(1),
            valuePrefix: z.string(),
            secretRef: z.string().min(1),
          })
          .strict(),
        z.object({ type: z.literal('api-key'), secretRef: z.string().min(1) }).strict(),
        z.object({ type: z.literal('oauth2'), secretRef: z.string().min(1) }).strict(),
      ]),
    })
    .strict(),
  z
    .object({
      name: z.string().regex(CONNECTION_NAME_PATTERN),
      kind: z.literal('a2a'),
      targetPath: z.string().min(1),
      auth: z.object({ type: z.literal('agentic-identity'), audience: z.string().min(1) }).strict(),
    })
    .strict(),
]);
export type FoundryConnection = z.infer<typeof FoundryConnectionSchema>;

/**
 * The neutral publish plan the publish step carries out (it holds secret names, never values): create
 * the connections, then per `agents[]` entry in order POST the version and PATCH the endpoint.
 * `openapiSpecs` lists every `{"$ref"}` spec the publish step must inline before the POST. `notes`
 * carry the unconfirmed vendor facts (V5, V6) the publish step has to settle.
 */
export const FoundryPublishPlanSchema = z
  .object({
    platform: z.literal('microsoft-foundry'),
    foundryApiVersion: z.literal(FOUNDRY_API_VERSION),
    root: z.string().min(1),
    connections: z.array(FoundryConnectionSchema),
    agents: z.array(
      z
        .object({
          name: z.string().regex(FOUNDRY_AGENT_NAME_PATTERN),
          version: z.string().min(1),
          endpoint: z.string().min(1).optional(),
        })
        .strict(),
    ),
    openapiSpecs: z.array(
      z
        .object({ agent: z.string().min(1), tool: z.string().min(1), specRef: z.string().min(1) })
        .strict(),
    ),
    notes: z.array(
      z
        .object({
          id: z.enum(['V5', 'V6']),
          note: z.string().min(1),
          source: z.url(),
        })
        .strict(),
    ),
  })
  .strict();
export type FoundryPublishPlan = z.infer<typeof FoundryPublishPlanSchema>;

/**
 * What the importer reads of a vendor agent version: the emitted shape or a `GET .../versions/{v}`
 * response. Loose, because the protocol is external and extensible; the importer drops what it
 * does not know instead of refusing it.
 */
export const FoundryAgentVersionImportSchema = z.looseObject({
  name: z.string().optional(),
  description: z.string().nullish(),
  metadata: z.record(z.string(), z.unknown()).nullish(),
  definition: z.looseObject({
    kind: z.string(),
    model: z.string().min(1),
    instructions: z.string().nullish(),
    tools: z.array(z.looseObject({ type: z.string() })).nullish(),
  }),
});
export type FoundryAgentVersionImport = z.infer<typeof FoundryAgentVersionImportSchema>;

/** The fields the importer reads of each tool type it maps; the rest of the tool is ignored. */
export const FOUNDRY_IMPORT_TOOL_SCHEMAS = {
  mcp: z.looseObject({
    server_label: z.string().min(1),
    server_url: z.string().min(1),
    project_connection_id: z.string().optional(),
  }),
  openapi: z.looseObject({
    openapi: z.looseObject({ name: z.string().min(1), spec: z.record(z.string(), z.unknown()) }),
  }),
  file_search: z.looseObject({
    vector_store_ids: z.array(z.string()).optional(),
    file_search: z.looseObject({ vector_store_ids: z.array(z.string()).optional() }).optional(),
  }),
  a2a: z.looseObject({ project_connection_id: z.string().optional() }),
} as const;
