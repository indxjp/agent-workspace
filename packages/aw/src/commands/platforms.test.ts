import { mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  PublishOutcome,
  PublishPlatformOptions,
  PublishPrerequisite,
} from '@indx-workspace/cli/publish';
import { PLATFORM_TARGETS } from '@indx-workspace/platforms';
import { formatAgentMarkdown, parseAgentMarkdown } from '@indx-workspace/sdk/portable';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { EXIT_CODE } from '../output.js';
import { runCli, stdoutJson, tempDirectory, tempFile, type CliRun } from '../testing.js';
import { AW_VERSION } from '../version.js';
import { toPosix } from './platforms.js';

const publishPlatform = vi.hoisted(() =>
  vi.fn<(options: PublishPlatformOptions) => Promise<PublishOutcome>>(),
);
const checkPublishPrerequisites = vi.hoisted(() =>
  vi.fn<() => Promise<readonly PublishPrerequisite[]>>(),
);
vi.mock('@indx-workspace/cli/publish', () => ({ publishPlatform, checkPublishPrerequisites }));
// `vi.mock` cannot make the CLI unresolvable, so a set `failure` is what loading it rejects with.
const cliLoad = vi.hoisted(() => ({ failure: null as Error | null }));
vi.mock('../cli-bridge.js', async (importOriginal) => {
  const bridge = await importOriginal<typeof import('../cli-bridge.js')>();
  return {
    ...bridge,
    loadPublishSteps: () => {
      const { failure } = cliLoad;
      return bridge.loadPublishSteps(failure === null ? undefined : () => Promise.reject(failure));
    },
  };
});

beforeEach(() => {
  cliLoad.failure = null;
  publishPlatform.mockReset();
  checkPublishPrerequisites.mockReset();
  checkPublishPrerequisites.mockResolvedValue([]);
});

const GOLDEN = fileURLToPath(
  new URL('../platforms/fixtures/support.claude-managed-agents.report.md', import.meta.url),
);

const directories: string[] = [];

afterAll(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function projectYaml(platforms: string): string {
  return `apiVersion: agentworkspace.dev/v2
kind: Project
name: acme-ai
environments:
  local:
    cloud: local
    identity:
      bootstrapAdmin: admin@localhost.test
platforms:
${platforms}`;
}

const CLAUDE = '  claude-managed-agents:\n    enabled: true\n';

const SUPPORT = `import { defineAgent } from '@indx-workspace/sdk/define';
export default defineAgent({
  name: 'support',
  instructions: 'Answer support questions.',
  model: { connection: 'default', id: 'claude-sonnet-4-6' },
});
`;

function markdownAgent(extra: Record<string, unknown> = {}): string {
  return formatAgentMarkdown({
    apiVersion: 'agentworkspace.dev/v1',
    kind: 'Agent',
    name: 'triage',
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

const TRIAGE = markdownAgent();

const STDIO_AGENT = markdownAgent({
  tools: [{ kind: 'mcp', name: 'git', transport: 'stdio', command: 'git-mcp' }],
});

const LOOKUP_TOOL = `import { defineTool, z } from '@indx-workspace/sdk/define';
export default defineTool({
  name: 'lookup',
  description: 'Look an order up',
  input: z.object({ id: z.string() }),
  run: './tools/lookup.run.ts',
});
`;

async function project(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await tempDirectory();
  directories.push(root);
  for (const [file, contents] of Object.entries(files)) await tempFile(root, file, contents);
  return root;
}

function aw(root: string, ...argv: string[]): Promise<CliRun> {
  return runCli(['platforms', ...argv], { cwd: root });
}

/** Every file under `root`, relative and sorted. */
async function listing(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) =>
      path.relative(root, path.join(entry.parentPath, entry.name)).replaceAll('\\', '/'),
    )
    .sort();
}

const TWO_AGENTS = {
  'agent-workspace.yaml': projectYaml(CLAUDE),
  'agents/support.ts': SUPPORT,
  'agents/triage.agent.md': TRIAGE,
};

describe('aw platforms list', () => {
  it('lists every agent platform and says the runtime drivers are another list', async () => {
    const run = await aw(await project({}), 'list');
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.stdout).toContain('claude-managed-agents');
    expect(run.stdout).toContain('Claude Managed Agents');
    expect(run.stderr).toContain('runtime drivers are a separate list (aw runtimes)');
  });

  it('prints each platform with its capabilities under --json', async () => {
    const run = await aw(await project({}), 'list', '--json');
    const rows = stdoutJson(run) as { id: string; capabilities: Record<string, string> }[];
    const claude = rows.find((row) => row.id === 'claude-managed-agents');
    expect(claude?.capabilities['mcpStdio']).toBe('unsupported');
    expect(rows.map((row) => row.id)).toContain('eject-mastra');
  });
});

describe('aw platforms export', () => {
  it('writes the files and PLATFORM_REPORT.md, and prints the verdict table', async () => {
    const root = await project(TWO_AGENTS);
    const run = await aw(
      root,
      'export',
      '--platform',
      'claude-managed-agents',
      '--agent',
      'support',
    );
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.stdout).toContain('verdict');
    expect(run.stderr).toContain('wrote ');
    const out = path.join(root, 'platforms', 'claude-managed-agents');
    const files = await listing(out);
    expect(files).toContain('PLATFORM_REPORT.md');
    const report = await readFile(path.join(out, 'PLATFORM_REPORT.md'), 'utf8');
    expect(report).toBe(await readFile(GOLDEN, 'utf8'));
  });

  it('refuses a link at a destination before writing any file', async () => {
    const root = await project(TWO_AGENTS);
    const out = path.join(root, 'platforms', 'claude-managed-agents');
    await mkdir(out, { recursive: true });
    await symlink(path.join(root, 'elsewhere.md'), path.join(out, 'PLATFORM_REPORT.md'));
    const run = await aw(
      root,
      'export',
      '--platform',
      'claude-managed-agents',
      '--agent',
      'support',
    );
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toContain('unsafe path PLATFORM_REPORT.md');
    expect(await readdir(out)).toEqual(['PLATFORM_REPORT.md']);
    expect(await listing(root)).not.toContain('elsewhere.md');
  });

  it('is deterministic and leaves vendor state alone', async () => {
    const root = await project(TWO_AGENTS);
    const argv = ['export', '--platform', 'claude-managed-agents', '--agent', 'support'];
    const out = path.join(root, 'platforms', 'claude-managed-agents');
    await aw(root, ...argv);
    const first = await readFile(path.join(out, 'PLATFORM_REPORT.md'), 'utf8');
    await tempFile(out, 'claude-lock.json', '{}');
    await tempFile(out, 'old.txt', 'x');
    const again = await aw(root, ...argv);
    expect(again.code).toBe(EXIT_CODE.ok);
    expect(await readFile(path.join(out, 'PLATFORM_REPORT.md'), 'utf8')).toBe(first);
    expect(await readFile(path.join(out, 'claude-lock.json'), 'utf8')).toBe('{}');
    expect(again.stderr).toContain('stale: platforms/claude-managed-agents/old.txt');
    expect(again.stderr).not.toContain('claude-lock.json');
  });

  it('prints the export under --json and honours --out', async () => {
    const root = await project(TWO_AGENTS);
    const run = await aw(
      root,
      'export',
      '--platform',
      'claude-managed-agents',
      '--agent',
      'support',
      '--out',
      'dist/cma',
      '--json',
    );
    const result = stdoutJson(run) as { platform: string; dropped: number; files: string[] };
    expect(result.platform).toBe('claude-managed-agents');
    expect(result.files).toContain('PLATFORM_REPORT.md');
    expect(await listing(path.join(root, 'dist', 'cma'))).toEqual(result.files);
  });

  it('exits 5 under --strict when a field is dropped, after writing the report', async () => {
    const root = await project({ ...TWO_AGENTS, 'agents/triage.agent.md': STDIO_AGENT });
    const argv = ['export', '--platform', 'claude-managed-agents', '--agent', 'triage'];
    const lenient = await aw(root, ...argv);
    expect(lenient.code).toBe(EXIT_CODE.ok);
    expect(lenient.stdout).toContain('stdio_mcp_unsupported');
    const strict = await aw(root, ...argv, '--strict');
    expect(strict.code).toBe(EXIT_CODE.dropped);
    expect(strict.stderr).toContain('fields dropped for claude-managed-agents');
    const report = await readFile(
      path.join(root, 'platforms', 'claude-managed-agents', 'PLATFORM_REPORT.md'),
      'utf8',
    );
    expect(report).toContain('stdio_mcp_unsupported');
  });

  it('copies tools/ into an eject export but not into a declarative one', async () => {
    const root = await project({
      'agent-workspace.yaml': projectYaml(`${CLAUDE}  eject-mastra:\n    enabled: true\n`),
      'agents/support.ts': SUPPORT.replace(
        'import { defineAgent }',
        "import lookup from '../tools/lookup.ts';\nimport { defineAgent }",
      ).replace('model:', 'tools: [lookup],\n  model:'),
      'tools/lookup.ts': LOOKUP_TOOL,
      'tools/lookup.run.ts': 'export default ({ id }: { id: string }) => id;\n',
      'tools/lib/x.ts': 'export const x = 1;\n',
    });
    await symlink('/etc/hostname', path.join(root, 'tools', 'link.txt')).catch(() => undefined);
    const ejected = await aw(root, 'export', '--platform', 'eject-mastra');
    expect(ejected.code).toBe(EXIT_CODE.ok);
    const files = await listing(path.join(root, 'platforms', 'eject-mastra'));
    expect(files).toContain('tools/lookup.ts');
    expect(files).toContain('tools/lib/x.ts');
    expect(files).not.toContain('tools/link.txt');
    expect(ejected.stdout).toContain('tools');

    const declarative = await aw(root, 'export', '--platform', 'claude-managed-agents');
    expect(declarative.code).toBe(EXIT_CODE.ok);
    const claude = await listing(path.join(root, 'platforms', 'claude-managed-agents'));
    expect(claude.some((file) => file.startsWith('tools/'))).toBe(false);
  });

  it('refuses a model that is not a Claude model', async () => {
    const root = await project({
      ...TWO_AGENTS,
      'agents/support.ts': SUPPORT.replace('claude-sonnet-4-6', 'gpt-5'),
    });
    const run = await aw(
      root,
      'export',
      '--platform',
      'claude-managed-agents',
      '--agent',
      'support',
    );
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toContain('error: platform_model_unsupported:');
  });

  it('refuses a platform the project disabled, and invalid options', async () => {
    const disabled = await project({
      ...TWO_AGENTS,
      'agent-workspace.yaml': projectYaml('  claude-managed-agents:\n    enabled: false\n'),
    });
    const off = await aw(
      disabled,
      'export',
      '--platform',
      'claude-managed-agents',
      '--agent',
      'support',
    );
    expect(off.code).toBe(EXIT_CODE.problem);
    expect(off.stderr).toContain('enabled is false');

    const invalid = await project({
      ...TWO_AGENTS,
      'agent-workspace.yaml': projectYaml(
        '  claude-managed-agents:\n    enabled: true\n    options:\n      nonsense: 1\n',
      ),
    });
    const bad = await aw(
      invalid,
      'export',
      '--platform',
      'claude-managed-agents',
      '--agent',
      'support',
    );
    expect(bad.code).toBe(EXIT_CODE.problem);
    expect(bad.stderr).toContain('platform_options_invalid');
  });

  it('refuses usage mistakes with exit 2', async () => {
    const root = await project(TWO_AGENTS);
    const base = ['export', '--platform', 'claude-managed-agents'];
    const several = await aw(root, ...base);
    expect(several.code).toBe(EXIT_CODE.usage);
    expect(several.stderr).toContain('pass --agent <name>');
    const env = await aw(root, ...base, '--agent', 'support', '--env', 'missing');
    expect(env.code).toBe(EXIT_CODE.usage);
    expect(env.stderr).toContain('platforms.claude-managed-agents.environments has no missing');
    const unknown = await aw(root, 'export', '--platform', 'nope');
    expect(unknown.code).toBe(EXIT_CODE.usage);
    const missing = await aw(root, 'export');
    expect(missing.code).toBe(EXIT_CODE.usage);
    const target = await aw(root, ...base, '--target', 'x');
    expect(target.code).toBe(EXIT_CODE.usage);
    expect(target.stderr).toContain('unknown flag --target');
  });

  it('names the tool endpoint from the options and never prints the secret', async () => {
    const root = await project({
      'agent-workspace.yaml': projectYaml(
        `${CLAUDE}    options:\n      publicBaseUrl: https://agents.acme.example/\n      toolAuth:\n        scheme: bearer\n        secretRef: ACME_TOOL_TOKEN\n`,
      ),
      'agents/support.ts': SUPPORT.replace(
        'import { defineAgent }',
        "import lookup from '../tools/lookup.ts';\nimport { defineAgent }",
      ).replace('model:', 'tools: [lookup],\n  model:'),
      'tools/lookup.ts': LOOKUP_TOOL,
      'tools/lookup.run.ts': 'export default ({ id }: { id: string }) => id;\n',
    });
    const run = await runCli(['platforms', 'export', '--platform', 'claude-managed-agents'], {
      cwd: root,
      env: { ACME_TOOL_TOKEN: 'sk-super-secret-value' },
    });
    expect(run.code).toBe(EXIT_CODE.ok);
    const out = path.join(root, 'platforms', 'claude-managed-agents');
    const texts = [run.stdout, run.stderr];
    for (const file of await listing(out)) texts.push(await readFile(path.join(out, file), 'utf8'));
    expect(texts.join('\n')).toContain('https://agents.acme.example/mcp/projects/acme-ai');
    expect(texts.join('\n')).not.toContain('sk-super-secret-value');
  });
});

describe('aw platforms import', () => {
  async function exported(): Promise<{ root: string; from: string }> {
    const root = await project(TWO_AGENTS);
    await aw(root, 'export', '--platform', 'claude-managed-agents', '--agent', 'support');
    return { root, from: path.join(root, 'platforms', 'claude-managed-agents') };
  }

  it('turns a platform export back into agents/<name>.agent.md', async () => {
    const { from } = await exported();
    const fresh = await project({
      'agent-workspace.yaml': projectYaml('  claude-managed-agents:\n    enabled: true\n'),
    });
    const run = await aw(fresh, 'import', '--from', 'claude-managed-agents', from);
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(await listing(path.join(fresh, 'agents'))).toContain('support.agent.md');
    const written = await readFile(path.join(fresh, 'agents', 'support.agent.md'), 'utf8');
    expect(written).toContain('Answer support questions.');

    const target = PLATFORM_TARGETS.find((entry) => entry.id === 'claude-managed-agents');
    if (target?.import === undefined) throw new Error('claude-managed-agents has no importer');
    const files = await Promise.all(
      (await listing(from)).map(async (file) => ({
        path: file,
        content: await readFile(path.join(from, file), 'utf8'),
      })),
    );
    const imported = target.import(files);
    if (!imported.ok) throw new Error('the export did not import');
    const support = imported.project.agents.find((agent) => agent.name === 'support');
    expect(parseAgentMarkdown(written, 'support.agent.md')).toEqual(support);
  });

  it('refuses to overwrite without --yes, and never replaces an agents/<name>.ts', async () => {
    const { from } = await exported();
    const fresh = await project({ 'agent-workspace.yaml': projectYaml(CLAUDE) });
    const argv = ['import', '--from', 'claude-managed-agents', from];
    expect((await aw(fresh, ...argv)).code).toBe(EXIT_CODE.ok);
    const again = await aw(fresh, ...argv);
    expect(again.code).toBe(EXIT_CODE.problem);
    expect(again.stderr).toContain('pass --yes to overwrite');
    expect((await aw(fresh, ...argv, '--yes')).code).toBe(EXIT_CODE.ok);

    const shadowed = await project({
      'agent-workspace.yaml': projectYaml(CLAUDE),
      'agents/support.ts': SUPPORT,
    });
    const clash = await aw(shadowed, ...argv, '--yes');
    expect(clash.code).toBe(EXIT_CODE.problem);
    expect(clash.stderr).toContain('agents/support.ts already defines support');
  });

  it('refuses a platform with no importer, a missing path and bad input', async () => {
    const root = await project(TWO_AGENTS);
    const none = await aw(root, 'import', '--from', 'eject-mastra', '.');
    expect(none.code).toBe(EXIT_CODE.problem);
    expect(none.stderr).toContain('eject-mastra has no importer');
    expect(none.stderr).toContain('claude-managed-agents');
    const gone = await aw(root, 'import', '--from', 'claude-managed-agents', 'nowhere');
    expect(gone.code).toBe(EXIT_CODE.usage);
    await writeFile(path.join(root, 'junk.json'), '{ not json');
    const junk = await aw(root, 'import', '--from', 'claude-managed-agents', 'junk.json');
    expect(junk.code).toBe(EXIT_CODE.problem);
    expect(await readdir(path.join(root, 'agents'))).not.toContain('junk.agent.md');
  });

  it('refuses an export larger than an agent export', async () => {
    const root = await project(TWO_AGENTS);
    const big = path.join(root, 'big');
    await mkdir(big);
    await Promise.all(
      Array.from({ length: 501 }, (_, index) =>
        writeFile(path.join(big, `f${String(index)}.txt`), 'x'),
      ),
    );
    const run = await aw(root, 'import', '--from', 'claude-managed-agents', 'big');
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toContain('is larger than an agent export');
  });
});

describe('aw platforms doctor', () => {
  it('passes a platform that compiles', async () => {
    const root = await project({
      'agent-workspace.yaml': projectYaml(CLAUDE),
      'agents/triage.agent.md': TRIAGE,
    });
    const run = await aw(root, 'doctor');
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.stdout).toMatch(/compile\s+claude-managed-agents\s+pass/u);
  });

  it('warns when fields would be dropped and when code tools have no endpoint', async () => {
    const root = await project({
      'agent-workspace.yaml': projectYaml(CLAUDE),
      'agents/support.ts': SUPPORT.replace(
        'import { defineAgent }',
        "import lookup from '../tools/lookup.ts';\nimport { defineAgent }",
      ).replace('model:', 'tools: [lookup],\n  model:'),
      'tools/lookup.ts': LOOKUP_TOOL,
      'tools/lookup.run.ts': 'export default ({ id }: { id: string }) => id;\n',
    });
    const run = await aw(root, 'doctor', '--json');
    expect(run.code).toBe(EXIT_CODE.ok);
    const rows = stdoutJson(run) as { check: string; status: string; detail: string }[];
    expect(rows.find((row) => row.check === 'compile')?.status).toBe('warn');
    expect(rows.find((row) => row.check === 'tool-endpoint')?.detail).toContain(
      'code_tool_needs_public_mcp',
    );
  });

  it('fails a platform that refuses, writing nothing', async () => {
    const root = await project({
      'agent-workspace.yaml': projectYaml(CLAUDE),
      'agents/support.ts': SUPPORT.replace('claude-sonnet-4-6', 'gpt-5'),
    });
    const before = await listing(root);
    const run = await aw(root, 'doctor');
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stdout).toContain('platform_model_unsupported');
    expect(run.stderr).toContain('1 checks failed');
    expect(await listing(root)).toEqual(before);
  });

  it('prints a row for a project with several agents, and checks the one --agent names', async () => {
    const root = await project(TWO_AGENTS);
    const ambiguous = await aw(root, 'doctor');
    expect(ambiguous.code).toBe(EXIT_CODE.problem);
    expect(ambiguous.stdout).toMatch(/compile\s+claude-managed-agents\s+fail/u);
    expect(ambiguous.stdout).toContain('pass --agent <name>');
    const chosen = await aw(root, 'doctor', '--agent', 'support');
    expect(chosen.code).toBe(EXIT_CODE.ok);
    expect(chosen.stdout).toMatch(/compile\s+claude-managed-agents\s+(pass|warn)/u);
  });

  it('warns when nothing is enabled or there is no project', async () => {
    const bare = await project({});
    const none = await aw(bare, 'doctor');
    expect(none.code).toBe(EXIT_CODE.ok);
    expect(none.stdout).toContain('no platforms enabled');
    const off = await project({
      'agent-workspace.yaml': projectYaml('  claude-managed-agents:\n    enabled: false\n'),
      'agents/support.ts': SUPPORT,
    });
    expect((await aw(off, 'doctor')).stdout).toContain('no platforms enabled');
  });
});

describe('aw platforms publish', () => {
  const argv = ['publish', '--platform', 'claude-managed-agents', '--agent', 'support'];

  it('shows the plan and exits 3 when it has changes, without --yes', async () => {
    publishPlatform.mockResolvedValue({ changes: true, applied: false, nextSteps: [] });
    const root = await project(TWO_AGENTS);
    const run = await aw(root, ...argv);
    expect(run.code).toBe(EXIT_CODE.contract);
    expect(run.stderr).toContain('re-run with --yes to publish them');
    expect(publishPlatform).toHaveBeenCalledWith(
      expect.objectContaining({
        platform: 'claude-managed-agents',
        apply: false,
        experimental: false,
        directory: path.join(root, 'platforms', 'claude-managed-agents'),
      }),
    );
    expect(await listing(path.join(root, 'platforms', 'claude-managed-agents'))).toContain(
      'PLATFORM_REPORT.md',
    );
  });

  it('prints the next steps of a pending plan before exiting 3', async () => {
    publishPlatform.mockResolvedValue({
      changes: true,
      applied: false,
      nextSteps: ['pac auth create --environment <environment url>'],
    });
    const run = await aw(await project(TWO_AGENTS), ...argv);
    expect(run.code).toBe(EXIT_CODE.contract);
    expect(run.stderr).toContain('next: pac auth create --environment <environment url>');
    expect(run.stderr).toContain('re-run with --yes to publish them');
  });

  it('applies with --yes and prints the next steps', async () => {
    publishPlatform.mockResolvedValue({
      changes: true,
      applied: true,
      nextSteps: ['agent id: agent_1'],
    });
    const run = await aw(await project(TWO_AGENTS), ...argv, '--yes', '--experimental');
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.stderr).toContain('published support to claude-managed-agents');
    expect(run.stderr).toContain('next: agent id: agent_1');
    expect(publishPlatform).toHaveBeenCalledWith(
      expect.objectContaining({ apply: true, experimental: true }),
    );
  });

  it('passes --env and the merged settings to the executor', async () => {
    publishPlatform.mockResolvedValue({ changes: false, applied: false, nextSteps: [] });
    const root = await project({
      ...TWO_AGENTS,
      'agent-workspace.yaml': projectYaml(`${CLAUDE}    environments:\n      production: {}\n`),
    });
    const run = await aw(root, ...argv, '--env', 'production');
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.stderr).toContain('nothing to publish');
    expect(publishPlatform).toHaveBeenCalledWith(
      expect.objectContaining({ environment: 'production', settings: {} }),
    );
  });

  it('prints one JSON object under --json and keeps vendor output off stdout', async () => {
    publishPlatform.mockImplementation((options) => {
      options.out?.('$ ant apply --yes .\n');
      return Promise.resolve({ changes: true, applied: true, nextSteps: ['agent id: agent_1'] });
    });
    const run = await aw(await project(TWO_AGENTS), ...argv, '--yes', '--json');
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.stderr).toContain('$ ant apply --yes .');
    const result = stdoutJson(run) as { platform: string; published: boolean; files: string[] };
    expect(result.platform).toBe('claude-managed-agents');
    expect(result.published).toBe(true);
    expect(result.files).toContain('PLATFORM_REPORT.md');
  });

  it('refuses --plan with --yes as a usage error', async () => {
    const run = await aw(await project(TWO_AGENTS), ...argv, '--plan', '--yes');
    expect(run.code).toBe(EXIT_CODE.usage);
    expect(run.stderr).toContain('--plan and --yes contradict');
    expect(publishPlatform).not.toHaveBeenCalled();
  });

  it('exits 5 under --strict before any vendor call when a field is dropped', async () => {
    const root = await project({ ...TWO_AGENTS, 'agents/triage.agent.md': STDIO_AGENT });
    const run = await aw(
      root,
      'publish',
      '--platform',
      'claude-managed-agents',
      '--agent',
      'triage',
      '--yes',
      '--strict',
    );
    expect(run.code).toBe(EXIT_CODE.dropped);
    expect(publishPlatform).not.toHaveBeenCalled();
  });

  it('turns an executor error into a refusal with its fix', async () => {
    publishPlatform.mockRejectedValue(
      Object.assign(new Error('ant is older than 1.30.0'), { fix: 'brew upgrade ant' }),
    );
    const run = await aw(await project(TWO_AGENTS), ...argv, '--yes');
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toContain('ant is older than 1.30.0');
    expect(run.stderr).toContain('fix: brew upgrade ant');
  });

  it('refuses an eject target by exporting it, then pointing at export', async () => {
    publishPlatform.mockRejectedValue(
      Object.assign(new Error('eject targets are exported, not published'), {
        fix: 'aw platforms export --platform eject-mastra',
      }),
    );
    const root = await project({
      ...TWO_AGENTS,
      'agent-workspace.yaml': projectYaml(`${CLAUDE}  eject-mastra:\n    enabled: true\n`),
    });
    const run = await aw(root, 'publish', '--platform', 'eject-mastra', '--agent', 'support');
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toContain('fix: aw platforms export --platform eject-mastra');
  });
});

describe('aw platforms doctor prerequisites', () => {
  const enabled = {
    'agent-workspace.yaml': projectYaml(CLAUDE),
    'agents/triage.agent.md': TRIAGE,
  };

  it('prints a row per vendor tool and only warns for a missing one', async () => {
    checkPublishPrerequisites.mockResolvedValue([
      { platform: 'claude-managed-agents', tool: 'ant', status: 'fail', detail: 'not installed' },
    ]);
    const run = await aw(await project(enabled), 'doctor', '--json');
    expect(run.code).toBe(EXIT_CODE.ok);
    const rows = stdoutJson(run) as { check: string; subject: string; status: string }[];
    expect(rows.find((entry) => entry.check === 'prerequisite')).toMatchObject({
      subject: 'claude-managed-agents/ant',
      status: 'warn',
    });
  });

  it('warns once with the install fix when @indx-workspace/cli is not installed', async () => {
    cliLoad.failure = Object.assign(new Error("Cannot find package '@indx-workspace/cli'"), {
      code: 'ERR_MODULE_NOT_FOUND',
    });
    const run = await aw(await project(enabled), 'doctor', '--json');
    expect(run.code).toBe(EXIT_CODE.ok);
    const rows = stdoutJson(run) as { check: string; subject: string; status: string }[];
    const prerequisites = rows.filter((entry) => entry.check === 'prerequisite');
    expect(prerequisites).toHaveLength(1);
    expect(prerequisites[0]).toMatchObject({
      subject: '@indx-workspace/cli',
      status: 'warn',
      detail: expect.stringContaining(
        `npm install --save-dev @indx-workspace/cli@${AW_VERSION}`,
      ) as unknown,
    });
    expect(checkPublishPrerequisites).not.toHaveBeenCalled();
  });

  it('passes a tool that is installed and recent enough', async () => {
    checkPublishPrerequisites.mockResolvedValue([
      { platform: 'claude-managed-agents', tool: 'ant', status: 'pass', detail: 'ant 1.31.2' },
    ]);
    const run = await aw(await project(enabled), 'doctor');
    expect(run.stdout).toMatch(/prerequisite\s+claude-managed-agents\/ant\s+pass/u);
  });
});

describe('toPosix', () => {
  it('joins on / whatever the OS separator is', () => {
    expect(toPosix(['platforms', 'claude-managed-agents'].join(path.sep))).toBe(
      'platforms/claude-managed-agents',
    );
    expect(toPosix('platforms\\claude-managed-agents', '\\')).toBe(
      'platforms/claude-managed-agents',
    );
  });
});
