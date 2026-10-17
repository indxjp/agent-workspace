/**
 * What a run of each gallery agent can reach, not only what its stored definition says.
 *
 * The per-project tests read the policy `aw push` stores. A live run is compiled from it again: the
 * file grants add their own denials, and a deny rule wins over `autoApprove`. This test compiles the
 * policy a local run gets, with the engine adapter's own functions, and checks that the files the
 * install-live harness uploads sit under a grant, that the file tools can read them, and that every
 * tool the agent pre-approves is still there to be called.
 *
 * The harness also starts each project's MCP servers with `FILE_ROOT=<project>/data`; the cases
 * name files those servers must find, so the folder has to ship them. And a run's shell gets only
 * the environment the runner builds, so quotation's skill script needs `node` on that `PATH`.
 *
 * The four agents that hold a read-only grant and run skill scripts pre-approve
 * `mcp__agent-workspace__run_skill_script` (ADR-0137), not Bash: the grant still withholds the shell,
 * and the tool the scripts run through is not in the deny list.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  CLAUDE_SKILL_SCRIPT_TOOL,
  claudeFileGrantDenials,
  compileClaudeToolPolicy,
} from '@agent-workspace/engine-claude-agent-sdk';
import { toAgentVersionBody } from '@indx-workspace/sdk/define';
import { readEvalCaseFile } from '@indx-workspace/sdk/project';
import { describe, expect, it } from 'vitest';

import { runnerBaseEnvironment, runnerEnvironmentFor } from '../../apps/runner/src/environment.ts';
import { fileSetupCommands, serverCommands } from '../docs-claims/use-cases.mjs';
import cadDrafting from './cad-drafting/agents/cad-drafting.ts';
import contractReview from './contract-review/agents/contract-review.ts';
import customerInquiry from './customer-inquiry/agents/customer-inquiry.ts';
import excelConsolidation from './excel-consolidation/agents/excel-consolidation.ts';
import { BRANCH_FILES } from './excel-consolidation/data/branch-workbooks.ts';
import { GALLERY_DIR } from './harness/registry.ts';
import maintenanceTroubleshooting from './maintenance-troubleshooting/agents/maintenance-troubleshooting.ts';
import manualSearch from './manual-search/agents/manual-search.ts';
import meetingMinutes from './meeting-minutes/agents/meeting-minutes.ts';
import qualityDefect from './quality-defect/agents/quality-defect.ts';
import quotation from './quotation/agents/quotation.ts';
import ringiReview from './ringi-review/agents/ringi-review.ts';

const CWD = '/w';

const AGENTS = [
  ['cad-drafting', cadDrafting],
  ['contract-review', contractReview],
  ['customer-inquiry', customerInquiry],
  ['excel-consolidation', excelConsolidation],
  ['maintenance-troubleshooting', maintenanceTroubleshooting],
  ['manual-search', manualSearch],
  ['meeting-minutes', meetingMinutes],
  ['quality-defect', qualityDefect],
  ['quotation', quotation],
  ['ringi-review', ringiReview],
] as const;

/** Agents whose skill scripts run through `run_skill_script` beside a read-only grant. */
const SCRIPT_RUNNERS = ['cad-drafting', 'contract-review', 'meeting-minutes', 'quality-defect'];

/** Granted folders the agent writes into: nothing is uploaded there. */
const OUTPUT_FOLDERS: Readonly<Record<string, readonly string[]>> = {
  'cad-drafting': ['drafts'],
};

function runTimePolicy(agent: (typeof AGENTS)[number][1]) {
  const body = toAgentVersionBody(agent, {
    surfaces: [],
    instructions: 'x',
    defaultEngine: 'claude-agent-sdk',
  });
  const { policy, agent: configured, resources } = body.definition;
  if (policy?.engine !== 'claude-agent-sdk') throw new Error('expected a Claude policy');
  const grants = resources.files.map((file) => ({
    kind: 'directory' as const,
    path: file.path,
    access: file.access,
  }));
  const denials = claudeFileGrantDenials(CWD, grants, '.claude');
  if (!denials.ok) throw new Error(denials.reason);
  const compiled = compileClaudeToolPolicy(configured.permissions, {
    stored: policy.tools,
    fileGrantDeny: denials.deny,
    mcpServers: {},
  });
  return {
    compiled,
    folders: grants.map((grant) => grant.path),
    skills: [...resources.skills],
  };
}

describe('what a run of each gallery agent can reach', () => {
  it.each(AGENTS)(
    '%s: the uploaded files sit under a grant the file tools can read',
    (id, agent) => {
      const { compiled, folders } = runTimePolicy(agent);
      const uploaded = fileSetupCommands(path.join(GALLERY_DIR, id)).flatMap((command) => {
        const destination = /^aw files upload '([^']+)'/u.exec(command)?.[1];
        return destination === undefined ? [] : [destination];
      });
      for (const destination of uploaded) {
        expect(folders, `${destination} is not under a file grant`).toContain(
          destination.split('/')[0],
        );
      }
      for (const folder of folders.filter((name) => !OUTPUT_FOLDERS[id]?.includes(name))) {
        expect(
          uploaded.some((destination) => destination.startsWith(`${folder}/`)),
          `the harness uploads nothing into ${folder}/, so the agent finds it empty`,
        ).toBe(true);
      }
      if (folders.length > 0) {
        for (const tool of ['Read', 'Glob', 'Grep']) expect(compiled.deny).not.toContain(tool);
      }
    },
  );

  it.each(AGENTS)('%s: every pre-approved tool is still available to the run', (id, agent) => {
    const { compiled } = runTimePolicy(agent);
    expect(compiled.autoApprove.filter((tool) => compiled.deny.includes(tool))).toEqual([]);
    if (SCRIPT_RUNNERS.includes(id)) {
      expect(compiled.autoApprove).toContain(CLAUDE_SKILL_SCRIPT_TOOL);
      expect(compiled.deny).not.toContain(CLAUDE_SKILL_SCRIPT_TOOL);
      expect(compiled.deny, `${id} holds a read-only grant`).toContain('Bash');
      expect(compiled.autoApprove).not.toContain('Bash');
    }
  });
});

/** What tells a model to use a shell: a fenced shell block, a `node scripts/` command, a pipe into node. */
const SHELL_INSTRUCTION = /```(?:sh|bash|shell)\b|node scripts\/|\|\s*node\b/u;

describe('what a run without a shell is told to do', () => {
  it.each(AGENTS)('%s: no instruction or skill asks for a shell it does not have', (id, agent) => {
    const { compiled, skills } = runTimePolicy(agent);
    if (!compiled.deny.includes('Bash')) return;
    const dir = path.join(GALLERY_DIR, id);
    const instructions = readFileSync(path.join(dir, 'agents', `${id}.md`), 'utf8');
    const documents = [
      { name: `agents/${id}.md`, text: instructions, scripts: false },
      ...skills.map((skill) => {
        const folder = [
          path.join(dir, 'skills', skill),
          path.join(GALLERY_DIR, 'shared', 'skills', skill),
        ].find((candidate) => existsSync(path.join(candidate, 'SKILL.md')));
        if (folder === undefined) throw new Error(`${id}: no SKILL.md for skill ${skill}`);
        return {
          name: `skills/${skill}/SKILL.md`,
          text: readFileSync(path.join(folder, 'SKILL.md'), 'utf8'),
          scripts: existsSync(path.join(folder, 'scripts')),
        };
      }),
    ];
    for (const { name, text, scripts } of documents) {
      expect(text, `${id}: ${name} tells the run to use a shell`).not.toMatch(SHELL_INSTRUCTION);
      if (scripts) {
        expect(
          `${instructions}\n${text}`,
          `${id}: ${name} has scripts but never names run_skill_script`,
        ).toContain('run_skill_script');
      }
    }
  });
});

/** The files a project's fixture source writes, for a case that names one by its stem only. */
const FIXTURE_FILES: Readonly<Record<string, readonly string[]>> = {
  'excel-consolidation': BRANCH_FILES.map((file) => file.path),
};

const FILE_NAME = /[^\s"'`、。，（）()「」]+\.(?:xlsx|xls|docx|pdf|csv|txt|json)/gu;

/** The file names a project's eval cases name: in an input or an expected phrase, or by stem. */
function namedFiles(id: string): string[] {
  const text = readFileSync(path.join(GALLERY_DIR, id, 'evals', `${id}.yaml`), 'utf8');
  const phrases = readEvalCaseFile(text, `evals/${id}.yaml`).cases.flatMap((entry) => [
    entry.input,
    ...(entry.expect.contains ?? []),
  ]);
  const fixtures = (FIXTURE_FILES[id] ?? []).map((file) => path.basename(file));
  const named = phrases.flatMap((phrase) => [
    ...(phrase.match(FILE_NAME) ?? []).map((name) => path.basename(name)),
    ...fixtures.filter((file) => file.replace(/\.[^.]+$/u, '') === phrase),
  ]);
  return [...new Set(named)];
}

describe('what the harness serves from FILE_ROOT', () => {
  it('every MCP server it points at <project>/data finds the files the cases name', () => {
    const checked: string[] = [];
    for (const [id] of AGENTS) {
      const dir = path.join(GALLERY_DIR, id);
      const root = path.join(dir, 'data');
      const yaml = readFileSync(path.join(dir, 'agent-workspace.yaml'), 'utf8');
      const rooted = serverCommands(yaml, () => 'x', { FILE_ROOT: root }).filter(
        (server) => server.env['FILE_ROOT'] === root,
      );
      if (rooted.length === 0) continue;
      checked.push(id);
      const present = readdirSync(root, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name.normalize('NFC'));
      expect(namedFiles(id), `${id}: no case names a file under FILE_ROOT`).not.toEqual([]);
      for (const name of namedFiles(id)) {
        expect(present, `${id}: a case names ${name}, which FILE_ROOT does not hold`).toContain(
          name.normalize('NFC'),
        );
      }
    }
    expect(checked).toContain('excel-consolidation');
  });
});

describe('what the shell of a quotation run can start', () => {
  it('runs the cost-model script with the environment the runner builds for the run', () => {
    const { compiled } = runTimePolicy(quotation);
    expect(compiled.autoApprove).toContain('Bash');
    expect(compiled.deny).not.toContain('Bash');

    // The run request's own keys (compose/run-request.ts). The container's PATH is the only way
    // the run's shell can find the `node` the host installed.
    const systemRoot = process.env['SystemRoot'];
    const container = {
      PATH: [
        path.dirname(process.execPath),
        ...(systemRoot === undefined ? ['/usr/bin', '/bin'] : [path.join(systemRoot, 'System32')]),
      ].join(path.delimiter),
      HOME: tmpdir(),
      ...(systemRoot === undefined ? {} : { SystemRoot: systemRoot }),
      PROVIDER_MASTER_KEY: 'must-not-cross',
    };
    const env = runnerEnvironmentFor(
      {
        ANTHROPIC_BASE_URL: 'http://gateway:4000',
        ANTHROPIC_AUTH_TOKEN: 'run-token',
        NODE_USE_ENV_PROXY: '1',
      },
      runnerBaseEnvironment(container),
    );
    expect(env['PATH']).toBe(container.PATH);
    expect(env).not.toHaveProperty('PROVIDER_MASTER_KEY');

    const cwd = mkdtempSync(path.join(tmpdir(), 'quotation-run-'));
    try {
      const skill = path.join(cwd, '.claude', 'skills', 'cost-model');
      const source = path.join(GALLERY_DIR, 'quotation');
      cpSync(path.join(source, 'skills', 'cost-model'), skill, { recursive: true });
      const spec: unknown = JSON.parse(
        readFileSync(path.join(source, 'data', 'specs', 'bracket-ss400.json'), 'utf8'),
      );
      const rates = JSON.parse(
        readFileSync(path.join(source, 'data', 'erp', 'rates.json'), 'utf8'),
      ) as Record<string, unknown>;
      // `shell: true` is /bin/sh on POSIX and %ComSpec% on Windows: the run's shell either way.
      const run = spawnSync('node scripts/estimate.mjs', {
        shell: true,
        cwd: skill,
        env,
        input: JSON.stringify({ spec, rate: rates['SS400'] }),
        encoding: 'utf8',
      });
      expect(run.stderr).toBe('');
      expect(JSON.parse(run.stdout)).toMatchObject({ taxIncluded: false });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
