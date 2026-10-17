const SDK_DEFINE = '@indx-workspace/sdk/define';

/**
 * The template holds no backtick and no `${`, so `String.raw` keeps it exactly as written. Its SDK
 * import names a placeholder instead of the specifier: `src/dependencies.test.ts` reads any quoted
 * name that follows the word from, even inside a string, as an import of this package.
 */
const TEMPLATE = String.raw`import { randomUUID } from 'node:crypto';
import { readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { isCodeTool } from SDK_DEFINE_SPECIFIER;
import { z } from 'zod';

export interface LoadedCodeTool {
  readonly name: string;
  readonly description: string;
  readonly input: z.ZodObject;
  call(input: unknown): Promise<unknown>;
}

interface RunContext {
  readonly signal: AbortSignal;
  readonly runId: string;
  readonly agent: string;
}

type RunFunction = (input: unknown, context: RunContext) => unknown;

const runId = randomUUID();

async function filesBelow(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) return filesBelow(file);
      return /(?<!\.d)\.[jt]s$/u.test(entry.name) ? [file] : [];
    }),
  );
  return nested.flat();
}

async function defaultExport(file: string): Promise<unknown> {
  return ((await import(pathToFileURL(file).href)) as { default?: unknown }).default;
}

async function runFile(root: string, run: string): Promise<string> {
  const real = await realpath(path.join(root, ...run.split('/')));
  const relative = path.relative(await realpath(root), real);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(run + ' is outside the project');
  }
  return real;
}

export async function loadCodeTools(
  root: string,
  names: readonly string[],
  agent: string,
): Promise<readonly LoadedCodeTool[]> {
  const wanted = new Set(names);
  const loaded = new Map<string, LoadedCodeTool>();
  for (const file of (await filesBelow(path.join(root, 'tools'))).sort()) {
    const declaration = await defaultExport(file);
    if (!isCodeTool(declaration) || !wanted.has(declaration.name)) continue;
    if (loaded.has(declaration.name)) continue;
    const run = await defaultExport(await runFile(root, declaration.run));
    if (typeof run !== 'function') {
      throw new Error(declaration.run + ' must export a function as its default');
    }
    const input = z.fromJSONSchema(declaration.inputSchema);
    if (!(input instanceof z.ZodObject)) {
      throw new Error(declaration.name + ': its input schema must describe an object');
    }
    const timeoutMs = declaration.limits.timeoutMs;
    loaded.set(declaration.name, {
      name: declaration.name,
      description: declaration.description,
      input,
      call: async (args) =>
        (run as RunFunction)(input.parse(args), {
          signal: AbortSignal.timeout(timeoutMs),
          runId,
          agent,
        }),
    });
  }
  return names.map((name) => {
    const found = loaded.get(name);
    if (found === undefined) throw new Error('code tool ' + name + ' not found under tools/');
    return found;
  });
}
`;

/** `src/code-tools.ts` of an ejected project: one loader, applying the tool host's discovery rules. */
export const CODE_TOOLS_SOURCE = TEMPLATE.replace('SDK_DEFINE_SPECIFIER', `'${SDK_DEFINE}'`);
