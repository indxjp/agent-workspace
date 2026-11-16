import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { createClient, type AgentWorkspaceClient } from '@indx-workspace/sdk';
import { afterEach, vi } from 'vitest';
import {
  PROJECT_API_VERSION,
  PROJECT_KIND,
  type ProjectDocument,
} from '@indx-workspace/contracts/project-file';
import type { CliIo } from '../io.js';
import { tempDirectory, tempFile } from '../testing.js';
import { startDevSync, type DevSync } from './sync.js';
import {
  clock,
  isDryRun,
  multipartImport,
  type Recorded,
  server,
  type ServerState,
  type StoredAgent,
} from './sync-server.test-support.js';

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

export const ORIGIN = 'http://127.0.0.1:3000';

export const DEFINE = `import { defineAgent, defineSurface } from '@indx-workspace/sdk/define';\n`;

/** How long a case waits for output that a save, the debounce and a loader fork produce. */
const DEADLINE_MS = 5000;

/** A short debounce keeps the suite fast; the burst case still sees one sync. */
export const DEBOUNCE_MS = 100;

/** How long a case waits to be sure a sync that should not run has not run. */
export const SETTLE_MS = 2000;

export const WIDGET = `widget: <script src="${ORIGIN}/p/s/main/widget.js" async></script>`;

export const AGENT = `${DEFINE}
export default defineAgent({ name: 'assistant', instructions: 'Help people.' });
`;

export function surface(colour: string): string {
  return `${DEFINE}
export default defineSurface({ name: 'main', agent: 'assistant', title: 'Ask us', theme: { colour: '${colour}' } });
`;
}

/** The project's first agent, which most cases have alone. */
export function first(harness: { readonly state: ServerState }): StoredAgent {
  const stored = harness.state.agents[0];
  if (stored === undefined) throw new Error('no agent was created');
  return stored;
}

export function named(harness: { readonly state: ServerState }, name: string): StoredAgent {
  const stored = harness.state.agents.find((candidate) => candidate.agent.name === name);
  if (stored === undefined) throw new Error(`no agent ${name}`);
  return stored;
}

/**
 * An edit in the UI (issue #546): the row moves on and is no longer its version (#613); the
 * `local` pointer does not move.
 */
export function editInUi(harness: { readonly state: ServerState }, name: string): StoredAgent {
  const stored = named(harness, name);
  stored.agent = { ...stored.agent, updatedAt: harness.state.now() };
  stored.materialised = null;
  return stored;
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

export async function start(
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
  const fetchDouble = createFetchDouble({ state, calls, holder });
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
export async function until(harness: Harness, condition: () => boolean): Promise<void> {
  const deadline = Date.now() + DEADLINE_MS;
  while (!condition()) {
    if (Date.now() > deadline) {
      const { stdout, stderr } = harness.output();
      throw new Error(`timed out; stdout:\n${stdout}\nstderr:\n${stderr}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

export function count(text: string, part: string): number {
  return text.split(part).length - 1;
}

/** The requests that wrote something: neither a read nor a dry run. */
export function writes(harness: Harness): readonly string[] {
  return harness.calls
    .filter((call) => call.method !== 'GET' && !(call.method === 'POST' && isDryRun(call.json)))
    .map((call) => `${call.method} ${call.path}`);
}

/** The reads `agents.export` makes: the agent row, its policy and its resources. */
export function exportReads(harness: Harness): readonly string[] {
  return harness.calls
    .filter((call) => /^\/api\/agents\/[^/]+(\/policy|\/resources)?$/.test(call.path))
    .map((call) => `${call.method} ${call.path}`);
}

export function synced(harness: Harness): number {
  return count(harness.output().stdout, 'synced: ');
}

export const PROJECT = { 'agents/assistant.ts': AGENT, 'surfaces/main.ts': surface('#0055ff') };

export const EDITED_SUMMARY = 'those agents keep their UI edit until aw push --yes overwrites them';

export const HINT = 'run `aw push --yes` to overwrite it with this file';

export const SENTINEL = 'sentinel-orders-token';

export function ordersTool(allow = `['GET /orders/*']`): string {
  return `import { openapiTool, secret } from '@indx-workspace/sdk/define';
export const orders = openapiTool({ name: 'orders', spec: 'apis/orders.openapi.json', allow: ${allow}, auth: secret('ORDERS_TOKEN') });
`;
}

export function toolAgent(instructions = 'Help people.'): string {
  return `${DEFINE}import { orders } from '../tools/orders';
export default defineAgent({ name: 'assistant', instructions: '${instructions}', tools: [orders] });
`;
}

export function ordersDocument(version: string): string {
  return JSON.stringify({ openapi: '3.1.0', info: { title: 'Orders', version }, paths: {} });
}

export const TOOL_PROJECT = {
  'agents/assistant.ts': toolAgent(),
  'tools/orders.ts': ordersTool(),
  'apis/orders.openapi.json': ordersDocument('1'),
};

export function writeIndex(harness: Harness, write: string): number {
  return writes(harness).indexOf(write);
}

/** Every file under `directory`, except the runtime's own `.agent-workspace/`. */
export async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name))
    .filter((file) => !file.split(path.sep).includes('.agent-workspace'));
}

export const CODE_TOOL_PROJECT = {
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

function createFetchDouble(context: {
  readonly state: ServerState;
  readonly calls: Recorded[];
  readonly holder: { harness: Harness | null };
}): typeof fetch {
  const { state, calls, holder } = context;
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
  return fetchDouble;
}
