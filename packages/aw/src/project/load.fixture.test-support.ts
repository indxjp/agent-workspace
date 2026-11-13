/**
 * The loader's closed linker serves project-relative `.ts` modules (issue #548, ADR-0111's slice-2
 * amendment). Each case is a project in a temporary directory, loaded through the real child.
 */
import { rm } from 'node:fs/promises';
import { formatAgentMarkdown } from '@indx-workspace/sdk/portable';
import { afterAll } from 'vitest';
import type { CliIo } from '../io.js';
import { tempDirectory, tempFile } from '../testing.js';
import { loadProject, type ProjectLoad } from './load.js';

export const DEFINE = `import { defineAgent } from '@indx-workspace/sdk/define';\n`;

/** An agent named `name` that imports `imports` and writes `instructions` (a JS expression). */
export function agentFile(name: string, imports: string, instructions = `'Help people.'`): string {
  return `${DEFINE}${imports}
export default defineAgent({ name: '${name}', instructions: ${instructions} });
`;
}

/** `agents/support.ts`, importing `orders` from `specifier` and writing it into its body. */
export function supportAgent(specifier: string): string {
  return agentFile('support', `import { orders } from '${specifier}';\n`, '`Orders: ${orders}`');
}

export const ORDERS_TOOL = `export const orders: string = 'from the tool';\n`;

const directories: string[] = [];

afterAll(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

export async function scratch(): Promise<string> {
  const directory = await tempDirectory();
  directories.push(directory);
  return directory;
}

/** Write `files` (paths relative to `root`) and answer `root`. */
export async function write(
  root: string,
  files: Readonly<Record<string, string>>,
): Promise<string> {
  for (const [file, contents] of Object.entries(files)) await tempFile(root, file, contents);
  return root;
}

export async function project(files: Readonly<Record<string, string>>): Promise<string> {
  return write(await scratch(), files);
}

export const io: CliIo = {
  stdin: () => Promise.resolve(''),
  stdout: () => undefined,
  stderr: () => undefined,
  env: {},
  homeDir: 'C:/nonexistent-home',
  fetch: () => Promise.reject(new Error('no network')),
  isTty: false,
};

export function load(root: string): Promise<ProjectLoad> {
  return loadProject({ root, io, signal: new AbortController().signal });
}

export function instructionsOf(result: ProjectLoad, name: string): unknown {
  return result.agents.find((agent) => agent.name === name)?.body.definition.agent.instructions;
}

/** The single problem of a load whose only agent is `agents/support.ts`. */
export function refusedSupport(details: readonly string[]): ProjectLoad['problems'] {
  return [{ file: 'agents/support.ts', status: null, code: 'import_refused', details }];
}

export const TOOLS_DEFINE = `import { defineAgent, openapiTool, secret } from '@indx-workspace/sdk/define';\n`;

/** `tools/orders.ts`: the `orders` tool, with `allow` as given. */
export function ordersTool(allow = `['GET /orders/*']`): string {
  return `import { openapiTool, secret } from '@indx-workspace/sdk/define';
export const orders = openapiTool({
  name: 'orders',
  spec: 'apis/orders.openapi.json',
  allow: ${allow},
  auth: secret('ORDERS_TOKEN'),
});
`;
}

/** An agent named `name` whose tools are the `orders` it imports from `tools/orders.ts`. */
export function toolAgent(name: string, from = '../tools/orders'): string {
  return `${TOOLS_DEFINE}import { orders } from '${from}';
export default defineAgent({ name: '${name}', instructions: 'Help.', tools: [orders] });
`;
}

export const ORDERS_DEFINITION = {
  kind: 'openapi',
  name: 'orders',
  spec: 'apis/orders.openapi.json',
  allow: ['GET /orders/*'],
  auth: 'bearer',
  credential: { secret: 'ORDERS_TOKEN' },
};

/** An `agents/<name>.agent.md` (ADR-0133 D3), with `extra` front matter. */
export function markdownAgent(name: string, extra: Record<string, unknown> = {}): string {
  return formatAgentMarkdown({
    apiVersion: 'agentworkspace.dev/v1',
    kind: 'Agent',
    name,
    instructions: 'Route the request.',
    model: { id: 'claude-sonnet-4-6' },
    permissions: {
      readFiles: true,
      writeFiles: false,
      runCommands: false,
      unrestrictedNetwork: false,
    },
    ...extra,
  });
}
