import { z } from 'zod';

import {
  AGENT_DEFINITION_API_VERSION,
  AGENT_INSTRUCTIONS_MAX_LENGTH,
  AGENT_MODEL_MAX_LENGTH,
  AgentPermissionsSchema,
} from './agents.js';
import { EngineIdSchema } from './engines.js';
import { PlatformIdSchema } from './platform-ids.js';
import { NAME_KEY_PATTERN, ProjectHttpUrlSchema } from './project-file.js';
import { MODEL_PROVIDERS } from './runs.js';
import { SecretNameSchema } from './secret-reference.js';
import { SKILL_MD_FILENAME } from './skills.js';
import { ToolOperationNameSchema } from './tool-connectors.js';
import { urlCarriesCredential } from './url-credential.js';

/**
 * The portable agent (ADR-0133 D2): one agent as an external agent host describes it, and the
 * project that carries it (`agents/<name>.agent.md` plus the files it references). The order of the
 * keys in each object is the canonical order of the file; `@indx-workspace/sdk/portable` writes
 * them in this order.
 */
export const PORTABLE_AGENT_API_VERSION = AGENT_DEFINITION_API_VERSION;
export const PORTABLE_AGENT_KIND = 'Agent';
export const PORTABLE_AGENT_DESCRIPTION_MAX_LENGTH = 1_024;
/** The longest list an agent carries: tools, knowledge entries, skills, and paths per entry. */
export const PORTABLE_AGENT_LIST_MAX = 128;
/** Claude Managed Agents' predefined-agent ceiling. */
export const PORTABLE_AGENT_SUBAGENTS_MAX = 20;
/** A root agent and its {@link PORTABLE_AGENT_SUBAGENTS_MAX} subagents. */
export const PORTABLE_PROJECT_AGENTS_MAX = 21;
export const PORTABLE_BUILTIN_TOOL_IDS = [
  'web_search',
  'web_fetch',
  'code_execution',
  'file_access',
] as const;
export const PORTABLE_MCP_TRANSPORTS = ['streamable-http', 'sse', 'stdio'] as const;
export const PORTABLE_MCP_AUTH_SCHEMES = ['bearer', 'api-key', 'oauth2'] as const;
export const PORTABLE_TOOL_ENDPOINT_AUTH_SCHEMES = ['bearer', 'oauth2'] as const;

const URL_MAX_LENGTH = 2_048;
const PATH_MAX_LENGTH = 1_024;

/** Agent, skill and subagent names: the project file's {@link NAME_KEY_PATTERN}. */
export const PortableNameSchema = z
  .string()
  .regex(NAME_KEY_PATTERN, 'must be lower-case kebab, 1-64 characters');

/** MCP server and OpenAPI tool names: 1-64 of `[A-Za-z0-9_-]`, starting alphanumeric. */
export const PortableToolNameSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u,
    'must be 1-64 letters, digits, "_" or "-", starting with a letter or digit',
  );

/**
 * A project-relative POSIX path: no leading `/`, no `\`, no `:`, no `.`, `..` or empty segment, no
 * control or format character, at most 1024 characters. Rejecting `:` and `\` keeps a Windows drive
 * or separator from making one path mean two places.
 */
export const PortableRelativePathSchema = z
  .string()
  .min(1)
  .max(PATH_MAX_LENGTH)
  .superRefine((value, context) => {
    const invalid =
      value.includes('\\') ||
      value.includes(':') ||
      /[\p{Cc}\p{Cf}]/u.test(value) ||
      value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..');
    if (invalid) {
      context.addIssue({ code: 'custom', message: 'must be a project-relative POSIX path' });
    }
  });

const CREDENTIAL_IN_URL_MESSAGE =
  'must not carry a credential; name it as a secret reference (secretRef)';

/** An `https:` URL with no credential in it, like {@link ProjectHttpUrlSchema} but https only. */
const PortableHttpsUrlSchema = z
  .url({ protocol: /^https$/u, error: 'must be an https:// URL', abort: true })
  .max(URL_MAX_LENGTH, { abort: true })
  .superRefine((value, context) => {
    if (URL.canParse(value) && urlCarriesCredential(new URL(value))) {
      context.addIssue({ code: 'custom', message: CREDENTIAL_IN_URL_MESSAGE });
    }
  });

/** A secret is named, never carried: `secretRef` is a name, and the value stays with the host. */
export const PortableSecretAuthSchema = z
  .object({
    scheme: z.enum(PORTABLE_MCP_AUTH_SCHEMES),
    secretRef: SecretNameSchema,
  })
  .strict()
  .readonly();

export const PortableModelSchema = z
  .object({
    provider: z.enum(MODEL_PROVIDERS).optional(),
    id: z.string().min(1).max(AGENT_MODEL_MAX_LENGTH),
  })
  .strict()
  .readonly();

const RemoteMcpTool = z
  .object({
    kind: z.literal('mcp'),
    name: PortableToolNameSchema,
    transport: z.enum(['streamable-http', 'sse']),
    url: ProjectHttpUrlSchema,
    auth: PortableSecretAuthSchema.optional(),
  })
  .strict()
  .readonly();

const StdioMcpTool = z
  .object({
    kind: z.literal('mcp'),
    name: PortableToolNameSchema,
    transport: z.literal('stdio'),
    command: z.string().min(1).max(1_024),
    args: z.array(z.string().max(4_096)).max(64).readonly().optional(),
  })
  .strict()
  .readonly();

export const PortableMcpToolSchema = z.discriminatedUnion('transport', [
  RemoteMcpTool,
  StdioMcpTool,
]);

export const PortableCodeToolSchema = z
  .object({
    kind: z.literal('code'),
    name: ToolOperationNameSchema,
    description: z.string().min(1).max(2_048),
    inputSchema: z.record(z.string(), z.unknown()).readonly(),
  })
  .strict()
  .readonly();

export const PortableOpenApiToolSchema = z
  .object({
    kind: z.literal('openapi'),
    name: PortableToolNameSchema,
    /** An https URL or a project-relative path to the OpenAPI document; its bytes travel in `PortableProject.openapiSpecs`. */
    specRef: z
      .string()
      .min(1)
      .max(URL_MAX_LENGTH)
      .refine(
        (value) =>
          PortableHttpsUrlSchema.safeParse(value).success ||
          PortableRelativePathSchema.safeParse(value).success,
        'must be an https URL with no credential, or a project-relative path',
      ),
    /** `GET <glob>` / `HEAD <glob>` / `operationId:<id>` rules. Absent: every operation the document declares. */
    allow: z
      .array(z.string().min(1).max(URL_MAX_LENGTH))
      .max(PORTABLE_AGENT_LIST_MAX)
      .readonly()
      .optional(),
    baseUrl: ProjectHttpUrlSchema.optional(),
    /** Absent header: `Authorization: Bearer`. */
    auth: z
      .object({ secretRef: SecretNameSchema, header: z.string().min(1).max(256).optional() })
      .strict()
      .readonly()
      .optional(),
  })
  .strict()
  .readonly();

export const PortableBuiltinToolSchema = z
  .object({ kind: z.literal('builtin'), id: z.enum(PORTABLE_BUILTIN_TOOL_IDS) })
  .strict()
  .readonly();

export const PortableToolSchema = z.discriminatedUnion('kind', [
  PortableMcpToolSchema,
  PortableCodeToolSchema,
  PortableOpenApiToolSchema,
  PortableBuiltinToolSchema,
]);

export const PortableKnowledgeFilesSchema = z
  .object({
    kind: z.literal('files'),
    paths: z.array(PortableRelativePathSchema).min(1).max(PORTABLE_AGENT_LIST_MAX).readonly(),
    /** What the agent may do with these files; absent is `read`. */
    access: z.enum(['read', 'read-write']).optional(),
  })
  .strict()
  .readonly();

export const PortableKnowledgeUrlSchema = z
  .object({ kind: z.literal('url'), url: PortableHttpsUrlSchema })
  .strict()
  .readonly();

export const PortableKnowledgeConnectorSchema = z
  .object({ kind: z.literal('connector'), name: PortableToolNameSchema })
  .strict()
  .readonly();

export const PortableKnowledgeSourceSchema = z.discriminatedUnion('kind', [
  PortableKnowledgeFilesSchema,
  PortableKnowledgeUrlSchema,
  PortableKnowledgeConnectorSchema,
]);

const ExtensionBlock = z.record(z.string(), z.unknown()).readonly();

/** Reports `message` at `path`, which `superRefine` reads relative to the refined value. */
function issueAt(
  context: z.RefinementCtx,
  path: readonly (string | number)[],
  message: string,
): void {
  context.addIssue({ code: 'custom', path: [...path], message });
}

export const PortableAgentSchema = z
  .object({
    apiVersion: z.literal(PORTABLE_AGENT_API_VERSION),
    kind: z.literal(PORTABLE_AGENT_KIND),
    name: PortableNameSchema,
    description: z.string().min(1).max(PORTABLE_AGENT_DESCRIPTION_MAX_LENGTH).optional(),
    instructions: z.string().max(AGENT_INSTRUCTIONS_MAX_LENGTH),
    /** Absent: the host's default model. */
    model: PortableModelSchema.optional(),
    /** A preference: the engine the agent runs on here, which another host may not offer. */
    engine: EngineIdSchema.optional(),
    permissions: AgentPermissionsSchema,
    tools: z.array(PortableToolSchema).max(PORTABLE_AGENT_LIST_MAX).readonly().default([]),
    skills: z
      .array(
        z
          .object({ name: PortableNameSchema, path: PortableRelativePathSchema })
          .strict()
          .readonly(),
      )
      .max(PORTABLE_AGENT_LIST_MAX)
      .readonly()
      .default([]),
    knowledge: z
      .array(PortableKnowledgeSourceSchema)
      .max(PORTABLE_AGENT_LIST_MAX)
      .readonly()
      .default([]),
    subagents: z
      .array(z.object({ name: PortableNameSchema }).strict().readonly())
      .max(PORTABLE_AGENT_SUBAGENTS_MAX)
      .readonly()
      .default([]),
    limits: z
      .object({
        maxTurns: z.number().int().positive().optional(),
        maxBudgetUsd: z.number().positive().finite().optional(),
      })
      .strict()
      .readonly()
      .optional(),
    extensions: z
      .object({
        engines: z.partialRecord(EngineIdSchema, ExtensionBlock).optional(),
        platforms: z.partialRecord(PlatformIdSchema, ExtensionBlock).optional(),
      })
      .strict()
      .readonly()
      .optional(),
  })
  .strict()
  .superRefine((agent, context) => {
    const toolKeys = new Set<string>();
    agent.tools.forEach((tool, index) => {
      if (tool.kind === 'builtin') return;
      const key = tool.kind === 'code' ? `code:${tool.name}` : tool.name;
      if (toolKeys.has(key)) {
        issueAt(context, ['tools', index], `the tool name ${tool.name} is used more than once`);
      }
      toolKeys.add(key);
    });

    const skillNames = new Set<string>();
    agent.skills.forEach((skill, index) => {
      if (skillNames.has(skill.name)) {
        issueAt(context, ['skills', index], `the skill ${skill.name} is listed more than once`);
      }
      skillNames.add(skill.name);
    });

    const subagentNames = new Set<string>();
    agent.subagents.forEach((subagent, index) => {
      if (subagent.name === agent.name) {
        issueAt(context, ['subagents', index], 'an agent cannot be its own subagent');
      } else if (subagentNames.has(subagent.name)) {
        issueAt(
          context,
          ['subagents', index],
          `the subagent ${subagent.name} is listed more than once`,
        );
      }
      subagentNames.add(subagent.name);
    });

    const connectorNames = new Set<string>();
    agent.knowledge.forEach((source, index) => {
      if (source.kind !== 'connector') return;
      if (connectorNames.has(source.name)) {
        issueAt(
          context,
          ['knowledge', index],
          `the knowledge connector ${source.name} is listed more than once`,
        );
      }
      connectorNames.add(source.name);
    });
  })
  .readonly();
export type PortableAgent = z.infer<typeof PortableAgentSchema>;
export type PortableAgentInput = z.input<typeof PortableAgentSchema>;

/** A file's bytes: a string is UTF-8 text. */
export const PortableBinaryContentSchema = z.union([z.string(), z.instanceof(Uint8Array)]);

const PortableFileSchema = z
  .object({ path: PortableRelativePathSchema, content: PortableBinaryContentSchema })
  .strict()
  .readonly();

export const PortableProjectSchema = z
  .object({
    root: PortableNameSchema,
    agents: z.array(PortableAgentSchema).min(1).max(PORTABLE_PROJECT_AGENTS_MAX).readonly(),
    skills: z
      .array(
        z
          .object({
            name: PortableNameSchema,
            files: z.array(PortableFileSchema).readonly(),
          })
          .strict()
          .readonly(),
      )
      .readonly()
      .default([]),
    knowledgeFiles: z.array(PortableFileSchema).readonly().default([]),
    openapiSpecs: z
      .array(
        z
          .object({ ref: z.string().min(1).max(URL_MAX_LENGTH), content: z.string() })
          .strict()
          .readonly(),
      )
      .readonly()
      .default([]),
    toolEndpoint: z
      .object({
        url: PortableHttpsUrlSchema,
        auth: z
          .object({
            scheme: z.enum(PORTABLE_TOOL_ENDPOINT_AUTH_SCHEMES),
            secretRef: SecretNameSchema,
          })
          .strict()
          .readonly(),
      })
      .strict()
      .readonly()
      .optional(),
  })
  .strict()
  .superRefine((project, context) => {
    const agentNames = new Set<string>();
    project.agents.forEach((agent, index) => {
      if (agentNames.has(agent.name)) {
        issueAt(
          context,
          ['agents', index, 'name'],
          `the agent ${agent.name} is listed more than once`,
        );
      }
      agentNames.add(agent.name);
    });
    if (!agentNames.has(project.root)) {
      issueAt(context, ['root'], `the root ${project.root} is not one of the agents`);
    }

    const subagentNames = new Set(
      project.agents.flatMap((agent) => agent.subagents.map((subagent) => subagent.name)),
    );
    project.agents.forEach((agent, index) => {
      agent.subagents.forEach((subagent, position) => {
        const path = ['agents', index, 'subagents', position];
        if (!agentNames.has(subagent.name)) {
          issueAt(context, path, `the subagent ${subagent.name} is not one of the agents`);
        } else if (subagentNames.has(agent.name)) {
          issueAt(
            context,
            path,
            `${agent.name} is itself a subagent, so it cannot have subagents (one level only)`,
          );
        }
      });
    });

    const skillNames = new Set<string>();
    project.skills.forEach((skill, index) => {
      if (skillNames.has(skill.name)) {
        issueAt(
          context,
          ['skills', index, 'name'],
          `the skill ${skill.name} is listed more than once`,
        );
      }
      skillNames.add(skill.name);
      const skillMdFiles = skill.files.filter((file) => file.path === SKILL_MD_FILENAME).length;
      if (skillMdFiles !== 1) {
        issueAt(
          context,
          ['skills', index, 'files'],
          `must hold exactly one ${SKILL_MD_FILENAME} (found ${skillMdFiles})`,
        );
      }
    });
    project.agents.forEach((agent, index) => {
      agent.skills.forEach((skill, position) => {
        if (!skillNames.has(skill.name)) {
          issueAt(
            context,
            ['agents', index, 'skills', position, 'name'],
            `the skill ${skill.name} has no entry in the project's skills`,
          );
        }
      });
    });
  })
  .readonly();
export type PortableProject = z.infer<typeof PortableProjectSchema>;
export type PortableProjectInput = z.input<typeof PortableProjectSchema>;
