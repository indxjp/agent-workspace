import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';

import {
  claudeWriteFilesApprovals,
  compileClaudeToolPolicy,
} from '@agent-workspace/engine-claude-agent-sdk/testing';
import { claudeReadOnlyGrantDenials } from '@indx-workspace/contracts/agents';
import { PortableProjectSchema } from '@indx-workspace/contracts/portable-agent';
import { compileForPlatform, platformTarget } from '@indx-workspace/platforms';
import { SAMPLE_PORTABLE_PROJECT } from '@indx-workspace/platforms/testing';
import { describe, expect, it } from 'vitest';

/**
 * The ejected Claude Agent SDK project and the platform's Claude engine must give Write files the
 * same rules (#2232). The engine builds its allow rule from the run's `cwd`
 * (`claudeWriteFilesApprovals`) and a read-only path as a deny rule (`claudeReadOnlyGrantDenials`).
 * The ejected program knows its directories only at run time, so it carries its own rule builder
 * (`editRule` in `src/agent.ts`). This test runs that generated function and fails if it ever
 * answers differently from the platform for the same directory, and checks that the agent can write
 * only inside its working directory, `workspace/`, never the program beside it.
 */

type Permissions = (typeof SAMPLE_PORTABLE_PROJECT.agents)[number]['permissions'];
const ALL_ON: Permissions = {
  readFiles: true,
  writeFiles: true,
  runCommands: true,
  unrestrictedNetwork: true,
};

function withPermissions(root: Partial<Permissions>, subagent: Partial<Permissions> = {}) {
  return {
    ...SAMPLE_PORTABLE_PROJECT,
    agents: SAMPLE_PORTABLE_PROJECT.agents.map((agent, index) => ({
      ...agent,
      permissions: { ...ALL_ON, ...(index === 0 ? root : subagent) },
    })),
  };
}

function ejected(project: unknown) {
  const target = platformTarget('eject-claude-agent-sdk');
  if (target === undefined) throw new Error('eject-claude-agent-sdk is not registered');
  const result = compileForPlatform(target, PortableProjectSchema.parse(project), {});
  if (!result.ok) throw new Error(`refused: ${result.refusal.code}`);
  const agent = result.files.find((file) => file.path === 'src/agent.ts');
  if (agent === undefined) throw new Error('no src/agent.ts');
  return { files: result.files.map((file) => file.path), source: String(agent.content) };
}

type RuleBuilder = (directory: string, relative: string) => string;

/** The generated `editRule`, type-stripped and evaluated in a fresh context. */
function generatedRule(source: string): RuleBuilder {
  const match =
    /^function editRule\(directory: string, relative: string\): string \{\n[\s\S]*?\n\}$/mu.exec(
      source,
    );
  if (match === null) throw new Error('src/agent.ts has no editRule');
  const rule: unknown = runInNewContext(`${stripTypeScriptTypes(match[0])}\neditRule;`);
  if (typeof rule !== 'function') throw new Error('editRule is not a function');
  const call = rule as (directory: string, relative: string) => unknown;
  return (directory, relative) => String(call(directory, relative));
}

interface Rule {
  /** The directory the rule is built from, as the generated code names it. */
  readonly directory: 'workDir' | 'projectRoot';
  readonly pattern: string;
}

/** The rules the root agent's options pass, in order, for one options key. */
function rules(source: string, key: 'allowedTools' | 'disallowedTools'): Rule[] {
  const block = new RegExp(`^ {4}${key}: \\[([\\s\\S]*?)\\n {4}\\]`, 'mu').exec(source)?.[1] ?? '';
  return [...block.matchAll(/editRule\((workDir|projectRoot), "([^"]*)"\)/gu)].map((match) => ({
    directory: match[1] === 'workDir' ? 'workDir' : 'projectRoot',
    pattern: match[2] ?? '',
  }));
}

/** A Claude Code path rule as a regular expression over a path relative to its directory. */
function globToRegExp(pattern: string): RegExp {
  let out = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const rest = pattern.slice(index);
    if (rest.startsWith('**/')) {
      out += '(?:.*/)?';
      index += 2;
    } else if (rest.startsWith('**')) {
      out += '.*';
      index += 1;
    } else if (rest.startsWith('*')) {
      out += '[^/]*';
    } else {
      out += (rest[0] ?? '').replace(/[.+?^${}()|[\]\\]/gu, '\\$&');
    }
  }
  return new RegExp(`^${out}$`, 'u');
}

/** Whether the options let the agent write `path` (relative to the project root) without asking. */
function writable(source: string, path: string): boolean {
  const relativeTo = (rule: Rule): string | null => {
    if (rule.directory === 'projectRoot') return path;
    return path.startsWith('workspace/') ? path.slice('workspace/'.length) : null;
  };
  const matches = (rule: Rule): boolean => {
    const relative = relativeTo(rule);
    return relative !== null && globToRegExp(rule.pattern).test(relative);
  };
  return (
    rules(source, 'allowedTools').some(matches) && !rules(source, 'disallowedTools').some(matches)
  );
}

/** The engine's allow rule for the same directory, for an agent with no stored policy. */
function engineAllowRule(cwd: string): readonly string[] {
  const tools = compileClaudeToolPolicy(ALL_ON, {
    stored: null,
    fileGrantDeny: [],
    mcpServers: {},
  });
  return claudeWriteFilesApprovals(ALL_ON, tools, [], cwd);
}

const DIRECTORIES = [
  '/home/me/support-triage/workspace',
  '/home/me/support-triage/workspace/',
  '/srv/agents//x//',
  'C:\\Users\\me\\support-triage\\workspace',
  'D:/work/agent/',
  '/path with spaces/ünïcode',
];

/** Paths that would change the program, or what runs or loads on a later run, if written. */
const OUT_OF_REACH = [
  '.env',
  '.envrc',
  '.mcp.json',
  'CLAUDE.md',
  '.claude.md',
  '.claude/settings.json',
  '.vscode/tasks.json',
  '.vscode/settings.json',
  '.idea/workspace.xml',
  '.husky/pre-commit',
  '.github/workflows/ci.yml',
  '.devcontainer/devcontainer.json',
  '.git/hooks/pre-commit',
  '.npmrc',
  'Makefile',
  'vitest.config.ts',
  'eslint.config.mjs',
  'package-lock.json',
  'node_modules/x/index.js',
  'tools/get_order.run.ts',
  'workspace/CLAUDE.md',
  'workspace/outputs/CLAUDE.md',
  'workspace/.claude/settings.json',
  'workspace/.claude/skills/refund-policy/SKILL.md',
  'workspace/.mcp.json',
];

describe('ejected Claude project: Write files (#2232 carried over)', () => {
  const { files, source } = ejected(withPermissions({}));
  const rule = generatedRule(source);

  it('runs the agent in workspace/ and allows writing there, in permissionMode default', () => {
    expect(source).toContain('const workDir = path.join(projectRoot, "workspace");');
    expect(source).toContain('cwd: workDir,');
    expect(source).toContain('await mkdir(workDir, { recursive: true });');
    expect(rules(source, 'allowedTools')).toEqual([{ directory: 'workDir', pattern: '**' }]);
    expect(source).toContain('permissionMode: "default"');
  });

  it.each(DIRECTORIES)('builds the same allow rule as the engine for %s', (directory) => {
    expect([rule(directory, '**')]).toEqual(engineAllowRule(directory));
  });

  it.each(DIRECTORIES)(
    'builds a protected directory and file the way a read-only grant does for %s',
    (directory) => {
      const grants = claudeReadOnlyGrantDenials(directory, [
        { path: '.claude', kind: 'directory' },
        { path: 'CLAUDE.md', kind: 'file' },
      ]);
      expect([rule(directory, '.claude/**'), rule(directory, 'CLAUDE.md')]).toEqual(
        grants.slice(0, 2),
      );
    },
  );

  it('lets the agent write its own files in workspace/', () => {
    for (const path of ['workspace/outputs/a.md', 'workspace/notes.txt', 'workspace/data/x.csv']) {
      expect(writable(source, path), `${path} is not writable`).toBe(true);
    }
  });

  it('keeps every file the eject writes, and what a later run or tool loads, out of reach', () => {
    for (const path of [...files.filter((file) => file !== 'report.json'), ...OUT_OF_REACH]) {
      expect(writable(source, path), `${path} is writable by the ejected agent`).toBe(false);
    }
  });

  it('puts the skills inside the working directory, where Claude Code loads them', () => {
    expect(files.filter((file) => file.includes('/skills/'))).toEqual([
      'workspace/.claude/skills/refund-policy/SKILL.md',
    ]);
  });

  it('adds no rule and no rule builder when the root agent may not write files', () => {
    const readOnly = ejected(withPermissions({ writeFiles: false })).source;
    expect(readOnly).not.toContain('editRule');
    expect(readOnly).toContain('cwd: workDir,');
    expect(readOnly).toMatch(/disallowedTools: \[[^\]]*"Write"[^\]]*"Edit"[^\]]*"NotebookEdit"/u);
  });

  it('keeps the write tools denied for a subagent whose Write files is off', () => {
    const mixed = ejected(withPermissions({}, { writeFiles: false })).source;
    expect(rules(mixed, 'allowedTools')).toEqual([{ directory: 'workDir', pattern: '**' }]);
    const subagents = /agents: \{[\s\S]*$/u.exec(mixed)?.[0] ?? '';
    expect(subagents).toMatch(/disallowedTools: \[[^\]]*"Write"[^\]]*"Edit"[^\]]*"NotebookEdit"/u);
  });
});
