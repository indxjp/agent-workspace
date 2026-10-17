/**
 * Gemini Enterprise, published by registering our A2A agent over REST
 * (https://docs.cloud.google.com/gemini/enterprise/docs/register-and-manage-an-a2a-agent, read
 * 2026-10-10) with a token from the user's own `gcloud` login. The request `aw platforms export`
 * wrote (`register-agent.request.json`) is the source of truth for the collection URL, the body and
 * the authorization; the compile options it was built from are validated at export, so the
 * settings here are stripped, not re-declared.
 *
 * Nothing is sent before the Agent Card checks out: a card that declares another A2A version, or
 * that cannot be fetched without credentials from the deployment, is refused before `gcloud` runs,
 * because a registration that points at a dead card is broken.
 *
 * VERIFY (fixtures `gemini-list-*.json` are inferred from the register page, not captured):
 * - the list response shape (`agents[]` with the full resource `name`, `displayName`, `description`,
 *   `a2aAgentDefinition.jsonAgentCard`) and `nextPageToken` paging;
 * - whether `PATCH <collection>/<agentId>` needs an `updateMask`;
 * - the `gcloud` install line: https://cloud.google.com/sdk/docs/install
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { A2A_PROTOCOL_VERSION } from '@indx-workspace/contracts/a2a';
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

const GCLOUD_TOOL: PublishTool = {
  name: 'gcloud',
  versionArgs: ['--version'],
  install: 'https://cloud.google.com/sdk/docs/install',
  docsUrl: 'https://docs.cloud.google.com/gemini/enterprise/docs/register-and-manage-an-a2a-agent',
};

const LOGIN = 'gcloud auth login';
const REQUEST_FILE = 'register-agent.request.json';
const EXPORT_COMMAND = 'aw platforms export --platform gemini-enterprise';

const RegistrationSchema = z.strictObject({
  name: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().min(1),
  a2aAgentDefinition: z.strictObject({ jsonAgentCard: z.string().min(1) }),
  authorizationConfig: z.strictObject({ agentAuthorization: z.string().min(1) }).optional(),
});

const RequestFileSchema = z.strictObject({
  method: z.literal('POST'),
  url: z.url().refine((url) => url.startsWith('https://') && url.endsWith('/agents')),
  body: RegistrationSchema,
});

const CardSchema = z.looseObject({ protocolVersion: z.string(), url: z.url() });

const ListSchema = z.looseObject({
  agents: z
    .array(
      z.looseObject({
        name: z.string(),
        displayName: z.string().optional(),
        description: z.string().optional(),
        a2aAgentDefinition: z.looseObject({ jsonAgentCard: z.string().optional() }).optional(),
      }),
    )
    .optional(),
  nextPageToken: z.string().optional(),
});
type ListedAgent = NonNullable<z.infer<typeof ListSchema>['agents']>[number];

async function readRequest(context: PublishContext): Promise<z.infer<typeof RequestFileSchema>> {
  const file = path.join(context.directory, REQUEST_FILE);
  try {
    return RequestFileSchema.parse(JSON.parse(await readFile(file, 'utf8')));
  } catch {
    throw new PublishRefusedError(
      `${REQUEST_FILE} is missing or invalid in ${context.directory}`,
      EXPORT_COMMAND,
    );
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Fetches the card the registration points at, without credentials; anything but a 200 refuses. */
async function requireReachableCard(context: PublishContext, cardUrl: string): Promise<void> {
  const unreachable = (): PublishRefusedError =>
    new PublishRefusedError(
      `the A2A agent card is not reachable at ${cardUrl}`,
      'deploy and promote the agent, then publish again',
    );
  let status: number;
  try {
    ({ status } = await context.fetch(cardUrl, { signal: context.signal }));
  } catch {
    context.signal.throwIfAborted();
    throw unreachable();
  }
  if (status !== 200) throw unreachable();
}

async function listAgents(
  context: PublishContext,
  collection: string,
  token: string,
): Promise<readonly ListedAgent[]> {
  const agents: ListedAgent[] = [];
  const seen = new Set<string>();
  let pageToken: string | undefined;
  do {
    const url = new URL(collection);
    if (pageToken !== undefined) url.searchParams.set('pageToken', pageToken);
    const { json } = await callVendorJson(context, { method: 'GET', url: url.href, token });
    const page = ListSchema.safeParse(json);
    if (!page.success) throw new Error(`GET ${collection} answered a body this CLI cannot read`);
    agents.push(...(page.data.agents ?? []));
    pageToken = page.data.nextPageToken === '' ? undefined : page.data.nextPageToken;
    if (pageToken !== undefined) {
      if (seen.has(pageToken)) throw new Error(`GET ${collection} repeated a page token`);
      seen.add(pageToken);
    }
  } while (pageToken !== undefined);
  return agents;
}

function isCurrent(
  listed: ListedAgent,
  body: z.infer<typeof RegistrationSchema>,
  card: unknown,
): boolean {
  const listedCard = parseJson(listed.a2aAgentDefinition?.jsonAgentCard ?? '');
  return listed.description === body.description && isDeepStrictEqual(listedCard, card);
}

export const geminiEnterprise = defineExecutor({
  tools: [GCLOUD_TOOL],
  defaultEnvironment: 'default',
  // Compile keys (`projectId`, `engineId`, …) share the merged settings and were validated when
  // the bundle was exported; the request file already carries what they decided, so they are
  // stripped rather than declared a second time.
  settingsSchema: z.object({}),
  async publish(context): Promise<PublishOutcome> {
    const { url: collection, body } = await readRequest(context);

    const card = parseJson(body.a2aAgentDefinition.jsonAgentCard);
    const parsedCard = CardSchema.safeParse(card);
    if (!parsedCard.success) {
      throw new PublishRefusedError(
        `the agent card in ${REQUEST_FILE} is not a JSON card`,
        EXPORT_COMMAND,
      );
    }
    if (parsedCard.data.protocolVersion !== A2A_PROTOCOL_VERSION) {
      throw new PublishRefusedError(
        `Gemini Enterprise registers A2A v0.3 agents; the card declares ${parsedCard.data.protocolVersion}`,
        EXPORT_COMMAND,
      );
    }
    await requireReachableCard(context, `${parsedCard.data.url}/.well-known/agent-card.json`);

    await requireTool(context, GCLOUD_TOOL);
    const token = await accessToken(context, GCLOUD_TOOL, ['auth', 'print-access-token'], LOGIN);

    const existing = (await listAgents(context, collection, token)).find(
      (listed) => listed.displayName === body.displayName,
    );
    if (existing !== undefined && isCurrent(existing, body, card)) {
      context.out(`${body.displayName} is already registered in Gemini Enterprise\n`);
      return { changes: false, applied: false, nextSteps: [] };
    }

    const agentId = existing?.name.split('/').at(-1);
    const method = agentId === undefined ? 'POST' : 'PATCH';
    const target = agentId === undefined ? collection : `${collection}/${agentId}`;
    context.out(`${method} ${target}\n`);
    if (!context.apply) {
      return { changes: true, applied: false, nextSteps: ['re-run with --yes to send it'] };
    }

    await callVendorJson(context, { method, url: target, token, body });
    return { changes: true, applied: true, nextSteps: [] };
  },
});
