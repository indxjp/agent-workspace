import { createHash } from 'node:crypto';
import { mkdir, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  CreateAgentFromVersionRequestSchema,
  CreateAgentVersionRequestSchema,
  AgentVersionResourceSchema,
  SetAgentPointerRequestSchema,
  UploadToolBundleRequestSchema,
  type AgentVersionBody,
  type AgentVersionResource,
} from '@indx-workspace/contracts/agent-versions';
import type { AgentResource } from '@indx-workspace/contracts/agents';
import type { ConnectorResource } from '@indx-workspace/contracts/connectors';
import { fixtures } from '@indx-workspace/sdk/testing';
import { afterAll, describe, expect, it, vi } from 'vitest';

import type { CliIo } from '../io.js';
import { EXIT_CODE } from '../output.js';
import { loadProject } from '../project/index.js';
import {
  FIXTURES,
  IDS,
  json,
  runCli,
  stdoutJson,
  tempDirectory,
  tempFile,
  type CliRun,
  type Route,
} from '../testing.js';

// These tests run the real project loader, a forked Node process that evaluates the definition
// files: a second or more each on a shared CI runner, past vitest's 5 s default when several run.
vi.setConfig({ testTimeout: 30_000 });

type RecordedRequest = Parameters<Route>[0];

const AT = '2026-10-02T10:00:00.000Z';
const DEFINE = `import { defineAgent, defineSurface, mcp } from '@indx-workspace/sdk/define';\n`;

/** `agents/assistant.ts` as `aw init` writes it, with `extra` added to the definition. */
function agentFile(extra = '', name = 'assistant'): string {
  return `${DEFINE}
export default defineAgent({ name: '${name}', instructions: 'Help people.'${extra} });
`;
}

function surfaceFile(name: string, agent = 'assistant'): string {
  return `${DEFINE}
export default defineSurface({ name: '${name}', agent: '${agent}', title: 'Ask us' });
`;
}

const directories: string[] = [];

afterAll(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/** A temporary project holding `files` (paths relative to its root). */
async function project(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await tempDirectory();
  directories.push(root);
  for (const [file, contents] of Object.entries(files)) await tempFile(root, file, contents);
  return root;
}

/** What the fetch double holds between calls: one agent, its versions and its `local` pointer. */
interface ServerState {
  agent: AgentResource | null;
  versions: AgentVersionResource[];
  local: number | null;
  /** The version the agent row was last written from; `null` after an edit outside versions. */
  materialised: number | null;
  /** The digests of the tool bundles uploaded so far (issue #790). */
  bundles: Set<string>;
  /** The workspace's connectors: the tool host's, which a push with code tools makes. */
  connectors: ConnectorResource[];
}

function emptyServer(): ServerState {
  return {
    agent: null,
    versions: [],
    local: null,
    materialised: null,
    bundles: new Set(),
    connectors: [],
  };
}

/** The server's step 4b: a version that pins a bundle the workspace has not got is refused. */
function unknownBundles(state: ServerState, body: AgentVersionBody): Response | null {
  const missing = (body.toolBundles ?? [])
    .map(({ digest }) => digest)
    .filter((digest) => !state.bundles.has(digest));
  return missing.length === 0
    ? null
    : problem(
        422,
        'tool_bundle_unknown',
        missing.map((digest) => `tool_bundle:${digest}`),
      );
}

function isDryRun(body: unknown): boolean {
  return typeof body === 'object' && body !== null && 'dryRun' in body && body.dryRun === true;
}

function problem(status: number, code: string, details: readonly string[] = []): Response {
  return json(status, { error: { code, message: `refused: ${code}`, details } });
}

function versionOf(
  state: ServerState,
  draft: { readonly body: unknown; readonly summary: string; readonly via: string },
): AgentVersionResource {
  const number = state.versions.length + 1;
  // The double stores what was sent; the SDK parses it back with the contract on every read.
  return AgentVersionResourceSchema.parse({
    id: `v-${String(number)}`,
    agentId: IDS.agent,
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
 * A stateful control plane: `/api/agents` lists, dry-runs and creates from a version, and
 * `/api/agents/:id/{versions,pointers}` save versions and move `local`. The three reads of
 * `aw.agents.export` answer the agent with no assignment.
 */
function server(state: ServerState): Route {
  const agentPath = `/api/agents/${IDS.agent}`;
  return (request: RecordedRequest) => {
    const route = `${request.method} ${request.url.pathname}`;
    if (route === 'GET /api/agents') {
      return json(200, { agents: state.agent === null ? [] : [state.agent] });
    }
    if (route === 'GET /api/connectors') return json(200, { connectors: state.connectors });
    if (route === 'POST /api/connectors') {
      const body = request.json as { name: string; url: string };
      const created = fixtures.connector({
        id: IDS.connection,
        name: body.name,
        url: body.url,
        authType: 'none',
        hasCredential: false,
      });
      state.connectors.push(created);
      return json(201, created);
    }
    if (route === 'POST /api/tool-bundles') {
      const { contentBase64 } = UploadToolBundleRequestSchema.parse(request.json);
      const bytes = Buffer.from(contentBase64, 'base64');
      const digest = createHash('sha256').update(bytes).digest('hex');
      const created = !state.bundles.has(digest);
      state.bundles.add(digest);
      return json(created ? 201 : 200, { bundle: { digest, sizeBytes: bytes.length }, created });
    }
    if (request.method === 'GET' && request.url.pathname.startsWith('/api/tool-bundles/')) {
      const digest = request.url.pathname.slice('/api/tool-bundles/'.length);
      return state.bundles.has(digest)
        ? json(200, { bundle: { digest, sizeBytes: 1 } })
        : problem(404, 'tool_bundle_not_found');
    }
    if (route === 'POST /api/agents') {
      const body = CreateAgentFromVersionRequestSchema.parse(request.json);
      const unknown = unknownBundles(state, body.version.body);
      if (unknown !== null) return unknown;
      if (body.dryRun === true) return json(200, { ok: true, number: 1 });
      const agent = {
        ...FIXTURES.agent,
        modelConnectionId: null,
        name: body.version.body.definition.agent.name,
      };
      const version = versionOf(state, body.version);
      state.agent = agent;
      state.versions.push(version);
      state.local = version.number;
      state.materialised = version.number;
      return json(201, { agent, version });
    }
    if (route === `POST ${agentPath}/versions`) {
      const body = CreateAgentVersionRequestSchema.parse(request.json);
      const unknown = unknownBundles(state, body.body);
      if (unknown !== null) return unknown;
      if (body.dryRun === true) {
        return json(200, { ok: true, number: state.versions.length + 1 });
      }
      const version = versionOf(state, body);
      state.versions.push(version);
      return json(201, version);
    }
    if (route === `GET ${agentPath}/versions`) {
      return json(200, {
        items: state.versions,
        pointers:
          state.local === null
            ? []
            : [{ environment: 'local', number: state.local, updatedAt: AT }],
        materialised: state.materialised,
      });
    }
    if (route === `PUT ${agentPath}/pointers`) {
      const body = SetAgentPointerRequestSchema.parse(request.json);
      state.local = body.version;
      state.materialised = body.version;
      return json(200, {
        agent: state.agent,
        pointer: { environment: 'local', number: body.version, updatedAt: AT },
      });
    }
    if (route === `GET ${agentPath}`) return json(200, state.agent);
    if (route === `GET ${agentPath}/policy`) return json(200, { policy: FIXTURES.policy });
    if (route === `GET ${agentPath}/resources`) {
      return json(200, { assignments: { files: [], skillIds: [], connectorIds: [] } });
    }
    return problem(404, 'not_found');
  };
}

/** An agent that lists one code tool, whose run file imports another module. */
const CODE_TOOL_PROJECT = {
  'agents/assistant.ts': `import { defineAgent } from '@indx-workspace/sdk/define';
import getOrder from '../tools/get-order.ts';
export default defineAgent({ name: 'assistant', instructions: 'Help.', tools: [getOrder] });
`,
  'tools/get-order.ts': `import { defineTool, z } from '@indx-workspace/sdk/define';
export default defineTool({
  name: 'get_order',
  description: 'Look up an order',
  input: z.object({ id: z.string() }),
  run: './tools/get-order.run.ts',
});
`,
  'tools/get-order.run.ts': `import { shout } from './shout.ts';
export default ({ id }: { id: string }) => shout(id);
`,
  'tools/shout.ts': 'export const shout = (text: string): string => text.toUpperCase();\n',
};

/** Every request that is neither a read nor a dry run. */
function writes(run: CliRun): readonly string[] {
  return run.calls
    .filter((call) => call.method !== 'GET' && !(call.method === 'POST' && isDryRun(call.json)))
    .map((call) => `${call.method} ${call.url.pathname}`);
}

function requests(run: CliRun): readonly string[] {
  return run.calls.map((call) => `${call.method} ${call.url.pathname}`);
}

/** Run `aw <argv>` in `root` against `route`. */
function aw(
  root: string,
  argv: readonly string[],
  route: Route = server(emptyServer()),
  extra: { readonly env?: Readonly<Record<string, string>>; readonly homeDir?: string } = {},
) {
  return runCli(argv, { cwd: root, route, ...extra });
}

/** The instructions `aw check` sent for its first agent. */
function sentInstructions(run: CliRun): string {
  return CreateAgentFromVersionRequestSchema.parse(run.calls[1]?.json).version.body.definition.agent
    .instructions;
}

describe('aw check', () => {
  it('dry-runs a new agent through POST /api/agents and prints the number it would get', async () => {
    const root = await project({
      'agents/assistant.ts': agentFile(),
      'surfaces/main.ts': surfaceFile('main'),
    });
    const run = await aw(root, ['check']);
    expect(run.stderr).toBe('');
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.stdout).toBe('agents/assistant.ts: ok (would be version 1)\n');
    expect(requests(run)).toEqual(['GET /api/agents', 'POST /api/agents']);
    const sent = CreateAgentFromVersionRequestSchema.parse(run.calls[1]?.json);
    expect(sent.dryRun).toBe(true);
    expect(sent.version.via).toBe('aw-push');
    expect(sent.version.summary).toBe('aw push: agents/assistant.ts');
    expect(sent.version.body.definition.agent.instructions).toBe('Help people.');
    expect(sent.version.body.surfaces).toEqual([
      { name: 'main', agent: 'assistant', title: 'Ask us' },
    ]);
  });

  it('reports each tool before the agents, a code tool as (code), and the bundle a push would upload', async () => {
    const root = await project(CODE_TOOL_PROJECT);
    const state = emptyServer();
    const run = await aw(root, ['check'], server(state));
    expect(run.stderr).toBe('');
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.stdout).toMatch(
      /^tools\/get-order\.ts: get_order \(code\) ok\ntools\/get-order\.ts: tool bundle "get_order" \(\d+ bytes, sha256 [0-9a-f]{64}\) would be uploaded\nagents\/assistant\.ts: ok \(would be version 1\)\n$/u,
    );
    expect(writes(run)).toEqual([]);
    expect(state.bundles.size).toBe(0);
    const sent = CreateAgentFromVersionRequestSchema.parse(
      run.calls.find((call) => call.method === 'POST')?.json,
    );
    expect(sent.version.body.toolBundles?.map(({ tool }) => tool)).toEqual(['get_order']);
    expect(sent.version.body.toolBundles?.[0]?.digest).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('dry-runs an agent the workspace has through its versions route', async () => {
    const state = emptyServer();
    const root = await project({ 'agents/assistant.ts': agentFile() });
    expect((await aw(root, ['push', '--yes'], server(state))).code).toBe(EXIT_CODE.ok);
    const run = await aw(root, ['check', '--json'], server(state));
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(requests(run)).toEqual([
      'GET /api/agents',
      `POST /api/agents/${IDS.agent}/versions`,
      `GET /api/agents/${IDS.agent}/versions`,
    ]);
    expect(writes(run)).toEqual([]);
    expect(stdoutJson(run)).toEqual({
      ok: true,
      problems: [],
      tools: [],
      agents: [
        {
          file: 'agents/assistant.ts',
          name: 'assistant',
          agentId: IDS.agent,
          action: 'none',
          version: 1,
          local: { from: 1, to: 1 },
        },
      ],
    });
  });

  it('says an agent pushed unchanged is unchanged, as aw push does (#559)', async () => {
    const state = emptyServer();
    const root = await project({ 'agents/assistant.ts': agentFile() });
    expect((await aw(root, ['push', '--yes'], server(state))).code).toBe(EXIT_CODE.ok);
    const run = await aw(root, ['check'], server(state));
    expect(run.stderr).toBe('');
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.stdout).toBe('agents/assistant.ts: ok (unchanged, local 1)\n');
    expect(requests(run)).toEqual([
      'GET /api/agents',
      `POST /api/agents/${IDS.agent}/versions`,
      `GET /api/agents/${IDS.agent}/versions`,
    ]);
    expect(writes(run)).toEqual([]);
    const push = await aw(root, ['push'], server(state));
    expect(push.stdout).toBe('agents/assistant.ts: "assistant" is unchanged (local 1)\n');

    await tempFile(
      root,
      'agents/assistant.ts',
      agentFile().replace('Help people.', 'Help people kindly.'),
    );
    expect((await aw(root, ['push', '--yes'], server(state))).code).toBe(EXIT_CODE.ok);
    expect(state.versions).toHaveLength(2);
    const again = await aw(root, ['check'], server(state));
    expect(again.code).toBe(EXIT_CODE.ok);
    expect(again.stdout).toBe('agents/assistant.ts: ok (unchanged, local 2)\n');
    expect(writes(again)).toEqual([]);
  });

  it('prints the version a changed body would be saved as, the one aw push plans', async () => {
    const state = emptyServer();
    const root = await project({ 'agents/assistant.ts': agentFile() });
    expect((await aw(root, ['push', '--yes'], server(state))).code).toBe(EXIT_CODE.ok);
    await tempFile(
      root,
      'agents/assistant.ts',
      agentFile().replace('Help people.', 'Help people kindly.'),
    );
    const run = await aw(root, ['check'], server(state));
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.stdout).toBe('agents/assistant.ts: ok (would be version 2)\n');
    expect(writes(run)).toEqual([]);
    const push = await aw(root, ['push', '--json'], server(state));
    expect(stdoutJson(push)).toMatchObject({
      agents: [{ action: 'version', version: 2, local: { from: 1, to: 2 } }],
    });
  });

  it('says local would move to a newer version that already holds the body', async () => {
    const state = emptyServer();
    const root = await project({ 'agents/assistant.ts': agentFile() });
    expect((await aw(root, ['push', '--yes'], server(state))).code).toBe(EXIT_CODE.ok);
    const first = state.versions[0];
    if (first === undefined) throw new Error('the first push saved no version');
    state.versions.push({ ...first, id: 'v-2', number: 2 });
    state.local = 1;
    const run = await aw(root, ['check'], server(state));
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.stdout).toBe(
      'agents/assistant.ts: ok (version 2 already holds this definition; local would move from 1 to 2)\n',
    );
    expect(writes(run)).toEqual([]);
    const push = await aw(root, ['push', '--json'], server(state));
    expect(stdoutJson(push)).toMatchObject({
      agents: [{ action: 'point', version: 2, local: { from: 1, to: 2 } }],
    });
  });

  it('says a version would be applied again over an edit made outside aw push', async () => {
    const state = emptyServer();
    const root = await project({ 'agents/assistant.ts': agentFile() });
    expect((await aw(root, ['push', '--yes'], server(state))).code).toBe(EXIT_CODE.ok);
    if (state.agent === null) throw new Error('the first push created no agent');
    state.agent = { ...state.agent, updatedAt: '2026-10-03T00:00:00.000Z' };
    state.materialised = null;
    const run = await aw(root, ['check'], server(state));
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.stdout).toBe(
      'agents/assistant.ts: ok (edited outside aw push; version 1 would be applied again)\n',
    );
    expect(writes(run)).toEqual([]);
  });

  it('reports a refused versions read as a problem on that file, and exits 1', async () => {
    const state = emptyServer();
    const root = await project({ 'agents/assistant.ts': agentFile() });
    expect((await aw(root, ['push', '--yes'], server(state))).code).toBe(EXIT_CODE.ok);
    const allowed = server(state);
    const run = await aw(root, ['check'], (request) =>
      request.method === 'GET' && request.url.pathname === `/api/agents/${IDS.agent}/versions`
        ? problem(403, 'forbidden')
        : allowed(request),
    );
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stdout).toBe('agents/assistant.ts: 403 forbidden\n');
    expect(run.stderr).toBe('error: 1 problem\n');
    expect(writes(run)).toEqual([]);
  });

  it('prints the 422 of an mcp() tool on an engine without mcp, and exits 1', async () => {
    const root = await project({ 'agents/assistant.ts': agentFile(", tools: [mcp('github')]") });
    const run = await aw(root, ['check'], (request) =>
      request.method === 'GET'
        ? json(200, { agents: [] })
        : problem(422, 'engine_capability_unsupported', ['mcp']),
    );
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stdout).toBe('agents/assistant.ts: 422 engine_capability_unsupported [mcp]\n');
    expect(run.stderr).toBe('error: 1 problem\n');
  });

  it("prints a Viewer's 403, and exits 1", async () => {
    const root = await project({ 'agents/assistant.ts': agentFile() });
    const run = await aw(root, ['check'], (request) =>
      request.method === 'GET' ? json(200, { agents: [] }) : problem(403, 'forbidden'),
    );
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stdout).toBe('agents/assistant.ts: 403 forbidden\n');
  });

  it('refuses a model id its connection does not offer, before any dry run (BH061-019)', async () => {
    const root = await project({
      'agents/assistant.ts': agentFile(", model: { connection: 'anthropic', id: 'claude-y' }"),
    });
    const inner = server(emptyServer());
    const run = await aw(root, ['check'], (request) => {
      const { pathname } = request.url;
      if (pathname === '/api/model-connections') {
        return json(200, { models: [FIXTURES.modelConnection] });
      }
      if (pathname === '/api/models') return json(200, { models: [FIXTURES.discoveredModel] });
      return inner(request);
    });
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stdout).toBe(
      "agents/assistant.ts: local model_not_found [model 'claude-y' is not offered by the connection 'anthropic' (did you mean 'claude-x'?)]\n",
    );
    expect(requests(run)).not.toContain('POST /api/agents');
  });

  it('says how to name a model when model: names a connection the workspace lacks (BH061-019)', async () => {
    const root = await project({
      'agents/assistant.ts': agentFile(", model: 'claude-haiku-4-5'"),
    });
    const run = await aw(root, ['check'], (request) =>
      request.method === 'GET'
        ? json(200, { agents: [] })
        : missingReferences(['model-connection:claude-haiku-4-5']),
    );
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stdout).toBe(
      "agents/assistant.ts: 422 agent_definition_references_missing [model-connection:claude-haiku-4-5]; model: 'claude-haiku-4-5' names a model connection the workspace lacks; to choose a model, write model: { connection: 'default', id: 'claude-haiku-4-5' }\n",
    );
  });

  it("attributes a server's surfaces.<i> issue to that surface's file", async () => {
    const root = await project({
      'agents/assistant.ts': agentFile(),
      'surfaces/a.ts': surfaceFile('a'),
      'surfaces/b.ts': surfaceFile('b'),
    });
    const run = await aw(root, ['check', '--json'], (request) =>
      request.method === 'GET'
        ? json(200, { agents: [] })
        : problem(400, 'invalid_agent_version', [
            'surfaces.1.theme: is not a theme',
            'definition.agent.name: is taken',
          ]),
    );
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(stdoutJson(run)).toMatchObject({
      ok: false,
      problems: [
        {
          file: 'surfaces/b.ts',
          status: 400,
          code: 'invalid_agent_version',
          details: ['surfaces.1.theme: is not a theme'],
        },
        {
          file: 'agents/assistant.ts',
          status: 400,
          code: 'invalid_agent_version',
          details: ['definition.agent.name: is taken'],
        },
      ],
    });
  });

  it('refuses an enum with Node’s reason, before any request', async () => {
    const root = await project({
      'agents/assistant.ts': `${agentFile()}\nenum Tone { Calm }\n`,
    });
    const run = await aw(root, ['check']);
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stdout).toBe(
      '✗ agents/assistant.ts:5:1  TypeScript enum is not supported in strip-only mode\n',
    );
    expect(run.calls).toEqual([]);
  });

  it('refuses a file with no default export, and one whose export is not a definition', async () => {
    const root = await project({
      'agents/assistant.ts': `${DEFINE}\nexport const agent = 1;\n`,
      'agents/other.ts': `export default { name: 'other', instructions: 'x' };\n`,
      'surfaces/main.ts': `export default { name: 'main', agent: 'assistant' };\n`,
    });
    const run = await aw(root, ['check']);
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stdout.split('\n')).toEqual([
      'agents/assistant.ts: local default_export_missing [the file must `export default` its definition]',
      'agents/other.ts: local not_a_definition [the default export must be made by defineAgent()]',
      'surfaces/main.ts: local not_a_definition [the default export must be made by defineSurface()]',
      '',
    ]);
    expect(run.stderr).toBe('error: 3 problems\n');
    expect(run.calls).toEqual([]);
  });

  it('refuses every import but the define subpath, static or dynamic', async () => {
    const root = await project({
      'agents/assistant.ts': `import { readFileSync } from 'node:fs';\n${agentFile()}`,
      'agents/helper.ts': `import { x } from './shared.ts';\n${agentFile('', 'helper')}`,
      'agents/dynamic.ts': `await import('node:fs');\n${agentFile('', 'dynamic')}`,
    });
    const run = await aw(root, ['check']);
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stdout.split('\n')).toEqual([
      'agents/assistant.ts: local import_refused [node:fs]',
      'agents/dynamic.ts: local import_refused [import()]',
      'agents/helper.ts: local import_refused [./shared.ts]',
      '',
    ]);
    expect(run.calls).toEqual([]);
  });

  it('reports a DefinitionError as the 400 the server would give', async () => {
    const root = await project({
      'agents/assistant.ts': agentFile(", permissions: { readFiles: 'yes' }"),
    });
    const run = await aw(root, ['check', '--json']);
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(stdoutJson(run)).toMatchObject({
      ok: false,
      problems: [{ file: 'agents/assistant.ts', status: 400, code: 'invalid_agent_version' }],
    });
    expect(run.calls).toEqual([]);
  });

  it('reads .md instructions beside the file, and refuses a missing or escaping one', async () => {
    const root = await project({
      'agents/assistant.ts': agentFile().replace(
        "instructions: 'Help people.'",
        "instructions: { file: './assistant.md' }",
      ),
      'agents/assistant.md': '# Be kind\n',
      'agents/missing.ts': agentFile('', 'missing').replace(
        "instructions: 'Help people.'",
        "instructions: { file: './missing.md' }",
      ),
      'agents/linked.ts': agentFile('', 'linked').replace(
        "instructions: 'Help people.'",
        "instructions: { file: './outside/secret.md' }",
      ),
    });
    const outside = await tempDirectory();
    directories.push(outside);
    await tempFile(outside, 'secret.md', 'not the project’s\n');
    // A junction needs no privilege on Windows; elsewhere the type is ignored.
    await symlink(outside, path.join(root, 'agents', 'outside'), 'junction');
    const run = await aw(root, ['check']);
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stdout.split('\n')).toEqual([
      'agents/assistant.ts: ok (would be version 1)',
      'agents/linked.ts: local instructions_unreadable [./outside/secret.md is outside the project]',
      'agents/missing.ts: local instructions_unreadable [./missing.md]',
      '',
    ]);
    const sent = CreateAgentFromVersionRequestSchema.parse(run.calls[1]?.json);
    expect(sent.version.body.definition.agent.instructions).toBe('# Be kind\n');
  });

  it('refuses a surface naming an unknown agent, and duplicate surface and agent names', async () => {
    const root = await project({
      'agents/a.ts': agentFile(),
      'agents/b.ts': agentFile(),
      'surfaces/main.ts': surfaceFile('main'),
      'surfaces/other.ts': surfaceFile('main'),
      'surfaces/stray.ts': surfaceFile('stray', 'nobody'),
    });
    const run = await aw(root, ['check']);
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stdout.split('\n')).toEqual([
      'agents/b.ts: local agent_name_duplicate [assistant]',
      'surfaces/other.ts: local surface_name_duplicate [main]',
      'surfaces/stray.ts: local surface_agent_unknown [nobody]',
      '',
    ]);
    expect(run.calls).toEqual([]);
  });

  it('sends the files’ console output to stderr, keeping --json clean', async () => {
    const root = await project({
      'agents/assistant.ts': `console.log('hello from the agent');\n${agentFile()}`,
    });
    const run = await aw(root, ['check', '--json']);
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.stderr).toContain('hello from the agent');
    expect(stdoutJson(run)).toMatchObject({ ok: true });
  });

  it('refuses a directory with no agents/*.ts', async () => {
    const root = await project({ 'surfaces/main.ts': surfaceFile('main') });
    const run = await aw(root, ['check']);
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toContain('no agents/*.ts in this directory');
    expect(run.calls).toEqual([]);
  });

  it('withholds the API key from the definition files', async () => {
    const root = await project({
      'agents/assistant.ts': `console.error('key=' + String(process.env.AGENT_WORKSPACE_API_KEY));\n${agentFile()}`,
    });
    const run = await aw(root, ['check']);
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.stderr).toContain('key=undefined');
  });

  it("withholds every profile's apiKeyRef variable from the definition files", async () => {
    const home = await tempDirectory();
    directories.push(home);
    await tempFile(
      home,
      '.config/agent-workspace/profiles.json',
      JSON.stringify({ prod: { url: 'https://prod.example.com', apiKeyRef: 'AW_PROD_KEY' } }),
    );
    const root = await project({
      'agents/assistant.ts': `console.error('prod=' + String(process.env.AW_PROD_KEY) + ' other=' + String(process.env.AW_OTHER));\n${agentFile()}`,
    });
    const run = await aw(root, ['check'], server(emptyServer()), {
      homeDir: home,
      env: {
        AGENT_WORKSPACE_URL: 'https://aw.example.com',
        AGENT_WORKSPACE_API_KEY: 'ak_live_test',
        AW_PROD_KEY: 'ak_live_profile_ref',
        AW_OTHER: 'kept',
      },
    });
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.stderr).toContain('prod=undefined other=kept');
  });

  it('gives import.meta the url, filename and dirname node gives a module', async () => {
    const root = await project({
      'agents/assistant.ts': agentFile().replace(
        "instructions: 'Help people.'",
        "instructions: [import.meta.url, import.meta.filename, import.meta.dirname].join('|')",
      ),
    });
    const run = await aw(root, ['check']);
    expect(run.code).toBe(EXIT_CODE.ok);
    const file = path.join(root, 'agents', 'assistant.ts');
    expect(sentInstructions(run)).toBe(
      [pathToFileURL(file).href, file, path.join(root, 'agents')].join('|'),
    );
  });

  it('reads an instructions file in the project whose name starts with two dots', async () => {
    const root = await project({
      'agents/assistant.ts': agentFile().replace(
        "instructions: 'Help people.'",
        "instructions: { file: './up/..prompt.md' }",
      ),
      '..prompt.md': 'From the root.\n',
    });
    // The SDK refuses a `..` segment, so only a link reaches the root; a junction needs no privilege.
    await symlink(root, path.join(root, 'agents', 'up'), 'junction');
    const run = await aw(root, ['check']);
    expect(run.stdout).toBe('agents/assistant.ts: ok (would be version 1)\n');
    expect(sentInstructions(run)).toBe('From the root.\n');
  });

  it('follows a linked definition file inside the project and refuses the others', async () => {
    const root = await project({
      'agents/assistant.ts': agentFile(),
      'shared/helper.ts': agentFile('', 'helper'),
    });
    const outside = await tempDirectory();
    directories.push(outside);
    await tempFile(outside, 'far.ts', agentFile('', 'far'));
    await mkdir(path.join(root, 'shared', 'folder.ts'));
    await symlink(
      path.join(root, 'shared', 'helper.ts'),
      path.join(root, 'agents', 'helper.ts'),
      'file',
    );
    await symlink(path.join(outside, 'far.ts'), path.join(root, 'agents', 'far.ts'), 'file');
    await symlink(path.join(root, 'missing.ts'), path.join(root, 'agents', 'gone.ts'), 'file');
    // A junction needs no privilege on Windows; elsewhere the type is ignored.
    await symlink(
      path.join(root, 'shared', 'folder.ts'),
      path.join(root, 'agents', 'folder.ts'),
      'junction',
    );
    const run = await aw(root, ['check', '--json']);
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(stdoutJson(run)).toEqual({
      ok: false,
      problems: [
        {
          file: 'agents/far.ts',
          status: null,
          code: 'file_link_refused',
          details: ['the link points outside the project'],
        },
        {
          file: 'agents/folder.ts',
          status: null,
          code: 'file_link_refused',
          details: ["the link's target is not a file"],
        },
        {
          file: 'agents/gone.ts',
          status: null,
          code: 'file_link_refused',
          details: ["the link's target does not exist"],
        },
      ],
      tools: [],
      agents: [
        {
          file: 'agents/assistant.ts',
          name: 'assistant',
          agentId: null,
          action: 'create',
          version: 1,
          local: { from: null, to: 1 },
        },
        {
          file: 'agents/helper.ts',
          name: 'helper',
          agentId: null,
          action: 'create',
          version: 1,
          local: { from: null, to: 1 },
        },
      ],
    });
  });

  it('refuses a file name the loader cannot be handed, and still checks the others', async () => {
    const root = await project({
      'agents/assistant.ts': agentFile(),
      'surfaces/a\u200db.ts': surfaceFile('main'),
    });
    const run = await aw(root, ['check']);
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stdout.split('\n')).toEqual([
      'agents/assistant.ts: ok (would be version 1)',
      'surfaces/a\u200db.ts: local file_name_unsupported [the name must not contain a control or format character, a backslash or a colon]',
      '',
    ]);
  });

  it.each([
    [4000, 'gateway'],
    [8080, 'runner'],
  ] as const)(
    "refuses a project file on the runtime's %i port (its %s) at its line, before any request (issue #560)",
    async (port, service) => {
      const root = await project({
        'agent-workspace.yaml': [
          'apiVersion: agentworkspace.dev/v2',
          'kind: Project',
          'name: demo',
          'environments:',
          '  local:',
          '    cloud: local',
          '    identity:',
          '      bootstrapAdmin: admin@localhost.test',
          `    port: ${String(port)}`,
          '',
        ].join('\n'),
        'agents/assistant.ts': agentFile(),
      });
      // No URL from the flags or the environment, so the project step reads the file.
      const run = await aw(root, ['check'], server(emptyServer()), { env: {} });
      expect(run.code).toBe(EXIT_CODE.usage);
      expect(run.stderr.split('\n')[0]).toBe(
        `error: agent-workspace.yaml:9:5: environments.local.port is reserved by the local runtime's ${service} (${String(port)}); choose another port`,
      );
      expect(run.calls).toEqual([]);
    },
  );

  it('cuts the default summary of a long file name to the contract length', async () => {
    const name = 'a'.repeat(190);
    const root = await project({ [`agents/${name}.ts`]: agentFile() });
    const run = await aw(root, ['check']);
    expect(run.code).toBe(EXIT_CODE.ok);
    const sent = CreateAgentFromVersionRequestSchema.parse(run.calls[1]?.json);
    expect(sent.version.summary).toHaveLength(200);
    expect(sent.version.summary).toBe(`aw push: agents/${name.slice(0, 183)}…`);
  });
});

describe('loadProject', () => {
  const io: CliIo = {
    stdin: () => Promise.resolve(''),
    stdout: () => undefined,
    stderr: () => undefined,
    env: {},
    homeDir: 'C:/nonexistent-home',
    fetch: () => Promise.reject(new Error('no network')),
    isTty: false,
  };

  it('refuses when Node runs with type stripping turned off, naming the version', async () => {
    const root = await project({ 'agents/assistant.ts': agentFile() });
    const load = await loadProject({
      root,
      io,
      signal: new AbortController().signal,
      features: { typescript: false },
    });
    expect(load.agents).toEqual([]);
    expect(load.problems).toEqual([
      {
        file: '.',
        status: null,
        code: 'typescript_unavailable',
        details: [expect.stringContaining(process.version)],
      },
    ]);
  });

  it('kills a file that never finishes loading', async () => {
    const root = await project({
      'agents/assistant.ts': `setInterval(() => undefined, 1000);\nawait new Promise(() => undefined);\n${agentFile()}`,
    });
    const load = await loadProject({
      root,
      io,
      signal: new AbortController().signal,
      timeoutMs: 1500,
    });
    expect(load.problems).toMatchObject([
      { file: 'agents/assistant.ts', status: null, code: 'loader_timeout' },
    ]);
  });

  it('names a file whose top-level await never settles, or that exits the loader', async () => {
    const root = await project({
      'agents/a.ts': agentFile('', 'a'),
      'agents/b.ts': `await new Promise(() => undefined);\n${agentFile('', 'b')}`,
    });
    const load = await loadProject({ root, io, signal: new AbortController().signal });
    expect(load.problems).toMatchObject([
      { file: 'agents/b.ts', status: null, code: 'module_unfinished' },
    ]);
    const exits = await project({
      'agents/a.ts': agentFile('', 'a'),
      'surfaces/main.ts': `process.exit(0);\n${surfaceFile('main', 'a')}`,
    });
    const exited = await loadProject({ root: exits, io, signal: new AbortController().signal });
    expect(exited.problems).toMatchObject([
      { file: 'surfaces/main.ts', status: null, code: 'module_unfinished' },
    ]);
  });

  it('ignores declaration files and directories', async () => {
    const root = await project({
      'agents/assistant.ts': agentFile(),
      'agents/types.d.ts': 'export type X = 1;\n',
    });
    await mkdir(path.join(root, 'agents', 'nested.ts'));
    const load = await loadProject({ root, io, signal: new AbortController().signal });
    expect(load.problems).toEqual([]);
    expect(load.agents.map((agent) => agent.file)).toEqual(['agents/assistant.ts']);
  });
});

describe('aw push', () => {
  it('without --yes, shows the plan and sends only reads and dry runs', async () => {
    const root = await project({ 'agents/assistant.ts': agentFile() });
    const run = await aw(root, ['push']);
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(writes(run)).toEqual([]);
    expect(run.stdout).toBe(
      [
        'agents/assistant.ts: create "assistant" at version 1 (local none → 1)',
        '  + (root)',
        '',
      ].join('\n'),
    );
    expect(run.stderr).toContain('nothing was saved');
  });

  it('with --yes, creates a new agent from its first version and sends no PUT', async () => {
    const state = emptyServer();
    const root = await project({ 'agents/assistant.ts': agentFile() });
    const run = await aw(root, ['push', '--yes', '--json'], server(state));
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(writes(run)).toEqual(['POST /api/agents']);
    expect(stdoutJson(run)).toEqual({
      saved: true,
      problems: [],
      agents: [
        {
          file: 'agents/assistant.ts',
          name: 'assistant',
          agentId: IDS.agent,
          action: 'create',
          version: 1,
          local: { from: null, to: 1 },
          changes: [{ op: '+', path: '(root)' }],
          saved: true,
          surfaces: [],
        },
      ],
    });
    expect(state.local).toBe(1);
  });

  it("names each agent's surfaces in body order, the names aw dev prints lines for", async () => {
    const root = await project({
      'agents/assistant.ts': agentFile(),
      'surfaces/b.ts': surfaceFile('zeta'),
      'surfaces/a.ts': surfaceFile('alpha'),
    });
    const run = await aw(root, ['push', '--json']);
    expect(run.code, run.stderr).toBe(EXIT_CODE.ok);
    expect(stdoutJson(run)).toMatchObject({ agents: [{ surfaces: ['alpha', 'zeta'] }] });
  });

  it('a second push --yes of an unchanged body saves nothing and sends no PUT', async () => {
    const state = emptyServer();
    const root = await project({ 'agents/assistant.ts': agentFile() });
    expect((await aw(root, ['push', '--yes'], server(state))).code).toBe(EXIT_CODE.ok);
    const run = await aw(root, ['push', '--yes'], server(state));
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(writes(run)).toEqual([]);
    expect(state.versions).toHaveLength(1);
    expect(run.stdout).toBe('agents/assistant.ts: "assistant" is unchanged (local 1)\n');
  });

  it('applies the newest version again when the agent was edited after local moved', async () => {
    const state = emptyServer();
    const root = await project({ 'agents/assistant.ts': agentFile() });
    expect((await aw(root, ['push', '--yes'], server(state))).code).toBe(EXIT_CODE.ok);
    // A legacy edit (the UI, PATCH) moves the agent row after the pointer, and saves no version.
    if (state.agent === null) throw new Error('the first push created no agent');
    state.agent = { ...state.agent, updatedAt: '2026-10-03T00:00:00.000Z' };
    state.materialised = null;
    const plan = await aw(root, ['push'], server(state));
    expect(writes(plan)).toEqual([]);
    expect(plan.stdout).toBe(
      'agents/assistant.ts: "assistant" was edited outside aw push; version 1 is applied again (local 1 → 1)\n',
    );
    const run = await aw(root, ['push', '--yes', '--json'], server(state));
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(writes(run)).toEqual([`PUT /api/agents/${IDS.agent}/pointers`]);
    expect(SetAgentPointerRequestSchema.parse(run.calls.at(-1)?.json)).toEqual({
      environment: 'local',
      version: 1,
    });
    expect(state.versions).toHaveLength(1);
    expect(stdoutJson(run)).toMatchObject({
      saved: true,
      agents: [
        {
          action: 'point',
          version: 1,
          local: { from: 1, to: 1 },
          changes: [],
          saved: true,
          surfaces: [],
        },
      ],
    });
  });

  it('reports which agents were written when a later one is refused', async () => {
    const root = await project({
      'agents/a.ts': agentFile('', 'one'),
      'agents/b.ts': agentFile('', 'two'),
    });
    let creates = 0;
    const run = await aw(root, ['push', '--yes', '--json'], (request) => {
      if (request.method === 'GET') return json(200, { agents: [] });
      if (isDryRun(request.json)) return json(200, { ok: true, number: 1 });
      creates += 1;
      if (creates > 1) return problem(409, 'agent_name_conflict');
      const body = CreateAgentFromVersionRequestSchema.parse(request.json);
      const version = versionOf(emptyServer(), body.version);
      return json(201, {
        agent: { ...FIXTURES.agent, modelConnectionId: null, name: 'one' },
        version,
      });
    });
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(stdoutJson(run)).toMatchObject({
      saved: false,
      problems: [{ file: 'agents/b.ts', status: 409, code: 'agent_name_conflict' }],
      agents: [{ file: 'agents/a.ts', action: 'create', saved: true, surfaces: [] }],
    });
  });

  it('names the folder to upload into when the server refuses a files() grant, and --json does not', async () => {
    const root = await project({ 'agents/assistant.ts': agentFile() });
    const refuse: Route = (request) =>
      request.method === 'GET'
        ? json(200, { agents: [] })
        : problem(422, 'agent_definition_references_missing', ['file:contracts']);
    const run = await aw(root, ['push'], refuse);
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stdout).toContain(
      'agents/assistant.ts: 422 agent_definition_references_missing [file:contracts]; upload a file into contracts (aw files upload <folder>/<name> <local-file>), then save again or run aw push --yes\n',
    );
    const machine = await aw(root, ['push', '--json'], refuse);
    expect(machine.code).toBe(EXIT_CODE.problem);
    expect(stdoutJson(machine)).toMatchObject({
      problems: [
        {
          file: 'agents/assistant.ts',
          status: 422,
          code: 'agent_definition_references_missing',
          details: ['file:contracts'],
        },
      ],
    });
    expect(JSON.stringify(stdoutJson(machine))).not.toContain('upload a file');
  });

  it('points local at the newest version when it already holds the body', async () => {
    const state = emptyServer();
    const root = await project({ 'agents/assistant.ts': agentFile() });
    expect((await aw(root, ['push', '--yes'], server(state))).code).toBe(EXIT_CODE.ok);
    const first = state.versions[0];
    if (first === undefined) throw new Error('the first push saved no version');
    state.versions.push({ ...first, id: 'v-2', number: 2 });
    const run = await aw(root, ['push', '--yes', '--json'], server(state));
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(writes(run)).toEqual([`PUT /api/agents/${IDS.agent}/pointers`]);
    expect(SetAgentPointerRequestSchema.parse(run.calls.at(-1)?.json)).toEqual({
      environment: 'local',
      version: 2,
    });
    expect(stdoutJson(run)).toMatchObject({
      saved: true,
      agents: [{ action: 'point', version: 2, local: { from: 1, to: 2 } }],
    });
  });

  it('saves a changed body as a version via aw-push, then points local at it', async () => {
    const state = emptyServer();
    const root = await project({ 'agents/assistant.ts': agentFile() });
    expect((await aw(root, ['push', '--yes'], server(state))).code).toBe(EXIT_CODE.ok);
    await tempFile(
      root,
      'agents/assistant.ts',
      agentFile().replace('Help people.', 'Help people kindly.'),
    );
    const plan = await aw(root, ['push'], server(state));
    expect(plan.code).toBe(EXIT_CODE.ok);
    expect(writes(plan)).toEqual([]);
    expect(plan.stdout).toContain('agents/assistant.ts: version 2 of "assistant" (local 1 → 2)\n');
    expect(plan.stdout).toContain('  ~ definition.agent.instructions\n');

    const run = await aw(root, ['push', '--yes', '--summary', 'Kinder'], server(state));
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(writes(run)).toEqual([
      `POST /api/agents/${IDS.agent}/versions`,
      `PUT /api/agents/${IDS.agent}/pointers`,
    ]);
    const saved = CreateAgentVersionRequestSchema.parse(
      run.calls.find((call) => call.method === 'POST' && !isDryRun(call.json))?.json,
    );
    expect(saved.via).toBe('aw-push');
    expect(saved.summary).toBe('Kinder');
    expect(state.versions).toHaveLength(2);
    expect(state.local).toBe(2);
  });

  it('writes nothing when the check finds a problem', async () => {
    const root = await project({ 'agents/assistant.ts': agentFile() });
    const run = await aw(root, ['push', '--yes', '--json'], (request) =>
      request.method === 'GET' ? json(200, { agents: [] }) : problem(403, 'forbidden'),
    );
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(writes(run)).toEqual([]);
    expect(stdoutJson(run)).toEqual({
      saved: false,
      problems: [{ file: 'agents/assistant.ts', status: 403, code: 'forbidden', details: [] }],
      agents: [],
    });
  });

  it('refuses an invalid --summary as a usage error, before loading anything', async () => {
    const root = await project({ 'agents/assistant.ts': agentFile() });
    const run = await aw(root, ['push', '--summary', ' padded ']);
    expect(run.code).toBe(EXIT_CODE.usage);
    expect(run.calls).toEqual([]);
  });

  it('keeps a transport failure as exit 4 rather than a problem', async () => {
    const root = await project({ 'agents/assistant.ts': agentFile() });
    const run = await aw(root, ['push'], () => Promise.reject(new TypeError('fetch failed')));
    expect(run.code).toBe(EXIT_CODE.transport);
  });
});

/** A v2 `agent-workspace.yaml`, with `extra` added at the root. */
function projectYaml(extra = ''): string {
  return `apiVersion: agentworkspace.dev/v2
kind: Project
name: demo
environments:
  local:
    cloud: local
    identity:
      bootstrapAdmin: admin@localhost.test
${extra}`;
}

/** The engine of the body `aw check` dry-ran for its first agent. */
function sentEngine(run: CliRun): string {
  return CreateAgentFromVersionRequestSchema.parse(run.calls[1]?.json).version.body.definition
    .policy.engine;
}

describe('aw check and aw push read agent-workspace.yaml (issue #547)', () => {
  it("prints the server's 403 policy_cannot_widen as it answers, and exits 1 (C14)", async () => {
    const root = await project({ 'agents/assistant.ts': agentFile() });
    const run = await aw(root, ['check'], (request) =>
      request.method === 'GET'
        ? json(200, { agents: [] })
        : problem(403, 'policy_cannot_widen', ['permissions.runCommands']),
    );
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stdout).toBe(
      'agents/assistant.ts: 403 policy_cannot_widen [permissions.runCommands]\n',
    );
  });

  it('never computes a widening itself: a server that answers 200 gets no 403 printed', async () => {
    const root = await project({
      'agent-workspace.yaml': projectYaml('policy:\n  permissions:\n    runCommands: false\n'),
      'agents/assistant.ts': agentFile(', permissions: { runCommands: true }'),
    });
    const run = await aw(root, ['check']);
    expect(run.code, run.stderr).toBe(EXIT_CODE.ok);
    expect(run.stdout + run.stderr).not.toContain('403');
  });

  it("checks an agent that names no engine on the project's engine, and keeps an agent's own (C12)", async () => {
    const yaml = projectYaml('engine: pi\n');
    const plain = await project({
      'agent-workspace.yaml': yaml,
      'agents/assistant.ts': agentFile(),
    });
    const run = await aw(plain, ['check']);
    expect(run.code, run.stderr).toBe(EXIT_CODE.ok);
    expect(sentEngine(run)).toBe('pi');
    const own = await project({
      'agent-workspace.yaml': yaml,
      'agents/assistant.ts': agentFile(", engine: 'claude-agent-sdk'"),
    });
    expect(sentEngine(await aw(own, ['check']))).toBe('claude-agent-sdk');
  });

  it('withholds a secret the project file names from the definition files', async () => {
    const root = await project({
      'agent-workspace.yaml': projectYaml(
        'connectors:\n  github:\n    url: https://mcp.example.com\n    auth:\n      scheme: bearer\n      credential:\n        secret: ORDERS_TOKEN\n',
      ),
      'agents/assistant.ts': `console.error('token=' + String(process.env.ORDERS_TOKEN));\n${agentFile()}`,
    });
    const run = await aw(root, ['check'], undefined, {
      env: {
        AGENT_WORKSPACE_URL: 'https://aw.example.com',
        AGENT_WORKSPACE_API_KEY: 'ak_live_test',
        ORDERS_TOKEN: 'never-seen',
      },
    });
    expect(run.stderr).toContain('token=undefined');
  });

  it('says models and connectors are applied by aw dev only when pushing to another workspace (SD7)', async () => {
    const models =
      'models:\n  default:\n    provider: anthropic\n    credential:\n      secret: ANTHROPIC_API_KEY\n';
    const notice = 'models and connectors are applied by aw dev only';
    const declared = await project({
      'agent-workspace.yaml': projectYaml(models),
      'agents/assistant.ts': agentFile(),
    });
    expect((await aw(declared, ['push'])).stderr).toContain(`${notice}\n`);
    const local = await aw(declared, ['push'], undefined, {
      env: {
        AGENT_WORKSPACE_URL: 'http://127.0.0.1:3000',
        AGENT_WORKSPACE_API_KEY: 'ak_live_test',
      },
    });
    expect(local.code, local.stderr).toBe(EXIT_CODE.ok);
    expect(local.stderr).not.toContain(notice);
    const slash = await aw(declared, ['push'], undefined, {
      env: {
        AGENT_WORKSPACE_URL: 'http://127.0.0.1:3000/',
        AGENT_WORKSPACE_API_KEY: 'ak_live_test',
      },
    });
    expect(slash.code, slash.stderr).toBe(EXIT_CODE.ok);
    expect(slash.stderr).not.toContain(notice);
    const none = await project({
      'agent-workspace.yaml': projectYaml(),
      'agents/assistant.ts': agentFile(),
    });
    expect((await aw(none, ['push'])).stderr).not.toContain(notice);
  });

  it('refuses a malformed agent-workspace.yaml at its line and column, before any request', async () => {
    const root = await project({
      'agent-workspace.yaml': projectYaml('surprise: true\n'),
      'agents/assistant.ts': agentFile(),
    });
    const run = await aw(root, ['check']);
    expect(run.code).toBe(EXIT_CODE.usage);
    expect(run.stderr).toMatch(/^error: agent-workspace\.yaml:\d+:\d+: /u);
    expect(run.calls).toEqual([]);
  });
});

describe('aw check and aw push with catalog tools (issue #549)', () => {
  const CONFIGURED = {
    AGENT_WORKSPACE_URL: 'https://aw.example.com',
    AGENT_WORKSPACE_API_KEY: 'ak_live_test',
  };
  const EXTERNAL_REF = '$ref "./other.yaml#/X": only references within the document are supported';
  const files = {
    'agents/assistant.ts': `import { defineAgent } from '@indx-workspace/sdk/define';
import { orders } from '../tools/orders';
export default defineAgent({ name: 'assistant', instructions: 'Help people.', tools: [orders] });
`,
    'tools/orders.ts': `import { openapiTool, secret } from '@indx-workspace/sdk/define';
export const orders = openapiTool({
  name: 'orders',
  spec: 'apis/orders.openapi.json',
  allow: ['GET /orders/*'],
  auth: secret('ORDERS_TOKEN'),
});
`,
    'apis/orders.openapi.json':
      '{"openapi":"3.1.0","info":{"title":"Orders","version":"1"},"paths":{"/orders/{id}":{"get":{"responses":{"200":{"$ref":"./other.yaml#/X"}}}}}}',
  };

  /** The agents double, plus a connectors route that refuses the document's external $ref. */
  function withConnectors(): Route {
    const agents = server(emptyServer());
    return (request) => {
      if (request.url.pathname !== '/api/connectors') return agents(request);
      if (request.method === 'GET') return json(200, { connectors: [] });
      return problem(422, 'connector_spec_invalid', [EXTERNAL_REF]);
    };
  }

  it("prints a refused document against the tool's file and exits 1, never sending the token", async () => {
    const root = await project(files);
    const run = await aw(root, ['check'], withConnectors(), {
      env: { ...CONFIGURED, ORDERS_TOKEN: 'sentinel-orders-token' },
    });
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stdout).toContain(`tools/orders.ts: 422 connector_spec_invalid [${EXTERNAL_REF}]\n`);
    const dryRun = run.calls.find(
      (call) => call.method === 'POST' && call.url.pathname === '/api/connectors',
    );
    expect(dryRun?.json).toMatchObject({ dryRun: true, credential: 'aw-check-placeholder' });
    expect(JSON.stringify(run.calls.map((call) => call.json))).not.toContain(
      'sentinel-orders-token',
    );
  });

  it('aw push applies the tool first, and a refused one stops it before any agent is saved (issue #789)', async () => {
    const root = await project(files);
    const run = await aw(root, ['push', '--yes'], withConnectors(), {
      env: { ...CONFIGURED, ORDERS_TOKEN: 'sentinel-orders-token' },
    });
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stdout).toContain(`tools/orders.ts: 422 connector_spec_invalid [${EXTERNAL_REF}]\n`);
    expect(requests(run).filter((call) => call.includes('/api/connectors'))).not.toEqual([]);
    const saved = run.calls.filter(
      (call) =>
        call.method === 'POST' &&
        call.url.pathname.startsWith('/api/agents') &&
        (call.json as { dryRun?: boolean } | undefined)?.dryRun !== true,
    );
    expect(saved).toEqual([]);
  });
});

/** The server's 422 for a definition naming resources the workspace does not have. */
function missingReferences(details: readonly string[]): Response {
  return json(422, {
    error: {
      code: 'agent_definition_references_missing',
      message: 'The definition names resources this workspace does not have.',
      details,
    },
  });
}

/** An agent file that lists `skill('<name>')`. */
const SKILL_AGENT = (name: string): string =>
  agentFile(`, skills: [skill('${name}')]`).replace('mcp }', 'mcp, skill }');

describe('aw check with skills/ folders (issue #694)', () => {
  const SKILL_MD = '---\nname: refunds\ndescription: Refund policy.\n---\n\nBe kind.\n';

  /** The control plane double, plus a workspace that holds `skills`. */
  function withSkills(...names: readonly string[]): Route {
    const inner = server(emptyServer());
    return (request: RecordedRequest) => {
      const { pathname } = request.url;
      if (pathname === '/api/skills') {
        return json(200, { skills: names.map((name) => ({ ...FIXTURES.skill, name })) });
      }
      if (pathname.startsWith('/api/skills/')) {
        return json(200, { skill: { name: pathname.split('/').pop(), files: [] } });
      }
      if (request.method === 'POST' && pathname === '/api/agents') {
        // Like the server's dry run: a version naming a skill the workspace lacks is refused.
        const skills = CreateAgentFromVersionRequestSchema.parse(request.json).version.body
          .definition.resources.skills;
        const missing = skills.filter((name) => !names.includes(name));
        if (missing.length > 0) return missingReferences(missing.map((name) => `skill:${name}`));
      }
      return inner(request);
    };
  }

  it('does not refuse an agent that names only a folder the push would create (the dry run says so)', async () => {
    const root = await project({
      'agents/assistant.ts': SKILL_AGENT('refunds'),
      'skills/refunds/SKILL.md': SKILL_MD,
    });
    const run = await aw(root, ['check'], withSkills());
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.stdout).toContain('agents/assistant.ts: ok (would be version 1)');
  });

  it('keeps any other missing reference a problem', async () => {
    const root = await project({
      'agents/assistant.ts': SKILL_AGENT('refunds'),
      'skills/refunds/SKILL.md': SKILL_MD,
    });
    const inner = server(emptyServer());
    const run = await aw(root, ['check'], (request) =>
      request.method === 'POST' && request.url.pathname === '/api/agents'
        ? missingReferences(['skill:refunds', 'connector:crm'])
        : inner(request),
    );
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stdout).toContain(
      'agent_definition_references_missing [skill:refunds, connector:crm]',
    );
  });

  it('accepts a skill() that names a folder with a SKILL.md', async () => {
    const root = await project({
      'agents/assistant.ts': SKILL_AGENT('refunds'),
      'skills/refunds/SKILL.md': SKILL_MD,
      'skills/refunds/policy.txt': 'ok',
    });
    const run = await aw(root, ['check'], withSkills());
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.stdout).toBe(
      'skills/refunds: ok (would be created)\nagents/assistant.ts: ok (would be version 1)\n',
    );
    expect(writes(run)).toEqual([]);
  });

  it('lists a workspace skill with no folder as only in the workspace', async () => {
    const root = await project({
      'agents/assistant.ts': agentFile(),
      'skills/refunds/SKILL.md': SKILL_MD,
    });
    const run = await aw(root, ['check'], withSkills('refunds', 'old-one'));
    expect(run.stdout).toContain('skills/old-one: only in the workspace');
  });

  it('accepts a skill() that names an existing workspace skill', async () => {
    const root = await project({ 'agents/assistant.ts': SKILL_AGENT('triage') });
    const run = await aw(root, ['check'], withSkills('triage'));
    expect(run.code).toBe(EXIT_CODE.ok);
  });

  it('refuses a missing skill by name, with the nearest name, and does not dry-run the agent', async () => {
    const root = await project({
      'agents/assistant.ts': SKILL_AGENT('refund-policy'),
      'skills/refunds/SKILL.md': SKILL_MD,
    });
    const run = await aw(root, ['check'], withSkills());
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stdout).toBe(
      "skills/refunds: ok (would be created)\nagents/assistant.ts: local skill_not_found [skill('refund-policy') is not in skills/ or the workspace (did you mean 'refunds'?)]\n",
    );
    expect(writes(run)).toEqual([]);
    expect(requests(run)).not.toContain('POST /api/agents');
  });

  it('refuses a folder without SKILL.md, a bad folder name and a SKILL.md that is not UTF-8', async () => {
    const root = await project({
      'agents/assistant.ts': agentFile(),
      'skills/empty/notes.txt': 'x',
      'skills/Bad Name/SKILL.md': SKILL_MD,
    });
    await tempFile(root, 'skills/binary/SKILL.md', Buffer.from([0xff, 0xfe, 0xfd]));
    await mkdir(path.join(root, 'skills/vacant'));
    const run = await aw(root, ['check'], withSkills());
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stdout.split('\n')).toEqual([
      'agents/assistant.ts: ok (would be version 1)',
      'skills/Bad Name: local invalid_skill [the folder name must be lower-case letters, digits and inner hyphens, at most 64]',
      'skills/binary: local invalid_skill [SKILL.md is not valid UTF-8]',
      'skills/empty: local invalid_skill [SKILL.md is missing]',
      'skills/vacant: local invalid_skill [skills/vacant holds no files]',
      '',
    ]);
  });

  it('refuses a SKILL.md without frontmatter, with invalid YAML, a wrong name or no description (BH061-021)', async () => {
    const root = await project({
      'agents/assistant.ts': agentFile(),
      'skills/bare/SKILL.md': 'Be kind.\n',
      'skills/broken/SKILL.md': '---\nname: broken\ndescription: [unclosed\n---\n',
      'skills/renamed/SKILL.md': '---\nname: other\ndescription: Refunds.\n---\n',
      'skills/silent/SKILL.md': '---\nname: silent\n---\n',
      'skills/blank/SKILL.md': "---\nname: blank\ndescription: ''\n---\n",
    });
    const run = await aw(root, ['check'], withSkills());
    expect(run.code).toBe(EXIT_CODE.problem);
    const lines = run.stdout.split('\n');
    expect(lines).toContain(
      '✗ skills/bare/SKILL.md:1:1  SKILL.md must start with frontmatter: ---, name: bare, description: <when to use it>, ---',
    );
    expect(lines.some((line) => line.startsWith('✗ skills/broken/SKILL.md:3:'))).toBe(true);
    expect(lines).toContain(
      "✗ skills/renamed/SKILL.md:2:1  name must be the folder's name, renamed",
    );
    expect(lines).toContain(
      '✗ skills/silent/SKILL.md:1:1  the frontmatter has no description: add description: <when to use it>',
    );
    expect(lines).toContain('✗ skills/blank/SKILL.md:3:1  description must be a non-empty string');
  });

  it('reports a failing skills list instead of a false skill_not_found', async () => {
    const root = await project({ 'agents/assistant.ts': SKILL_AGENT('triage') });
    const inner = server(emptyServer());
    const run = await aw(root, ['check'], (request) =>
      request.url.pathname === '/api/skills'
        ? json(500, { error: { code: 'internal_error', message: 'boom' } })
        : inner(request),
    );
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stdout).not.toContain('skill_not_found');
    expect(run.stdout).toContain('agents/assistant.ts');
  });
  it('reports a failing skills list as a problem on skills/ when only a folder needs it', async () => {
    const root = await project({
      'agents/assistant.ts': agentFile(),
      'skills/refunds/SKILL.md': SKILL_MD,
    });
    const inner = server(emptyServer());
    const run = await aw(root, ['check', '--json'], (request) =>
      request.url.pathname === '/api/skills'
        ? json(500, { error: { code: 'internal_error', message: 'boom' } })
        : inner(request),
    );
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(stdoutJson(run)).toMatchObject({
      problems: [{ file: 'skills', code: 'internal_error' }],
      agents: [{ file: 'agents/assistant.ts' }],
    });
  });
});

describe('aw push with skills/ folders (issue #694)', () => {
  const SKILL_MD = '---\nname: refunds\ndescription: Refund policy.\n---\n\nBe kind.\n';
  const b64 = (text: string): string => Buffer.from(text).toString('base64');

  /** A workspace that holds `refunds` with the given files, answering import, export and patch. */
  function workspace(files: readonly { path: string; contentBase64: string }[] | null): Route {
    const inner = server(emptyServer());
    return (request: RecordedRequest) => {
      const { pathname } = request.url;
      if (pathname === '/api/skills' && request.method === 'GET') {
        return json(200, {
          skills: files === null ? [] : [{ ...FIXTURES.skill, name: 'refunds' }],
        });
      }
      if (pathname === '/api/skills') return json(201, { skill: FIXTURES.skill });
      if (request.method === 'POST' && pathname === '/api/agents') {
        // Like the server: a version naming a skill the workspace lacks is refused.
        const named = CreateAgentFromVersionRequestSchema.parse(request.json).version.body
          .definition.resources.skills;
        const missing = named.filter((name) => name !== 'refunds' || files === null);
        if (missing.length > 0) return missingReferences(missing.map((name) => `skill:${name}`));
      }
      if (pathname === '/api/skills/refunds') {
        return request.method === 'GET'
          ? json(200, { skill: { name: 'refunds', files: files ?? [] } })
          : json(200, { skill: FIXTURES.skill });
      }
      return inner(request);
    };
  }

  const writtenSkills = (run: CliRun): readonly string[] =>
    writes(run).filter((write) => write.includes('/api/skills'));

  it('previews a new folder and an agent naming it without a write or a missing-reference problem', async () => {
    const root = await project({
      'agents/assistant.ts': SKILL_AGENT('refunds'),
      'skills/refunds/SKILL.md': SKILL_MD,
    });
    const run = await aw(root, ['push'], workspace(null));
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(writes(run)).toEqual([]);
  });

  it('writes no skill when an agent names one that is neither a folder nor in the workspace', async () => {
    const root = await project({
      'agents/assistant.ts': SKILL_AGENT('refund-policy'),
      'skills/refunds/SKILL.md': SKILL_MD,
    });
    const run = await aw(root, ['push', '--yes'], workspace(null));
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stdout).toContain('skill_not_found');
    expect(writes(run)).toEqual([]);
  });

  it('creates a new folder as a skill before the agent is saved', async () => {
    const root = await project({
      'agents/assistant.ts': agentFile(),
      'skills/refunds/SKILL.md': SKILL_MD,
      'skills/refunds/policy.txt': 'ok',
    });
    const run = await aw(root, ['push', '--yes'], workspace(null));
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(writes(run)[0]).toBe('POST /api/skills');
    expect(run.stdout).toContain('skills/refunds: create (2 files)\n');
  });

  it('updates a changed folder with one patch that also removes files the folder dropped', async () => {
    const root = await project({
      'agents/assistant.ts': agentFile(),
      'skills/refunds/SKILL.md': SKILL_MD,
    });
    const run = await aw(
      root,
      ['push', '--yes'],
      workspace([
        { path: 'SKILL.md', contentBase64: b64('old') },
        { path: 'gone.txt', contentBase64: b64('x') },
      ]),
    );
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(writtenSkills(run)).toEqual(['PATCH /api/skills/refunds']);
    const patch = run.calls.find((call) => call.method === 'PATCH');
    expect(patch?.json).toEqual({
      files: [{ path: 'SKILL.md', contentBase64: b64(SKILL_MD) }],
      removeFiles: ['gone.txt'],
    });
  });

  it('writes nothing for an unchanged folder, and never deletes a workspace skill', async () => {
    const root = await project({
      'agents/assistant.ts': agentFile(),
      'skills/refunds/SKILL.md': SKILL_MD,
    });
    const run = await aw(
      root,
      ['push', '--yes'],
      workspace([{ path: 'SKILL.md', contentBase64: b64(SKILL_MD) }]),
    );
    expect(writtenSkills(run)).toEqual([]);
    const gone = await project({
      'agents/assistant.ts': agentFile(),
      'skills/x/SKILL.md': SKILL_MD,
    });
    await rm(path.join(gone, 'skills/x'), { recursive: true });
    const after = await aw(
      gone,
      ['push', '--yes'],
      workspace([{ path: 'SKILL.md', contentBase64: b64('a') }]),
    );
    expect(after.calls.map((call) => call.method)).not.toContain('DELETE');
  });

  it('reports a refused skill upload as a problem on its folder and saves nothing', async () => {
    const root = await project({
      'agents/assistant.ts': agentFile(),
      'skills/refunds/SKILL.md': SKILL_MD,
    });
    const inner = workspace([{ path: 'SKILL.md', contentBase64: b64('old') }]);
    const run = await aw(root, ['push', '--yes', '--json'], (request) =>
      request.method === 'PATCH'
        ? json(409, { error: { code: 'colliding_paths', message: 'paths collide' } })
        : inner(request),
    );
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(stdoutJson(run)).toMatchObject({
      saved: false,
      problems: [{ file: 'skills/refunds', code: 'colliding_paths' }],
    });
  });

  it('writes no skill when an agent file does not load', async () => {
    const root = await project({
      'agents/assistant.ts': 'export default 1;\n',
      'skills/refunds/SKILL.md': SKILL_MD,
    });
    const run = await aw(root, ['push', '--yes'], workspace(null));
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(writtenSkills(run)).toEqual([]);
  });
});

describe('aw push with code tools (issue #790)', () => {
  const uploads = (run: CliRun): readonly string[] =>
    requests(run).filter((call) => call === 'POST /api/tool-bundles');

  it('uploads the bundle once and pins its digest in the saved version', async () => {
    const root = await project(CODE_TOOL_PROJECT);
    const state = emptyServer();
    const run = await aw(root, ['push', '--yes', '--json'], server(state));
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(uploads(run)).toHaveLength(1);
    expect(state.connectors.map(({ name, url }) => [name, url])).toEqual([
      ['aw-dev-tools', 'https://tool-sandbox.invalid/mcp'],
    ]);
    expect(stdoutJson(run)).toMatchObject({
      tools: [{ file: 'tools/get-order.ts', name: 'aw-dev-tools', action: 'create' }],
    });
    const [bundle] = (stdoutJson(run) as { bundles: { digest: string; saved: boolean }[] }).bundles;
    expect(bundle).toMatchObject({ tool: 'get_order', action: 'upload', saved: true });
    expect([...state.bundles]).toEqual([bundle?.digest]);
    expect(state.versions[0]?.body.toolBundles).toMatchObject([
      {
        tool: 'get_order',
        digest: bundle?.digest,
        description: 'Look up an order',
        inputSchema: { type: 'object' },
        timeoutMs: 30_000,
      },
    ]);
    // A tool that declares no network pins no domain: aw never injects a default (issue #827).
    expect(state.versions[0]?.body.toolBundles?.[0]).not.toHaveProperty('allowedDomains');
  });

  it('pins the secrets and allowed domains a tool declares, never a value', async () => {
    const root = await project({
      ...CODE_TOOL_PROJECT,
      'tools/get-order.ts': CODE_TOOL_PROJECT['tools/get-order.ts']
        .replace('{ defineTool, z }', '{ defineTool, secret, z }')
        .replace(
          "run: './tools/get-order.run.ts',",
          "run: './tools/get-order.run.ts',\n  secrets: [secret('ORDERS_API_KEY')],\n  allowedDomains: ['api.example.com'],",
        ),
    });
    const state = emptyServer();
    const run = await aw(root, ['push', '--yes', '--json'], server(state), {
      env: {
        AGENT_WORKSPACE_URL: 'https://aw.example.com',
        AGENT_WORKSPACE_API_KEY: 'ak_live_test',
        ORDERS_API_KEY: 'orders-key',
      },
    });
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(state.versions[0]?.body.toolBundles?.[0]).toMatchObject({
      tool: 'get_order',
      secrets: ['ORDERS_API_KEY'],
      allowedDomains: ['api.example.com'],
    });
    expect(JSON.stringify(state.versions[0]?.body)).not.toContain('orders-key');
  });

  it('a second push of the same source uploads nothing and saves no version', async () => {
    const root = await project(CODE_TOOL_PROJECT);
    const state = emptyServer();
    await aw(root, ['push', '--yes'], server(state));
    const run = await aw(root, ['push', '--yes', '--json'], server(state));
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(uploads(run)).toEqual([]);
    expect(writes(run)).toEqual([]);
    expect(state.versions).toHaveLength(1);
    expect(stdoutJson(run)).toMatchObject({
      bundles: [{ tool: 'get_order', action: 'unchanged', saved: false }],
      agents: [{ action: 'none' }],
    });
  });

  it('changing an imported module gives a new digest, a new upload and a new version', async () => {
    const root = await project(CODE_TOOL_PROJECT);
    const state = emptyServer();
    await aw(root, ['push', '--yes'], server(state));
    await tempFile(
      root,
      'tools/shout.ts',
      'export const shout = (text: string): string => text.toLowerCase();\n',
    );
    const run = await aw(root, ['push', '--yes'], server(state));
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(uploads(run)).toHaveLength(1);
    expect(state.bundles.size).toBe(2);
    expect(state.versions).toHaveLength(2);
  });

  it('without --yes sends no upload and accepts the dry run that waits on it', async () => {
    const root = await project(CODE_TOOL_PROJECT);
    const state = emptyServer();
    const run = await aw(root, ['push'], server(state));
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(writes(run)).toEqual([]);
    expect(run.stdout).toContain('would be uploaded');
    expect(state.bundles.size).toBe(0);
  });

  it('refuses a run file that is not there before anything is uploaded or saved', async () => {
    const root = await project({
      'agents/assistant.ts': CODE_TOOL_PROJECT['agents/assistant.ts'],
      'tools/get-order.ts': CODE_TOOL_PROJECT['tools/get-order.ts'],
    });
    const run = await aw(root, ['push', '--yes', '--json'], server(emptyServer()));
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(stdoutJson(run)).toMatchObject({
      saved: false,
      problems: [{ file: 'tools/get-order.ts', code: 'tool_run_file_missing' }],
    });
    expect(writes(run)).toEqual([]);
  });

  it('reports a version the server refuses for an unknown digest as that agent problem', async () => {
    const root = await project(CODE_TOOL_PROJECT);
    const digest = 'a'.repeat(64);
    const run = await aw(root, ['push', '--yes', '--json'], (request) => {
      if (request.url.pathname.startsWith('/api/tool-bundles')) {
        return json(200, { bundle: { digest, sizeBytes: 1 } });
      }
      if (request.url.pathname === '/api/connectors') return json(200, { connectors: [] });
      return request.method === 'GET'
        ? json(200, { agents: [] })
        : problem(422, 'tool_bundle_unknown', [`tool_bundle:${digest}`]);
    });
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(stdoutJson(run)).toMatchObject({
      problems: [{ file: 'agents/assistant.ts', status: 422, code: 'tool_bundle_unknown' }],
    });
  });
});
