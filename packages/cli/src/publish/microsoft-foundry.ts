/**
 * Microsoft Foundry, published over the Foundry Agent Service REST API
 * (https://learn.microsoft.com/azure/foundry/agents/overview) with a token from the user's own
 * `az` login. The files `aw platforms export` wrote are the source of truth: `project.plan.json`
 * orders the agents, and per agent `agents/<name>.version.json` is the body of
 * `POST {projectEndpoint}/agents/{name}/versions` and the optional `agents/<name>.endpoint.json`
 * the body of `PATCH {projectEndpoint}/agents/{name}` that turns on incoming A2A. Every agent in the
 * plan is published in plan order; project connections are not created (they are listed as next
 * steps) and a `$ref` OpenAPI spec cannot be inlined from here, so both are out of reach of this
 * executor by design.
 *
 * The project endpoint is the one setting that is not a compile concern: it is the optional
 * `projectEndpoint` Foundry option, required here. The other compile keys are stripped.
 *
 * Nothing is written without `--yes`. An agent the vendor does not know (404) is created; a known
 * one is compared by `instructions`, `model` and `tools`, and any answer this CLI cannot read counts
 * as changed, so a drifting response shape costs a redundant version, never a skipped one.
 *
 * VERIFY (fixture `foundry-get-agent.json` is inferred from the Foundry reference, not captured):
 * - the token audience for the project API (`https://ai.azure.com`):
 *   https://learn.microsoft.com/en-us/azure/foundry/agents/quickstarts/prompt-agent
 * - the shape of `GET {projectEndpoint}/agents/{name}` (`versions.latest.definition`), and whether it
 *   echoes `agent_card` and `agent_endpoint` once A2A is on:
 *   https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/enable-agent-to-agent-endpoint
 * - the `az version` output and the install line:
 *   https://learn.microsoft.com/cli/azure/install-azure-cli
 * - plan notes V5 (is a Claude deployment accepted as a prompt-agent model) and V6 (the ARM connection
 *   category): https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/model-router-agents and
 *   https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/tools/agent-to-agent
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { z } from 'zod';

import {
  defineExecutor,
  PublishRefusedError,
  requireTool,
  type PublishContext,
  type PublishOutcome,
  type PublishTool,
} from './kit.ts';
import { accessToken, callVendorJson } from './rest.ts';

const AZ_TOOL: PublishTool = {
  name: 'az',
  versionArgs: ['version'],
  install: 'https://learn.microsoft.com/cli/azure/install-azure-cli',
  docsUrl: 'https://learn.microsoft.com/azure/foundry/agents/overview',
};

const LOGIN = 'az login';
const TOKEN_ARGS = [
  'account',
  'get-access-token',
  '--resource',
  'https://ai.azure.com',
  '--query',
  'accessToken',
  '--output',
  'tsv',
] as const;
const PLAN_FILE = 'project.plan.json';
const EXPORT_COMMAND = 'aw platforms export --platform microsoft-foundry';

const AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/u;

const PlanSchema = z.looseObject({
  foundryApiVersion: z.literal('v1'),
  connections: z.array(z.looseObject({ name: z.string().min(1), kind: z.string().min(1) })),
  agents: z.array(
    z.looseObject({
      name: z.string().regex(AGENT_NAME),
      version: z.string().min(1),
      endpoint: z.string().min(1).optional(),
    }),
  ),
  openapiSpecs: z.array(z.looseObject({ agent: z.string(), tool: z.string() })),
});

const VersionBodySchema = z.looseObject({
  definition: z.looseObject({
    model: z.string().min(1),
    instructions: z.string(),
    tools: z.array(z.unknown()).optional(),
  }),
});
type VersionBody = z.infer<typeof VersionBodySchema>;

const EndpointBodySchema = z.looseObject({
  agent_card: z.looseObject({}),
  agent_endpoint: z.looseObject({}),
});
type EndpointBody = z.infer<typeof EndpointBodySchema>;

const RemoteAgentSchema = z.looseObject({
  versions: z.looseObject({
    latest: z.looseObject({
      definition: z.looseObject({
        model: z.string().optional(),
        instructions: z.string().nullish(),
        tools: z.array(z.unknown()).nullish(),
      }),
    }),
  }),
  agent_card: z.unknown().optional(),
  agent_endpoint: z.unknown().optional(),
});
type RemoteAgent = z.infer<typeof RemoteAgentSchema>;

const ENDPOINT_MESSAGE =
  'required: set platforms.microsoft-foundry.options.projectEndpoint to the https project endpoint';

// Compile keys (`modelDeployment`, …) share the merged settings and were validated at export;
// only the endpoint is read here, so the rest is stripped.
const SettingsSchema = z.object({
  projectEndpoint: z.url({ error: ENDPOINT_MESSAGE }).refine(
    (endpoint) => {
      const url = new URL(endpoint);
      return url.protocol === 'https:' && url.search === '' && url.hash === '';
    },
    { error: 'must be an https URL without a query or fragment' },
  ),
});

async function readExported<Schema extends z.ZodType>(
  context: PublishContext,
  relative: string,
  schema: Schema,
): Promise<z.output<Schema>> {
  const file = path.resolve(context.directory, relative);
  const inside = path.relative(context.directory, file);
  const refuse = (): PublishRefusedError =>
    new PublishRefusedError(
      `${relative} is missing or invalid in ${context.directory}`,
      EXPORT_COMMAND,
    );
  if (inside.startsWith('..') || path.isAbsolute(inside)) throw refuse();
  try {
    return schema.parse(JSON.parse(await readFile(file, 'utf8')));
  } catch {
    throw refuse();
  }
}

interface ExportedAgent {
  readonly name: string;
  readonly version: VersionBody;
  readonly endpoint: EndpointBody | undefined;
}

function isVersionCurrent(remote: RemoteAgent, wanted: VersionBody): boolean {
  const { definition } = remote.versions.latest;
  return (
    definition.model === wanted.definition.model &&
    (definition.instructions ?? undefined) === wanted.definition.instructions &&
    isDeepStrictEqual(definition.tools ?? [], wanted.definition.tools ?? [])
  );
}

function isEndpointCurrent(remote: RemoteAgent, wanted: EndpointBody): boolean {
  return (
    isDeepStrictEqual(remote.agent_card, wanted.agent_card) &&
    isDeepStrictEqual(remote.agent_endpoint, wanted.agent_endpoint)
  );
}

interface Step {
  readonly method: 'POST' | 'PATCH';
  readonly url: string;
  readonly body: unknown;
}

export const microsoftFoundry = defineExecutor({
  tools: [AZ_TOOL],
  defaultEnvironment: 'default',
  settingsSchema: SettingsSchema,
  async publish(context, settings): Promise<PublishOutcome> {
    const plan = await readExported(context, PLAN_FILE, PlanSchema);
    const agents: ExportedAgent[] = [];
    for (const agent of plan.agents) {
      agents.push({
        name: agent.name,
        version: await readExported(context, agent.version, VersionBodySchema),
        endpoint:
          agent.endpoint === undefined
            ? undefined
            : await readExported(context, agent.endpoint, EndpointBodySchema),
      });
    }
    const spec = plan.openapiSpecs[0];
    if (spec !== undefined) {
      throw new PublishRefusedError(
        `Foundry needs OpenAPI specs inline; ${spec.agent}/${spec.tool} is still a $ref`,
        'set allow on the tool so aw platforms export inlines the spec',
      );
    }

    await requireTool(context, AZ_TOOL);
    const token = await accessToken(context, AZ_TOOL, TOKEN_ARGS, LOGIN);

    const base = settings.projectEndpoint.replace(/\/+$/u, '');
    const query = `?api-version=${plan.foundryApiVersion}`;
    const steps: Step[] = [];
    for (const agent of agents) {
      const agentUrl = `${base}/agents/${agent.name}${query}`;
      const { status, json } = await callVendorJson(context, {
        method: 'GET',
        url: agentUrl,
        token,
        accept: [404],
      });
      const parsed = status === 404 ? undefined : RemoteAgentSchema.safeParse(json);
      const remote = parsed?.success === true ? parsed.data : undefined;

      const planned: Step[] = [];
      if (remote === undefined || !isVersionCurrent(remote, agent.version)) {
        planned.push({
          method: 'POST',
          url: `${base}/agents/${agent.name}/versions${query}`,
          body: agent.version,
        });
      }
      if (
        agent.endpoint !== undefined &&
        (remote === undefined || !isEndpointCurrent(remote, agent.endpoint))
      ) {
        planned.push({ method: 'PATCH', url: agentUrl, body: agent.endpoint });
      }
      if (planned.length === 0) context.out(`${agent.name} is current in Foundry\n`);
      for (const step of planned) context.out(`${step.method} ${step.url}\n`);
      steps.push(...planned);
    }

    if (steps.length === 0) return { changes: false, applied: false, nextSteps: [] };
    if (!context.apply) {
      return {
        changes: true,
        applied: false,
        nextSteps: [
          ...plan.connections.map(
            (connection) =>
              `create project connection ${connection.name} (${connection.kind}) in the Foundry portal before publishing`,
          ),
          're-run with --yes to send the calls above',
        ],
      };
    }

    for (const step of steps) {
      await callVendorJson(context, { method: step.method, url: step.url, token, body: step.body });
    }
    return { changes: true, applied: true, nextSteps: [] };
  },
});
