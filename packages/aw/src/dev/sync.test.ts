import { createHash } from 'node:crypto';
import { readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  AgentVersionResourceSchema,
  CreateAgentFromVersionRequestSchema,
  CreateAgentVersionRequestSchema,
  SetAgentPointerRequestSchema,
  type AgentVersionResource,
} from '@indx-workspace/contracts/agent-versions';
import type { AgentResource } from '@indx-workspace/contracts/agents';
import type { ConnectorResource } from '@indx-workspace/contracts/connectors';
import { SKILL_IMPORT_MULTIPART, type SkillFile } from '@indx-workspace/contracts/skills';
import { createClient, type AgentWorkspaceClient } from '@indx-workspace/sdk';
import { fixtures } from '@indx-workspace/sdk/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PROJECT_API_VERSION,
  PROJECT_KIND,
  type ProjectDocument,
} from '@indx-workspace/contracts/project-file';

import type { CliIo } from '../io.js';
import { pushProject } from '../project/index.js';
import { FIXTURES, IDS, json, tempDirectory, tempFile } from '../testing.js';
import { startDevSync, type DevSync } from './sync.js';

// These tests run the real project loader, a forked Node process that evaluates the definition
// files: a second or more each on a shared CI runner, past vitest's 5 s default when several run.
vi.setConfig({ testTimeout: 30_000 });

/**
 * Issue #453 (S1-15): the sync loop over a real project directory — real `fs.watch`, the real
 * loader child with Node's type stripping — against a stateful double of the control plane,
 * reached through the SDK client as `aw dev` reaches the runtime it started.
 */

/** The project file the sync plans tools against: no `connectors`, so every tool name is free. */
const PROJECT_DOCUMENT: ProjectDocument = {
  apiVersion: PROJECT_API_VERSION,
  kind: PROJECT_KIND,
  name: 'demo',
  environments: { local: { cloud: 'local', identity: { bootstrapAdmin: 'admin@localhost.test' } } },
};
const ORIGIN = 'http://127.0.0.1:3000';
const AT = '2026-10-02T10:00:00.000Z';
const DEFINE = `import { defineAgent, defineSurface } from '@indx-workspace/sdk/define';\n`;
/** How long a case waits for output that a save, the debounce and a loader fork produce. */
const DEADLINE_MS = 5000;
/** A short debounce keeps the suite fast; the burst case still sees one sync. */
const DEBOUNCE_MS = 100;
/** How long a case waits to be sure a sync that should not run has not run. */
const SETTLE_MS = 2000;
const WIDGET = `widget: <script src="${ORIGIN}/p/s/main/widget.js" async></script>`;

const AGENT = `${DEFINE}
export default defineAgent({ name: 'assistant', instructions: 'Help people.' });
`;

function surface(colour: string): string {
  return `${DEFINE}
export default defineSurface({ name: 'main', agent: 'assistant', title: 'Ask us', theme: { colour: '${colour}' } });
`;
}

interface Recorded {
  readonly method: string;
  readonly path: string;
  readonly json: unknown;
}

/** One agent the double holds: the row, its versions, its `local` pointer and its source. */
interface StoredAgent {
  agent: AgentResource;
  readonly versions: AgentVersionResource[];
  local: { number: number; updatedAt: string } | null;
  /** The version the row was last written from; `null` after an edit outside versions. */
  materialised: number | null;
}

interface ServerState {
  readonly agents: StoredAgent[];
  /** The workspace's connectors: the catalog tools a sync creates, and any seeded. */
  readonly connectors: ConnectorResource[];
  /** The workspace's skills by name, each with its files. */
  readonly skills: Map<string, SkillFile[]>;
  /** The file folders that hold a file: a grant on any other is refused as missing (#899). */
  readonly folders: Set<string>;
  /** The server's clock: every call answers a later time. */
  readonly now: () => string;
}

function clock(): () => string {
  let tick = 0;
  return () => {
    tick += 1;
    return new Date(Date.parse(AT) + tick * 1000).toISOString();
  };
}

/** The first agent keeps the shared fixture id; the ones after it get their own. */
function agentId(index: number): string {
  return index === 0 ? IDS.agent : `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`;
}

function isDryRun(body: unknown): boolean {
  return typeof body === 'object' && body !== null && 'dryRun' in body && body.dryRun === true;
}

function versionOf(
  stored: { readonly id: string; readonly versions: readonly AgentVersionResource[] },
  draft: { readonly body: unknown; readonly summary: string; readonly via: string },
): AgentVersionResource {
  const number = stored.versions.length + 1;
  return AgentVersionResourceSchema.parse({
    id: `v-${stored.id}-${String(number)}`,
    agentId: stored.id,
    workspaceId: IDS.workspace,
    number,
    summary: draft.summary,
    via: draft.via,
    body: draft.body,
    createdByPrincipalId: IDS.principal,
    createdAt: AT,
  });
}

/**
 * The agents, each with its versions and `local` pointer, behind the routes `aw push` uses.
 * Setting a pointer writes the row and the pointer with one time, as the server's transaction
 * does; saving a version moves neither.
 */
/**
 * The server's dry run and save answer 422 for a version naming a skill the workspace does not
 * have (`agent_definition_references_missing`), so `skills/` must be uploaded before any dry run.
 */
function missingSkills(state: ServerState, version: { body: unknown }): Response | null {
  const body = version.body as {
    definition: { resources: { skills: string[]; files: { path: string }[] } };
  };
  const { skills, files } = body.definition.resources;
  const missing = [
    ...skills.filter((name) => !state.skills.has(name)).map((name) => `skill:${name}`),
    ...files.filter((file) => !state.folders.has(file.path)).map((file) => `file:${file.path}`),
  ];
  return missing.length === 0
    ? null
    : json(422, {
        error: {
          code: 'agent_definition_references_missing',
          message: 'The definition names resources this workspace does not have.',
          details: missing,
        },
      });
}

function server(state: ServerState, request: Recorded): Response {
  const route = `${request.method} ${request.path}`;
  if (request.path.startsWith('/api/connectors')) return connectorsServer(state, request);
  if (request.path.startsWith('/api/skills')) return skillsServer(state, request);
  if (route === 'GET /api/agents') {
    return json(200, { agents: state.agents.map((stored) => stored.agent) });
  }
  if (route === 'POST /api/agents') {
    const body = CreateAgentFromVersionRequestSchema.parse(request.json);
    const refused = missingSkills(state, body.version);
    if (refused !== null) return refused;
    if (body.dryRun === true) return json(200, { ok: true, number: 1 });
    const id = agentId(state.agents.length);
    const at = state.now();
    const agent = {
      ...FIXTURES.agent,
      id,
      modelConnectionId: null,
      name: body.version.body.definition.agent.name,
      updatedAt: at,
    };
    const version = versionOf({ id, versions: [] }, body.version);
    state.agents.push({
      agent,
      versions: [version],
      local: { number: version.number, updatedAt: at },
      materialised: version.number,
    });
    return json(201, { agent, version });
  }
  const stored = state.agents.find(
    (candidate) =>
      request.path === `/api/agents/${candidate.agent.id}` ||
      request.path.startsWith(`/api/agents/${candidate.agent.id}/`),
  );
  if (stored === undefined) {
    return json(404, { error: { code: 'not_found', message: 'no route' } });
  }
  const agentPath = `/api/agents/${stored.agent.id}`;
  if (route === `POST ${agentPath}/versions`) {
    const body = CreateAgentVersionRequestSchema.parse(request.json);
    const refused = missingSkills(state, body);
    if (refused !== null) return refused;
    if (body.dryRun === true) return json(200, { ok: true, number: stored.versions.length + 1 });
    const version = versionOf({ id: stored.agent.id, versions: stored.versions }, body);
    stored.versions.push(version);
    return json(201, version);
  }
  if (route === `GET ${agentPath}/versions`) {
    return json(200, {
      items: stored.versions,
      pointers: stored.local === null ? [] : [{ environment: 'local', ...stored.local }],
      materialised: stored.materialised,
    });
  }
  if (route === `PUT ${agentPath}/pointers`) {
    const body = SetAgentPointerRequestSchema.parse(request.json);
    const at = state.now();
    stored.agent = { ...stored.agent, updatedAt: at };
    stored.local = { number: body.version, updatedAt: at };
    stored.materialised = body.version;
    return json(200, {
      agent: stored.agent,
      pointer: { environment: 'local', number: body.version, updatedAt: at },
    });
  }
  // The reads of `agents.export`, which only `aw push --yes` makes for an agent with no version;
  // the refused save in `aw dev` must never send them.
  if (route === `GET ${agentPath}`) return json(200, stored.agent);
  if (route === `GET ${agentPath}/policy`) return json(200, { policy: FIXTURES.policy });
  if (route === `GET ${agentPath}/resources`) {
    return json(200, { assignments: { files: [], skillIds: [], connectorIds: [] } });
  }
  return json(404, { error: { code: 'not_found', message: 'no route' } });
}

/** The resource the server keeps for a tool body: its document only as a digest. */
function toolResource(id: string, body: Record<string, unknown>): ConnectorResource {
  const document = String(body['document']);
  return fixtures.openApiConnector({
    id,
    name: String(body['name']),
    openapi: {
      spec: {
        digest: `sha256:${createHash('sha256').update(document, 'utf8').digest('hex')}`,
        bytes: Buffer.byteLength(document, 'utf8'),
      },
      baseUrl: 'https://api.example.com',
      auth: 'bearer',
      allow: body['allow'] as string[],
      operations: [{ name: 'getOrder', method: 'GET', path: '/orders/{id}' }],
    },
  });
}

/** A multipart skill import read the way `POST /api/skills` reads it: the name, then one part per file. */
async function multipartImport(form: FormData): Promise<{ name: string; files: SkillFile[] }> {
  const name = form.get(SKILL_IMPORT_MULTIPART.nameField);
  const files: SkillFile[] = [];
  for (const part of form.getAll(SKILL_IMPORT_MULTIPART.fileField)) {
    if (typeof part === 'string') continue;
    const bytes = Buffer.from(await part.arrayBuffer());
    files.push({ path: part.name, contentBase64: bytes.toString('base64') });
  }
  return { name: typeof name === 'string' ? name : '', files };
}

/** The skills routes `aw dev` uses for `skills/`: list, import, export and patch. */
function skillsServer(state: ServerState, request: Recorded): Response {
  const detail = (name: string) => ({ ...FIXTURES.skill, name });
  const body = (request.json ?? {}) as {
    name?: string;
    files?: SkillFile[];
    removeFiles?: string[];
  };
  if (request.path === '/api/skills' && request.method === 'GET') {
    return json(200, { skills: [...state.skills.keys()].map(detail) });
  }
  if (request.path === '/api/skills') {
    state.skills.set(body.name ?? '', body.files ?? []);
    return json(201, { skill: detail(body.name ?? '') });
  }
  const name = request.path.split('/').pop() ?? '';
  const files = state.skills.get(name) ?? [];
  if (request.method === 'GET') return json(200, { skill: { name, files } });
  const kept = files.filter(
    (file) =>
      !(body.removeFiles ?? []).includes(file.path) &&
      !(body.files ?? []).some((f) => f.path === file.path),
  );
  state.skills.set(name, [...kept, ...(body.files ?? [])]);
  return json(200, { skill: detail(name) });
}

/** `GET`/`POST /api/connectors` and `PATCH /api/connectors/:id`, for tool bodies. */
function connectorsServer(state: ServerState, request: Recorded): Response {
  const body = (request.json ?? {}) as Record<string, unknown>;
  if (request.method === 'GET') return json(200, { connectors: state.connectors });
  if (request.method === 'POST') {
    const id = `99999999-9999-4999-8999-${String(state.connectors.length).padStart(12, '0')}`;
    const created =
      body['transport'] === 'http'
        ? fixtures.connector({
            id,
            name: String(body['name']),
            url: String(body['url']),
            authType: 'none',
          })
        : toolResource(id, body);
    state.connectors.push(created);
    return json(201, created);
  }
  const index = state.connectors.findIndex((c) => request.path === `/api/connectors/${c.id}`);
  if (request.method !== 'PATCH' || index < 0) {
    return json(404, { error: { code: 'connector_not_found', message: 'no connector' } });
  }
  const current = state.connectors[index];
  const updated =
    current?.transport != null
      ? { ...current, ...body }
      : toolResource(state.connectors[index]?.id ?? '', body);
  state.connectors[index] = updated;
  return json(200, updated);
}

/** The project's first agent, which most cases have alone. */
function first(harness: { readonly state: ServerState }): StoredAgent {
  const stored = harness.state.agents[0];
  if (stored === undefined) throw new Error('no agent was created');
  return stored;
}

function named(harness: { readonly state: ServerState }, name: string): StoredAgent {
  const stored = harness.state.agents.find((candidate) => candidate.agent.name === name);
  if (stored === undefined) throw new Error(`no agent ${name}`);
  return stored;
}

/**
 * An edit in the UI (issue #546): the row moves on and is no longer its version (#613); the
 * `local` pointer does not move.
 */
function editInUi(harness: { readonly state: ServerState }, name: string): StoredAgent {
  const stored = named(harness, name);
  stored.agent = { ...stored.agent, updatedAt: harness.state.now() };
  stored.materialised = null;
  return stored;
}

/** An agent made in the UI before `aw dev` started: no version and no `local` pointer. */
function seedUiAgent(state: ServerState, name: string): void {
  state.agents.push({
    agent: {
      ...FIXTURES.agent,
      id: agentId(state.agents.length),
      modelConnectionId: null,
      name,
      updatedAt: state.now(),
    },
    versions: [],
    local: null,
    materialised: null,
  });
}

type Answer = (request: Recorded) => Response | Promise<Response>;

interface Harness {
  readonly root: string;
  readonly client: AgentWorkspaceClient;
  readonly io: CliIo;
  readonly calls: Recorded[];
  readonly state: ServerState;
  readonly output: () => { readonly stdout: string; readonly stderr: string };
  readonly sync: DevSync;
  readonly controller: AbortController;
  readonly fatal: Error[];
  /** Answer the next requests with this instead of the server, until it is cleared. */
  outage: Answer | null;
  /** Make every stdout write throw: a failure no refusal describes. */
  brokenStdout: boolean;
}

const running: Harness[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const harness of running.splice(0)) {
    harness.controller.abort();
    await harness.sync.closed;
  }
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function start(
  files: Readonly<Record<string, string>>,
  seed: (state: ServerState) => void = () => undefined,
  env: CliIo['env'] = {},
  toolHost?: { readonly url: string },
): Promise<Harness> {
  const root = await tempDirectory();
  directories.push(root);
  for (const [file, contents] of Object.entries(files)) await tempFile(root, file, contents);
  let stdout = '';
  let stderr = '';
  const calls: Recorded[] = [];
  const state: ServerState = {
    agents: [],
    connectors: [],
    skills: new Map(),
    folders: new Set(),
    now: clock(),
  };
  seed(state);
  const fatal: Error[] = [];
  const controller = new AbortController();
  // Filled in below; the fetch double reads it on every call.
  const holder: { harness: Harness | null } = { harness: null };
  const fetchDouble = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const href = input instanceof URL ? input.href : typeof input === 'string' ? input : input.url;
    const body = init?.body;
    const recorded: Recorded = {
      method: init?.method ?? 'GET',
      path: new URL(href).pathname,
      json:
        typeof body === 'string'
          ? (JSON.parse(body) as unknown)
          : body instanceof FormData
            ? await multipartImport(body)
            : undefined,
    };
    calls.push(recorded);
    const outage = holder.harness?.outage ?? null;
    return outage === null ? server(state, recorded) : outage(recorded);
  };
  const io: CliIo = {
    stdin: () => Promise.resolve(''),
    stdout: (text) => {
      if (holder.harness?.brokenStdout === true) throw new RangeError('stdout is gone');
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    env,
    homeDir: root,
    fetch: fetchDouble,
    isTty: false,
  };
  const client = createClient({
    baseUrl: ORIGIN,
    auth: { kind: 'api-key', apiKey: `ak_live_${'A'.repeat(22)}_${'S'.repeat(43)}` },
    fetch: fetchDouble,
  });
  const sync = startDevSync({
    client,
    root,
    io,
    signal: controller.signal,
    origin: ORIGIN,
    debounceMs: DEBOUNCE_MS,
    forkWithheld: ['ORDERS_TOKEN'],
    project: PROJECT_DOCUMENT,
    toolHost,
    onFatal: (error) => {
      fatal.push(error);
    },
  });
  const harness: Harness = {
    root,
    client,
    io,
    calls,
    state,
    output: () => ({ stdout, stderr }),
    sync,
    controller,
    fatal,
    outage: null,
    brokenStdout: false,
  };
  holder.harness = harness;
  running.push(harness);
  return harness;
}

/** Poll until `condition` holds, failing after the deadline with the output so far. */
async function until(harness: Harness, condition: () => boolean): Promise<void> {
  const deadline = Date.now() + DEADLINE_MS;
  while (!condition()) {
    if (Date.now() > deadline) {
      const { stdout, stderr } = harness.output();
      throw new Error(`timed out; stdout:\n${stdout}\nstderr:\n${stderr}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function count(text: string, part: string): number {
  return text.split(part).length - 1;
}

/** The requests that wrote something: neither a read nor a dry run. */
function writes(harness: Harness): readonly string[] {
  return harness.calls
    .filter((call) => call.method !== 'GET' && !(call.method === 'POST' && isDryRun(call.json)))
    .map((call) => `${call.method} ${call.path}`);
}

/** The reads `agents.export` makes: the agent row, its policy and its resources. */
function exportReads(harness: Harness): readonly string[] {
  return harness.calls
    .filter((call) => /^\/api\/agents\/[^/]+(\/policy|\/resources)?$/.test(call.path))
    .map((call) => `${call.method} ${call.path}`);
}

function synced(harness: Harness): number {
  return count(harness.output().stdout, 'synced: ');
}

const PROJECT = { 'agents/assistant.ts': AGENT, 'surfaces/main.ts': surface('#0055ff') };

describe('startDevSync (issue #453)', () => {
  it('syncs once on start with one write per agent, then prints the surface lines once', async () => {
    const harness = await start(PROJECT);
    await until(harness, () => synced(harness) === 1);
    expect(writes(harness)).toEqual(['POST /api/agents']);
    const { stdout, stderr } = harness.output();
    expect(stderr).toBe('');
    expect(stdout).toBe(
      [
        'synced: "assistant" created at version 1',
        `page: ${ORIGIN}/p/s/main`,
        `try: ${ORIGIN}/p/s/main/try`,
        WIDGET,
        '',
      ].join('\n'),
    );
  });

  it('uploads a skills/ folder created after start before the agent that names it, and syncs any file in it', async () => {
    const SKILL_MD = [
      '---',
      'name: refunds',
      'description: Refund policy.',
      '---',
      '',
      'Be kind.',
      '',
    ].join('\n');
    const harness = await start(PROJECT);
    await until(harness, () => synced(harness) === 1);
    await tempFile(harness.root, 'skills/refunds/SKILL.md', SKILL_MD);
    await writeFile(
      path.join(harness.root, 'agents/assistant.ts'),
      AGENT.replace('{ defineAgent,', '{ defineAgent, skill,').replace(
        "instructions: 'Help people.'",
        "instructions: 'Help people.', skills: [skill('refunds')]",
      ),
    );
    await until(harness, () => synced(harness) >= 2);
    const written = writes(harness);
    expect(written.indexOf('POST /api/skills')).toBeGreaterThan(-1);
    expect(written.indexOf('POST /api/skills')).toBeLessThan(
      written.findLastIndex((write) => write.includes('/api/agents')),
    );
    const saved = harness.state.agents[0]?.versions.at(-1);
    expect(JSON.stringify(saved?.body)).toContain('refunds');
    // Not a .md or .ts file: a skill folder holds any file.
    await tempFile(harness.root, 'skills/refunds/policy.txt', 'ok');
    await until(harness, () => writes(harness).includes('PATCH /api/skills/refunds'));
  });

  it('syncs a project of two agents on start with one write per agent and one synced part each', async () => {
    const harness = await start({
      'agents/a.ts': `${DEFINE}export default defineAgent({ name: 'a', instructions: 'A.' });\n`,
      'agents/b.ts': `${DEFINE}export default defineAgent({ name: 'b', instructions: 'B.' });\n`,
    });
    await until(harness, () => synced(harness) === 1);
    expect(writes(harness)).toEqual(['POST /api/agents', 'POST /api/agents']);
    expect(harness.state.agents.map((stored) => stored.agent.name)).toEqual(['a', 'b']);
    const { stdout, stderr } = harness.output();
    expect(stderr).toBe('');
    expect(stdout).toBe('synced: "a" created at version 1, "b" created at version 1\n');
  });

  it('runs one sync on start of a settled project, not a second one its own load triggers', async () => {
    const harness = await start(PROJECT);
    await until(harness, () => synced(harness) === 1);
    // Long enough for the debounce and another loader run had the load scheduled one.
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    expect(synced(harness)).toBe(1);
    expect(
      harness.calls.filter((call) => `${call.method} ${call.path}` === 'GET /api/agents'),
    ).toHaveLength(1);
    expect(harness.output().stdout).not.toContain('unchanged');
  });

  it('syncs an edit to an instructions file in a folder beside its agent', async () => {
    const harness = await start({
      'agents/assistant.ts': `${DEFINE}export default defineAgent({ name: 'assistant', instructions: { file: './prompts/en.md' } });\n`,
      'agents/prompts/en.md': 'Help people.\n',
    });
    await until(harness, () => synced(harness) === 1);

    await tempFile(harness.root, 'agents/prompts/en.md', 'Help people kindly.\n');
    await until(harness, () => synced(harness) === 2);
    expect(harness.output().stdout).toContain('synced: "assistant" version 2 (1 change)\n');
    expect(first(harness).versions).toHaveLength(2);
  });

  it('pushes a saved surface again, once per burst, and prints its lines only once', async () => {
    const harness = await start(PROJECT);
    await until(harness, () => synced(harness) === 1);

    await tempFile(harness.root, 'surfaces/main.ts', surface('#112233'));
    await until(harness, () => synced(harness) === 2);
    expect(writes(harness)).toEqual([
      'POST /api/agents',
      `POST /api/agents/${IDS.agent}/versions`,
      `PUT /api/agents/${IDS.agent}/pointers`,
    ]);
    expect(harness.output().stdout).toContain('synced: "assistant" version 2 (1 change)\n');

    for (const colour of ['#000001', '#000002', '#000003']) {
      await tempFile(harness.root, 'surfaces/main.ts', surface(colour));
    }
    await until(harness, () => synced(harness) >= 3);
    // Settle: a second sync for the same burst would land within the debounce and one loader run.
    await until(harness, () => first(harness).versions.length >= 3);
    const after = writes(harness).length;
    await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_MS * 5));
    expect(writes(harness).length).toBe(after);
    expect(first(harness).versions).toHaveLength(3);
    expect(first(harness).local?.number).toBe(3);
    const { stdout } = harness.output();
    expect(count(stdout, WIDGET)).toBe(1);
    expect(stdout.indexOf(WIDGET)).toBeGreaterThan(stdout.indexOf('synced: '));
  });

  it('prints a refused surface like aw push, writes nothing, and syncs the next valid save', async () => {
    const harness = await start(PROJECT);
    await until(harness, () => synced(harness) === 1);

    await tempFile(harness.root, 'surfaces/main.ts', surface('blue'));
    await until(harness, () => harness.output().stderr.includes('sync: 1 problem'));
    const { stdout, stderr } = harness.output();
    expect(stdout).toMatch(/^✗ surfaces\/main\.ts:\d+:\d+ {2}theme\.colour: /mu);
    expect(stderr).toBe(
      'sync: 1 problem; nothing was synced; fix the file and save to sync again\n',
    );
    expect(writes(harness)).toEqual(['POST /api/agents']);

    await tempFile(harness.root, 'surfaces/main.ts', surface('#445566'));
    await until(harness, () => synced(harness) === 2);
    expect(writes(harness)).toHaveLength(3);
    expect(harness.fatal).toEqual([]);
  });

  it('says once that an agent renamed in its file stays in the workspace (BH061-047)', async () => {
    const harness = await start({
      'agents/a.ts': `${DEFINE}export default defineAgent({ name: 'a', instructions: 'A.' });\n`,
    });
    await until(harness, () => synced(harness) === 1);
    const old = named(harness, 'a');

    await tempFile(
      harness.root,
      'agents/a.ts',
      `${DEFINE}export default defineAgent({ name: 'b', instructions: 'A.' });\n`,
    );
    await until(harness, () => synced(harness) === 2);
    expect(harness.output().stderr).toBe(
      `notice: agents/a.ts no longer defines "a", which stays in the local workspace (aw chat then asks which agent); remove it with aw agents remove ${old.agent.id}\n`,
    );

    await tempFile(
      harness.root,
      'agents/a.ts',
      `${DEFINE}export default defineAgent({ name: 'b', instructions: 'B.' });\n`,
    );
    await until(harness, () => synced(harness) === 3);
    expect(count(harness.output().stderr, 'notice: ')).toBe(1);
    expect(harness.fatal).toEqual([]);
  });

  it('syncs the save that fixes a syntax error, written the way an editor does (#662)', async () => {
    const harness = await start(PROJECT);
    await until(harness, () => synced(harness) === 1);

    // A save is a write to a temporary file and a rename over the original: a new inode each time.
    const save = async (source: string): Promise<void> => {
      const target = path.join(harness.root, 'surfaces', 'main.ts');
      await writeFile(`${target}.tmp`, source);
      await rename(`${target}.tmp`, target);
    };
    await save('export default {\n  name: "main"\n  agent: "assistant",\n};\n');
    await until(harness, () => harness.output().stdout.includes('✗ surfaces/main.ts:3:'));
    expect(synced(harness)).toBe(1);

    await save(surface('#778899'));
    await until(harness, () => synced(harness) === 2);
    expect(harness.fatal).toEqual([]);
  });

  it('says a 503 and a transport failure, and keeps watching', async () => {
    const harness = await start(PROJECT);
    await until(harness, () => synced(harness) === 1);

    harness.outage = () =>
      json(503, { error: { code: 'service_unavailable', message: 'starting', details: [] } });
    await tempFile(harness.root, 'surfaces/main.ts', surface('#101010'));
    await until(harness, () => harness.output().stderr.includes('sync: '));
    expect(harness.output().stdout).toContain('agents/assistant.ts: 503 service_unavailable');

    harness.outage = () => Promise.reject(new TypeError('fetch failed'));
    const before = harness.output().stderr.length;
    await tempFile(harness.root, 'surfaces/main.ts', surface('#202020'));
    await until(harness, () => harness.output().stderr.slice(before).startsWith('sync: '));

    harness.outage = null;
    await tempFile(harness.root, 'surfaces/main.ts', surface('#303030'));
    await until(harness, () => synced(harness) === 2);
    expect(harness.fatal).toEqual([]);
  });

  it('says a directory with no agents and syncs once one appears', async () => {
    const harness = await start({});
    await until(harness, () => harness.output().stderr.includes('sync: '));
    expect(harness.output().stderr).toBe('sync: no agents/*.ts in this directory\n');

    await tempFile(harness.root, 'agents/assistant.ts', AGENT);
    await until(harness, () => synced(harness) === 1);
    expect(writes(harness)).toEqual(['POST /api/agents']);
  });

  it('releases the watchers on abort, and no sync runs after it', async () => {
    const harness = await start(PROJECT);
    await until(harness, () => synced(harness) === 1);
    harness.controller.abort();
    await harness.sync.closed;
    const calls = harness.calls.length;
    await tempFile(harness.root, 'surfaces/main.ts', surface('#404040'));
    await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_MS * 5));
    expect(harness.calls).toHaveLength(calls);
    // The watchers no longer hold the directory: it can be removed at once.
    await rm(harness.root, { recursive: true });
  });

  it('stops on an error no refusal describes and reports it as fatal', async () => {
    const harness = await start(PROJECT);
    harness.brokenStdout = true;
    await until(harness, () => harness.fatal.length === 1);
    await harness.sync.closed;
    expect(harness.fatal[0]?.message).toBe('stdout is gone');
    // Stopped: a later save starts nothing.
    const calls = harness.calls.length;
    await tempFile(harness.root, 'surfaces/main.ts', surface('#505050'));
    await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_MS * 5));
    expect(harness.calls).toHaveLength(calls);
  });
});

const EDITED_SUMMARY = 'those agents keep their UI edit until aw push --yes overwrites them';
const HINT = 'run `aw push --yes` to overwrite it with this file';

describe('startDevSync over an agent edited in the UI (issue #546)', () => {
  it('refuses the edited agent, writes nothing for it, and still syncs the others', async () => {
    const harness = await start({
      'agents/a.ts': `${DEFINE}export default defineAgent({ name: 'a', instructions: 'A.' });\n`,
      'agents/b.ts': `${DEFINE}export default defineAgent({ name: 'b', instructions: 'B.' });\n`,
    });
    await until(harness, () => synced(harness) === 1);
    const a = editInUi(harness, 'a');
    const b = named(harness, 'b');
    const before = writes(harness).length;

    await tempFile(
      harness.root,
      'agents/b.ts',
      `${DEFINE}export default defineAgent({ name: 'b', instructions: 'B again.' });\n`,
    );
    await until(harness, () => synced(harness) === 2);
    const { stdout, stderr } = harness.output();
    expect(stdout).toContain('synced: "b" version 2 (1 change)\n');
    expect(stdout).toContain(
      `agents/a.ts: local edited_in_ui ["a" edited ${a.agent.updatedAt}, ` +
        `local 1 set ${a.local?.updatedAt ?? ''}]; ${HINT}\n`,
    );
    expect(stderr).toBe(`sync: 1 problem; ${EDITED_SUMMARY}\n`);
    expect(writes(harness).slice(before)).toEqual([
      `POST /api/agents/${b.agent.id}/versions`,
      `PUT /api/agents/${b.agent.id}/pointers`,
    ]);
    expect(a.versions).toHaveLength(1);
    expect(harness.fatal).toEqual([]);
  });

  it('refuses an agent made in the UI, until aw push --yes overwrites it', async () => {
    const harness = await start(
      {
        'agents/helper.ts': `${DEFINE}export default defineAgent({ name: 'helper', instructions: 'H.' });\n`,
      },
      (state) => {
        seedUiAgent(state, 'helper');
      },
    );
    const line = `agents/helper.ts: local edited_in_ui ["helper" has no local pointer]; ${HINT}\n`;
    await until(harness, () => harness.output().stderr.includes('sync: '));
    expect(harness.output()).toEqual({
      stdout: line,
      stderr: `sync: 1 problem; ${EDITED_SUMMARY}\n`,
    });
    expect(writes(harness)).toEqual([]);
    // Refused before `agents.export`: no read of the agent, its policy or its resources.
    expect(exportReads(harness)).toEqual([]);

    // `aw push --yes` (the default, overwrite) writes the file over the UI's agent.
    const pushed = await pushProject({
      client: harness.client,
      root: harness.root,
      io: harness.io,
      signal: harness.controller.signal,
      yes: true,
    });
    expect(pushed.problems).toEqual([]);
    expect(pushed.agents.map((agent) => agent.action)).toEqual(['version']);
    expect(named(harness, 'helper').local?.number).toBe(1);

    await tempFile(
      harness.root,
      'agents/helper.ts',
      `${DEFINE}export default defineAgent({ name: 'helper', instructions: 'H again.' });\n`,
    );
    await until(harness, () => synced(harness) === 1);
    const { stdout } = harness.output();
    expect(stdout).toBe(`${line}synced: "helper" version 2 (1 change)\n`);
    expect(count(stdout, 'edited_in_ui')).toBe(1);
    expect(harness.fatal).toEqual([]);
  });

  it('keeps advising a fix when another agent has a problem a save can clear', async () => {
    const harness = await start({
      'agents/a.ts': `${DEFINE}export default defineAgent({ name: 'a', instructions: 'A.' });\n`,
      'agents/b.ts': `${DEFINE}export default defineAgent({ name: 'b', instructions: 'B.' });\n`,
    });
    await until(harness, () => synced(harness) === 1);
    editInUi(harness, 'a');
    const b = named(harness, 'b');
    harness.outage = (request) =>
      request.method === 'GET' && request.path === `/api/agents/${b.agent.id}/versions`
        ? json(503, { error: { code: 'service_unavailable', message: 'starting', details: [] } })
        : server(harness.state, request);
    await tempFile(
      harness.root,
      'agents/b.ts',
      `${DEFINE}export default defineAgent({ name: 'b', instructions: 'B again.' });\n`,
    );
    await until(harness, () => harness.output().stderr.includes('sync: '));
    const { stdout, stderr } = harness.output();
    expect(stdout).toContain('agents/a.ts: local edited_in_ui');
    expect(stdout).toContain('agents/b.ts: 503 service_unavailable');
    expect(stderr).toBe(
      'sync: 2 problems; nothing was synced; fix the file and save to sync again\n',
    );
    expect(harness.fatal).toEqual([]);
  });
});

describe('startDevSync over a file folder with no file (#899)', () => {
  const GRANTED = `import { defineAgent, files } from '@indx-workspace/sdk/define';
export default defineAgent({ name: 'reviewer', instructions: 'R.', files: [files('playbook', 'read')] });
`;

  it('says what to run, since no edit to the file creates the folder', async () => {
    const harness = await start({ 'agents/reviewer.ts': GRANTED });
    await until(harness, () => harness.output().stderr.includes('sync: '));
    expect(harness.output()).toEqual({
      stdout:
        'agents/reviewer.ts: 422 agent_definition_references_missing [file:playbook]; upload a file into playbook (aw files upload <folder>/<name> <local-file>), then save again or run aw push --yes\n',
      stderr:
        'sync: 1 problem; upload the files named above, then save a file or run aw push --yes to sync again\n',
    });
    expect(harness.fatal).toEqual([]);
  });

  it('syncs the agent once a file is in the folder and the project is saved again', async () => {
    const harness = await start({ 'agents/reviewer.ts': GRANTED });
    await until(harness, () => harness.output().stderr.includes('sync: '));
    harness.state.folders.add('playbook');
    await tempFile(harness.root, 'agents/reviewer.ts', `${GRANTED}\n`);
    await until(harness, () => synced(harness) === 1);
  });
});

const SENTINEL = 'sentinel-orders-token';

function ordersTool(allow = `['GET /orders/*']`): string {
  return `import { openapiTool, secret } from '@indx-workspace/sdk/define';
export const orders = openapiTool({ name: 'orders', spec: 'apis/orders.openapi.json', allow: ${allow}, auth: secret('ORDERS_TOKEN') });
`;
}

function toolAgent(instructions = 'Help people.'): string {
  return `${DEFINE}import { orders } from '../tools/orders';
export default defineAgent({ name: 'assistant', instructions: '${instructions}', tools: [orders] });
`;
}

function ordersDocument(version: string): string {
  return JSON.stringify({ openapi: '3.1.0', info: { title: 'Orders', version }, paths: {} });
}

const TOOL_PROJECT = {
  'agents/assistant.ts': toolAgent(),
  'tools/orders.ts': ordersTool(),
  'apis/orders.openapi.json': ordersDocument('1'),
};

function writeIndex(harness: Harness, write: string): number {
  return writes(harness).indexOf(write);
}

/** Every file under `directory`, except the runtime's own `.agent-workspace/`. */
async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name))
    .filter((file) => !file.split(path.sep).includes('.agent-workspace'));
}

const CODE_TOOL_PROJECT = {
  'agents/assistant.ts': `${DEFINE}import getOrder from '../tools/get-order';
export default defineAgent({ name: 'assistant', instructions: 'Help people.', tools: [getOrder] });
`,
  'tools/get-order.ts': `import { defineTool, z } from '@indx-workspace/sdk/define';
export default defineTool({
  name: 'get_order',
  description: 'Look up an order',
  input: z.object({ id: z.string() }),
  run: './get-order.run.ts',
});
`,
};

describe('startDevSync registers the tool host (issue #693, ADR-0115)', () => {
  const HOST = { url: 'http://127.0.0.1:4100/tok/mcp' };

  it('creates the local-only aw-dev-tools connector before the first version', async () => {
    const harness = await start(CODE_TOOL_PROJECT, undefined, {}, HOST);
    await until(harness, () => synced(harness) === 1);
    expect(writes(harness)).toEqual(['POST /api/connectors', 'POST /api/agents']);
    const created = harness.calls.find((call) => call.method === 'POST');
    expect(created?.json).toEqual({ name: 'aw-dev-tools', transport: 'http', url: HOST.url });
  });

  it('points the connector at the new URL when aw dev starts again', async () => {
    const harness = await start(
      CODE_TOOL_PROJECT,
      (state) => {
        state.connectors.push(
          fixtures.connector({
            name: 'aw-dev-tools',
            url: 'http://127.0.0.1:1/old/mcp',
            authType: 'none',
            hasCredential: false,
          }),
        );
      },
      {},
      HOST,
    );
    await until(harness, () => synced(harness) === 1);
    expect(writes(harness)).toEqual([
      expect.stringMatching(/^PATCH \/api\/connectors\//u),
      'POST /api/agents',
    ]);
    expect(harness.state.connectors[0]?.url).toBe(HOST.url);
  });

  it.each([
    ['a credential', { authType: 'bearer', hasCredential: true }],
    ['a non-loopback URL', { url: 'https://crm.example.com/mcp' }],
  ] as const)(
    'refuses to re-point a pre-existing aw-dev-tools connector with %s',
    async (_label, overrides) => {
      const harness = await start(
        CODE_TOOL_PROJECT,
        (state) => {
          state.connectors.push(
            fixtures.connector({
              name: 'aw-dev-tools',
              url: 'http://127.0.0.1:1/old/mcp',
              authType: 'none',
              hasCredential: false,
              ...overrides,
            }),
          );
        },
        {},
        HOST,
      );
      await until(harness, () => harness.output().stderr.includes('sync: 1 problem'));
      expect(writes(harness)).toEqual([]);
      expect(harness.state.connectors[0]?.url).not.toBe(HOST.url);
      expect(harness.output().stdout).toContain(
        'tool_host_connector_conflict [connector:aw-dev-tools]',
      );
      expect(harness.output().stdout).toContain('rename or delete it');
    },
  );

  it('registers nothing when the project has no code tool', async () => {
    const harness = await start({ 'agents/assistant.ts': AGENT }, undefined, {}, HOST);
    await until(harness, () => synced(harness) === 1);
    expect(writes(harness)).toEqual(['POST /api/agents']);
  });
});

describe('startDevSync applies catalog tools (issue #549)', () => {
  it('creates the connector before the first version, and the token is in no file and no log line', async () => {
    const harness = await start(TOOL_PROJECT, undefined, { ORDERS_TOKEN: SENTINEL });
    await until(harness, () => synced(harness) === 1);
    expect(writes(harness)).toEqual(['POST /api/connectors', 'POST /api/agents']);
    const created = harness.calls.find(
      (call) => call.method === 'POST' && call.path === '/api/connectors',
    );
    expect(created?.json).toMatchObject({ kind: 'openapi', name: 'orders', credential: SENTINEL });

    const { stdout, stderr } = harness.output();
    expect(`${stdout}${stderr}`).not.toContain(SENTINEL);
    for (const file of await filesUnder(harness.root)) {
      expect(await readFile(file, 'utf8'), file).not.toContain(SENTINEL);
    }
    const carrying = harness.calls.filter((call) =>
      JSON.stringify(call.json ?? null).includes(SENTINEL),
    );
    expect(carrying).toEqual([created]);
  });

  it('updates the connector before the version push when the document and agent change', async () => {
    const harness = await start(TOOL_PROJECT, undefined, { ORDERS_TOKEN: SENTINEL });
    await until(harness, () => synced(harness) === 1);
    const connectorId = harness.state.connectors[0]?.id ?? '';

    await tempFile(harness.root, 'apis/orders.openapi.json', ordersDocument('2'));
    await tempFile(harness.root, 'agents/assistant.ts', toolAgent('Help people kindly.'));
    await until(harness, () => synced(harness) === 2);
    const patch = writeIndex(harness, `PATCH /api/connectors/${connectorId}`);
    const version = writeIndex(harness, `POST /api/agents/${IDS.agent}/versions`);
    expect(patch).toBeGreaterThan(0);
    expect(version).toBeGreaterThan(patch);
    const sent = harness.calls.find((call) => call.method === 'PATCH');
    expect(sent?.json).toMatchObject({ document: ordersDocument('2') });
  });

  it('updates the connector on a document-only edit, saving no version', async () => {
    const harness = await start(TOOL_PROJECT, undefined, { ORDERS_TOKEN: SENTINEL });
    await until(harness, () => synced(harness) === 1);

    await tempFile(harness.root, 'apis/orders.openapi.json', ordersDocument('3'));
    await until(harness, () => writes(harness).some((write) => write.startsWith('PATCH ')));
    await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_MS * 5));
    expect(first(harness).versions).toHaveLength(1);
    expect(writes(harness).filter((write) => write.startsWith('PATCH '))).toHaveLength(1);
  });

  it('updates the connector when tools/orders.ts changes its allow rules', async () => {
    const harness = await start(TOOL_PROJECT, undefined, { ORDERS_TOKEN: SENTINEL });
    await until(harness, () => synced(harness) === 1);

    await tempFile(harness.root, 'tools/orders.ts', ordersTool(`['GET /orders/*', 'GET /orders']`));
    await until(harness, () => writes(harness).some((write) => write.startsWith('PATCH ')));
    expect(harness.state.connectors[0]?.openapi?.allow).toEqual(['GET /orders/*', 'GET /orders']);
  });

  it('prints the C10 notice when ORDERS_TOKEN is unset, creates no connector and keeps running', async () => {
    const harness = await start(TOOL_PROJECT);
    await until(harness, () => synced(harness) === 1);
    expect(harness.output().stderr).toBe(
      'notice: ORDERS_TOKEN is not set: run export ORDERS_TOKEN=… in the shell aw dev started from, then restart aw dev\n',
    );
    expect(writes(harness)).toEqual(['POST /api/agents']);

    await tempFile(harness.root, 'agents/assistant.ts', toolAgent('Help people again.'));
    await until(harness, () => synced(harness) === 2);
    expect(harness.fatal).toEqual([]);
    expect(harness.output().stderr).toBe(
      'notice: ORDERS_TOKEN is not set: run export ORDERS_TOKEN=… in the shell aw dev started from, then restart aw dev\n',
    );
  });

  it('refuses a tool whose name an MCP connector holds, and pushes no agent', async () => {
    const harness = await start(
      TOOL_PROJECT,
      (state) => {
        state.connectors.push(fixtures.connector({ name: 'orders' }));
      },
      { ORDERS_TOKEN: SENTINEL },
    );
    await until(harness, () => harness.output().stderr.includes('sync: '));
    expect(harness.output().stdout).toBe(
      'tools/orders.ts: local tool_refused [a connector of this name exists as http, not openapi; rename one]\n',
    );
    expect(writes(harness)).toEqual([]);
    expect(harness.fatal).toEqual([]);
  });
});
