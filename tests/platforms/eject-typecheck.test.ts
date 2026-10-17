import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { PortableProjectSchema } from '@indx-workspace/contracts/portable-agent';
import { compileForPlatform, platformTarget } from '@indx-workspace/platforms';
import { SAMPLE_PORTABLE_PROJECT } from '@indx-workspace/platforms/testing';
import ts from 'typescript';
import { afterAll, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const REPO = fileURLToPath(new URL('../../', import.meta.url));
const TSC = createRequire(import.meta.url).resolve('typescript/lib/tsc.js');

const OPENAI_MODELS = {
  ...SAMPLE_PORTABLE_PROJECT,
  agents: SAMPLE_PORTABLE_PROJECT.agents.map((agent) => ({
    ...agent,
    model: { provider: 'openai', id: 'gpt-5' },
    permissions: { ...agent.permissions, unrestrictedNetwork: true },
  })),
} as const;

/** The sample plus the paths it lacks: an SSE server, web_fetch, file_access and an engines block. */
const ALL_PATHS = {
  ...SAMPLE_PORTABLE_PROJECT,
  agents: SAMPLE_PORTABLE_PROJECT.agents.map((agent, index) =>
    index === 0
      ? {
          ...agent,
          tools: [
            ...(agent.tools ?? []),
            { kind: 'mcp', name: 'events', transport: 'sse', url: 'https://mcp.example.com/sse' },
            { kind: 'builtin', id: 'web_fetch' },
            { kind: 'builtin', id: 'file_access' },
          ],
          extensions: { engines: { mastra: { x: 1 } } },
        }
      : agent,
  ),
} as const;

/**
 * One row per ejected engine; `engineDir` is the adapter package whose node_modules holds its SDK,
 * `project` the project it compiles, and `hostileLiterals` how many places the hostile text lands in
 * agent.ts (Mastra also puts the description there; the others send it to package.json only).
 */
const EJECTS = [
  {
    label: 'eject-claude-agent-sdk',
    id: 'eject-claude-agent-sdk',
    engineDir: 'packages/engine-claude-agent-sdk',
    project: SAMPLE_PORTABLE_PROJECT,
    hostileLiterals: 4,
  },
  {
    label: 'eject-mastra',
    id: 'eject-mastra',
    engineDir: 'packages/engine-mastra',
    project: SAMPLE_PORTABLE_PROJECT,
    hostileLiterals: 5,
  },
  {
    label: 'eject-mastra with an SSE server, web_fetch, file_access and an engines block',
    id: 'eject-mastra',
    engineDir: 'packages/engine-mastra',
    project: ALL_PATHS,
    hostileLiterals: 5,
  },
  {
    label: 'eject-openai-agents with Anthropic models',
    id: 'eject-openai-agents',
    engineDir: 'packages/engine-openai-agents',
    project: SAMPLE_PORTABLE_PROJECT,
    hostileLiterals: 4,
  },
  {
    label: 'eject-openai-agents with OpenAI models',
    id: 'eject-openai-agents',
    engineDir: 'packages/engine-openai-agents',
    project: OPENAI_MODELS,
    hostileLiterals: 4,
  },
  {
    label: 'eject-openai-agents with an SSE server, web_fetch, file_access and an engines block',
    id: 'eject-openai-agents',
    engineDir: 'packages/engine-openai-agents',
    project: ALL_PATHS,
    hostileLiterals: 4,
  },
] as const;

const TOOL_DECLARATION = `import { defineTool, z } from '@indx-workspace/sdk/define';

export default defineTool({
  name: 'get_order',
  description: 'Look up an order by its id',
  input: z.object({ id: z.string() }),
  run: 'tools/get_order.run.ts',
});
`;

const TOOL_RUN = `export default function run(input: { id: string }): { id: string } {
  return { id: input.id };
}
`;

const scratch: string[] = [];
afterAll(() => {
  for (const directory of scratch) rmSync(directory, { recursive: true, force: true });
});

function emitted(id: string, project: unknown = SAMPLE_PORTABLE_PROJECT) {
  const target = platformTarget(id as Parameters<typeof platformTarget>[0]);
  if (target === undefined) throw new Error(`${id} is not registered`);
  const result = compileForPlatform(target, PortableProjectSchema.parse(project), {});
  if (!result.ok) throw new Error(`refused: ${result.refusal.code}`);
  return result.files;
}

function packageDirectory(name: string, engineDir: string): string {
  for (const base of [join(REPO, engineDir), REPO]) {
    const candidate = join(base, 'node_modules', ...name.split('/'));
    if (existsSync(candidate)) return realpathSync(candidate);
  }
  throw new Error(`${name} is not installed for ${engineDir}`);
}

function link(directory: string, name: string, target: string): void {
  const at = join(directory, 'node_modules', ...name.split('/'));
  mkdirSync(dirname(at), { recursive: true });
  symlinkSync(target, at, 'junction');
}

describe.each(EJECTS)('$label', ({ id, engineDir, project, hostileLiterals }) => {
  it('type-checks as a project of its own, against the pinned SDK and the code-tool SDK', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'eject-'));
    scratch.push(directory);
    const files = emitted(id, project);
    for (const file of files) {
      const at = join(directory, ...file.path.split('/'));
      mkdirSync(dirname(at), { recursive: true });
      writeFileSync(at, file.content);
    }
    mkdirSync(join(directory, 'tools'));
    writeFileSync(join(directory, 'tools', 'get_order.ts'), TOOL_DECLARATION);
    writeFileSync(join(directory, 'tools', 'get_order.run.ts'), TOOL_RUN);

    const manifest = JSON.parse(readText(files, 'package.json')) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const names = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }).filter(
      (name) => name !== 'typescript',
    );
    for (const name of names) {
      link(
        directory,
        name,
        name === '@indx-workspace/sdk'
          ? join(REPO, 'packages', 'sdk')
          : packageDirectory(name, engineDir),
      );
    }

    const outcome = await run(process.execPath, [TSC, '--noEmit', '-p', directory]).then(
      () => 'ok',
      (error: { stdout?: string }) => error.stdout ?? 'tsc did not run',
    );
    expect(outcome).toBe('ok');
  }, 180_000);

  it('keeps each hostile text inside one string literal of the emitted source', () => {
    const hostile = '"); process.exit(1); //`${process.exit(1)}`*/\'\n\\ ';
    const agent = project.agents[0];
    if (agent === undefined) throw new Error('the sample has no agent');
    const source = readText(
      emitted(id, {
        ...project,
        agents: [
          {
            ...agent,
            instructions: hostile,
            description: hostile,
            tools: [
              ...(agent.tools ?? []),
              {
                kind: 'mcp',
                name: 'hostile',
                transport: 'stdio',
                command: hostile,
                args: [hostile, hostile],
              },
            ],
          },
          ...project.agents.slice(1),
        ],
      }),
      'src/agent.ts',
    );
    const parsed = ts.transpileModule(source, {
      reportDiagnostics: true,
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 },
    });
    expect(parsed.diagnostics ?? []).toEqual([]);
    const literals: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteral(node) && node.text === hostile) literals.push(node.text);
      if (ts.isTemplateExpression(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        literals.push(`template: ${node.getText()}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(ts.createSourceFile('agent.ts', source, ts.ScriptTarget.ES2023, true));
    // The instructions, the stdio command and its two args, and the description where the engine takes it.
    expect(literals).toEqual(Array<string>(hostileLiterals).fill(hostile));
  });
});

function readText(files: ReturnType<typeof emitted>, path: string): string {
  const file = files.find((candidate) => candidate.path === path);
  if (typeof file?.content !== 'string') throw new Error(`no text file ${path}`);
  return file.content;
}
