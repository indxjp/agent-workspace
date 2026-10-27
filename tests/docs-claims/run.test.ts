import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { SETUP_QUESTIONS } from '@indx-workspace/contracts/setup';
import { afterEach, describe, expect, it } from 'vitest';

import { JourneyFailure, quickstartCommands } from '../journey/harness.mjs';
import { watchDev } from '../journey/run.mjs';

import { extractClaims, extractRepositoryClaims } from './extract.mjs';
import { createHostMachine } from './host.mjs';
import type { Machine } from './run.d.mts';
import {
  compileSources,
  exitCodeOf,
  ownedRows,
  parseArguments,
  runPage,
  runPlans,
  save,
  staticRows,
  summaryMarkdown,
  tscDiagnostics,
} from './run.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const fence = (meta: string, body: string): string => `\`\`\`${meta}\n${body}\n\`\`\`\n`;

describe('the switches', () => {
  it('defaults to a Verdaccio of this checkout and the fake model', () => {
    expect(parseArguments([], {})).toEqual({
      registry: null,
      live: false,
      apiKey: '',
      staticOnly: false,
      machine: 'container',
      shell: 'sh',
    });
  });

  it('takes a registry, the live model under its key, and --static', () => {
    const options = parseArguments(['--registry', 'https://registry.example/', '--model', 'live'], {
      ANTHROPIC_API_KEY: ' k ',
    });
    expect(options.registry).toBe('https://registry.example/');
    expect(options.live).toBe(true);
    expect(options.apiKey).toBe('k');
    expect(parseArguments(['--static'], {}).staticOnly).toBe(true);
  });

  it('takes the live model without its key: its rows are skipped, not refused', () => {
    const options = parseArguments(['--model', 'live'], {});
    expect(options).toMatchObject({ live: true, apiKey: '' });
    expect(parseArguments(['--model', 'live'], { ANTHROPIC_API_KEY: '  ' }).apiKey).toBe('');
  });

  it('refuses an unknown model and an unknown switch', () => {
    expect(() => parseArguments(['--model', 'gpt'], {})).toThrow('fake or live');
    expect(() => parseArguments(['--nope'], {})).toThrow('usage:');
  });

  it('runs on the host in a named shell, from a registry', () => {
    const registry = ['--registry', 'https://registry.npmjs.org/'];
    expect(parseArguments([...registry, '--machine', 'host'], {})).toMatchObject({
      machine: 'host',
      shell: 'sh',
    });
    for (const shell of ['sh', 'bash', 'pwsh']) {
      expect(parseArguments([...registry, '--machine', 'host', '--shell', shell], {}).shell).toBe(
        shell,
      );
    }
  });

  it('refuses a host without a registry, a shell for the container, an unknown machine or shell', () => {
    expect(() => parseArguments(['--machine', 'host'], {})).toThrow('needs --registry');
    expect(() => parseArguments(['--shell', 'bash'], {})).toThrow('needs --machine host');
    expect(() => parseArguments(['--machine', 'vm'], {})).toThrow('container or host');
    expect(() =>
      parseArguments(
        ['--registry', 'https://r.example/', '--machine', 'host', '--shell', 'fish'],
        {},
      ),
    ).toThrow('--shell is');
  });
});

describe('the run plan', () => {
  const page = (name: string, blocks: string[]) =>
    extractClaims(name, blocks.map((body) => fence('sh claim="run"', body)).join('\n'));

  it('runs a page in order and skips a block an earlier block of the page already ran', () => {
    const [plan] = runPlans(page('a.mdx', ['npm install', 'cd x && ls', 'npm install']));
    expect(plan?.blocks.map((block) => block.commands)).toEqual([
      ['npm install'],
      ['cd x', 'ls'],
      ['npm install'],
    ]);
    expect(plan?.blocks.map((block) => block.sameAsLine)).toEqual([undefined, undefined, 1]);
  });

  it('starts each block that creates a project in a fresh directory (quickstart: bare create, then create my-agent)', () => {
    const [plan] = runPlans(
      page('a.mdx', ['npm create x', 'npm create x my-agent -- --yes && cd my-agent', 'ls']),
    );
    expect(plan?.blocks.map((block) => block.fresh)).toEqual([true, true, undefined]);
  });

  it("leaves a page to the first-hour leg only when its every block is the leg's commands", () => {
    const owned = ['npm create x my-agent -- --yes', 'cd my-agent', 'npm run dev'];
    const block = 'npm create x my-agent -- --yes\ncd my-agent\nnpm run dev';
    const [twice] = runPlans(page('a.mdx', [block, block]));
    const [more] = runPlans(page('b.mdx', [block, 'npx aw platforms list']));
    if (twice === undefined || more === undefined) throw new Error('no plan');
    expect(ownedRows(twice, owned)?.map((row) => [row.where, row.result])).toEqual([
      ['a.mdx:1', 'owned by journey-e2e first-hour (T1-T3 run these commands)'],
      ['a.mdx:7', 'owned by journey-e2e first-hour (T1-T3 run these commands)'],
    ]);
    expect(exitCodeOf(ownedRows(twice, owned) ?? [])).toBe(0);
    expect(ownedRows(more, owned)).toBeNull();
    // Off the journey's machine, registry or model nothing is owned: every page runs.
    expect(ownedRows(twice, [])).toBeNull();
  });

  it("owns the repository's install block pages through quickstart.mdx", () => {
    const owned = quickstartCommands(
      readFileSync(path.join(ROOT, 'docs/sdk/site/getting-started/quickstart.mdx'), 'utf8'),
    );
    const pages = runPlans(extractRepositoryClaims(ROOT))
      .filter((plan) => ownedRows(plan, owned) !== null)
      .map((plan) => plan.page);
    expect(pages).toEqual(
      expect.arrayContaining([
        'README.md',
        'docs/sdk/site/getting-started/quickstart.mdx',
        'sites/lp/index.html',
      ]),
    );
  });

  it('runs pages with the same commands once', () => {
    const plans = runPlans([
      ...page('a.mdx', ['npm install']),
      ...page('b.mdx', ['npm install']),
      ...page('c.mdx', ['npm run dev']),
    ]);
    expect(plans.map((plan) => plan.sameAsPage)).toEqual([undefined, 'a.mdx', undefined]);
  });

  it('plans nothing for a claim that is not a run', () => {
    const claims = extractClaims(
      'a.mdx',
      fence('sh title="illustrative" claim="illustrative"', 'rm -rf x'),
    );
    expect(runPlans(claims)).toEqual([]);
  });

  it('plans the repository: every shell block that is run is planned, install block included', () => {
    const plans = runPlans(extractRepositoryClaims(ROOT));
    expect(plans.length).toBeGreaterThan(5);
    const commands = plans.flatMap((plan) => plan.blocks.flatMap((block) => block.commands));
    expect(commands).toContain('npm create @indx-workspace@latest my-agent -- --yes');
    expect(commands).toContain('npm run dev');
  });
});

describe('the compile project', () => {
  it('gives each compile claim a module of its own', () => {
    const claims = extractClaims(
      'a.mdx',
      [
        fence('ts claim="compile"', 'const a = 1;'),
        fence('tsx claim="compile"', 'const b = <p />;'),
        fence('ts title="illustrative" claim="illustrative"', 'nope'),
      ].join('\n'),
    );
    const sources = compileSources(claims);
    expect(sources.map((source) => source.name)).toEqual(['src/c0.ts', 'src/c1.tsx']);
    expect(sources[0]?.text).toBe('const a = 1;\nexport {};\n');
  });

  it('reads the line and message of each tsc error by file', () => {
    const found = tscDiagnostics(
      [
        "src/c0.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'.",
        "src/c1.tsx(1,1): error TS2304: Cannot find name 'x'.",
        "src/c0.ts(9,1): error TS1005: ';' expected.",
        'Found 3 errors.',
      ].join('\n'),
    );
    expect(found.get('src/c0.ts')?.map((diagnostic) => diagnostic.line)).toEqual([3, 9]);
    expect(found.get('src/c1.tsx')?.[0]?.message).toBe("error TS2304: Cannot find name 'x'.");
    expect(tscDiagnostics('')).toEqual(new Map());
  });
});

describe('the summary', () => {
  it('has one row per claim and the output of each failing claim', () => {
    const markdown = summaryMarkdown(
      [
        { where: 'a.mdx:3', state: 'run', what: 'npm install', result: 'pass', seconds: 1.5 },
        { where: 'b.mdx:9', state: 'compile', what: 'a | b', result: 'FAIL: x', detail: 'boom' },
        { where: 'c.mdx:1', state: 'illustrative', what: 'x', result: 'labelled on the page' },
      ],
      ['A note.'],
    );
    expect(markdown).toContain(
      '3 claims (1 run, 1 compile, 1 illustrative), 1 failing, 0 skipped, 0 n/a',
    );
    expect(markdown).toContain('| page:line | state | command or file | result | duration |');
    expect(markdown).toContain('| a.mdx:3 | run | npm install | pass | 1.5 s |');
    expect(markdown).toContain('| b.mdx:9 | compile | a \\| b | FAIL: x |  |');
    expect(markdown).toContain('#### b.mdx:9\n\n```text\nboom\n```');
    expect(markdown).toContain('A note.');
    expect(markdown).not.toContain('#### a.mdx:3');
  });
});

describe('a run without its key or for another shell', () => {
  const row = (result: string) => ({ where: 'a.mdx:1', state: 'run', what: 'x', result });
  const NO_KEY = 'skipped: needs ANTHROPIC_API_KEY (not configured)';

  it('is red for a failing or skipped row and green for pass and n/a', () => {
    const fine = [row('pass'), row('pass (same commands as b.mdx)'), row('n/a (powershell only)')];
    expect(exitCodeOf(fine)).toBe(0);
    expect(exitCodeOf([...fine, row('FAIL: a command did not exit 0')])).toBe(1);
    expect(exitCodeOf([...fine, row(NO_KEY)])).toBe(1);
    expect(exitCodeOf([])).toBe(0);
  });

  it('counts skipped and n/a rows in the summary heading', () => {
    const markdown = summaryMarkdown(
      [
        row('pass'),
        row(NO_KEY),
        row('skipped: an earlier block of the page failed'),
        row('n/a (powershell only)'),
      ],
      [],
    );
    expect(markdown).toContain('4 claims (4 run), 0 failing, 2 skipped, 1 n/a');
    expect(markdown).not.toContain('####');
  });
});

describe('the checks that need no container', () => {
  const claims = extractRepositoryClaims(ROOT);

  it('hold on the repository: every file copy, the stack builder flags and the install block', () => {
    const rows = staticRows(
      claims,
      SETUP_QUESTIONS.map((question) => question.flag),
    );
    expect(rows.filter((row) => row.result.startsWith('FAIL'))).toEqual([]);
    expect(rows.some((row) => row.state === 'file' && row.what.includes('CREATE_FLAGS'))).toBe(
      true,
    );
    expect(rows.filter((row) => row.state === 'illustrative').length).toBeGreaterThan(0);
  });

  it('fail on a flag the stack builder writes and npm create does not have', () => {
    const rows = staticRows(claims, ['--theme']);
    expect(rows.find((row) => row.what.includes('CREATE_FLAGS'))?.result).toMatch(/^FAIL/u);
  });
});

describe('watchDev stop', () => {
  type Child = Parameters<typeof watchDev>[0];
  const stopWith = async (
    cleanExits: readonly (number | null)[] | null,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): Promise<void> => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    const run = watchDev(child as unknown as Child, {
      interrupt: () => {
        queueMicrotask(() => child.emit('close', code, signal));
        return Promise.resolve();
      },
      survivors: () => Promise.resolve(''),
      cleanExits,
    });
    await run.stop((cap) => cap);
  };

  it('counts a death by our own SIGINT as clean (macOS reports no exit code)', async () => {
    await expect(stopWith([0, 130], null, 'SIGINT')).resolves.toBeUndefined();
  });

  it('counts the shell exit code 130 as clean', async () => {
    await expect(stopWith([0, 130], 130, null)).resolves.toBeUndefined();
  });

  it('rejects any other signal or exit code', async () => {
    await expect(stopWith([0, 130], null, 'SIGKILL')).rejects.toThrow(/not cleanly/u);
    await expect(stopWith([0, 130], 1, null)).rejects.toThrow(/not cleanly/u);
  });

  it('accepts anything where the machine can only kill (Windows)', async () => {
    await expect(stopWith(null, null, 'SIGKILL')).resolves.toBeUndefined();
  });
});

describe('the workflow that runs the claims', () => {
  const ci = readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');

  function jobBlock(jobId: string): string {
    const lines = ci.split(/\r?\n/u);
    const start = lines.indexOf(`  ${jobId}:`);
    if (start < 0) throw new Error(`ci.yml has no ${jobId} job`);
    const nextJob = lines.findIndex(
      (line, index) => index > start && /^ {2}[a-zA-Z0-9_-]+:\s*$/u.test(line),
    );
    return lines.slice(start, nextJob < 0 ? undefined : nextJob).join('\n');
  }

  const workflow = jobBlock('docs-claims');
  const scopePattern = /^ {10}pattern='([^']+)'$/mu.exec(workflow)?.[1];
  if (scopePattern === undefined) {
    throw new Error("the docs-claims job has no scope step line `pattern='…'`");
  }
  const scope = new RegExp(scopePattern, 'u');

  function localImports(entry: string): string[] {
    const seen = new Set<string>();
    const pending = [entry];
    for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
      if (seen.has(next)) continue;
      seen.add(next);
      const source = readFileSync(path.join(ROOT, next), 'utf8');
      for (const match of source.matchAll(/^import [^;]*? from '(\.{1,2}\/[^']+)';$/gmsu)) {
        const specifier = match[1];
        if (specifier === undefined) continue;
        pending.push(path.posix.join(path.posix.dirname(next), specifier));
      }
    }
    return [...seen].sort();
  }

  it('runs on a change to a page, a package, the runner or any file the runner imports', () => {
    const imported = localImports('tests/docs-claims/run.mjs');
    expect(imported).toContain('tests/journey/run.mjs');
    expect(imported.filter((file) => !scope.test(file))).toEqual([]);
    for (const file of [
      'README.md',
      'packages/aw/README.md',
      'packages/sdk/src/index.ts',
      'docs/sdk/site/getting-started/quickstart.mdx',
      'sites/lp/index.html',
      'sites/lp/assets/site.js',
      'tests/docs-claims/extract.mjs',
      'tests/gallery/manual-search/agents/manual-search.ts',
      '.github/workflows/ci.yml',
    ]) {
      expect(scope.test(file), file).toBe(true);
    }
    expect(scope.test('docs/operations/ci.md')).toBe(false);
    expect(scope.test('CHANGELOG.md')).toBe(false);
  });

  it('is a ci-success need, filtered in a step, with the build the runner imports from', () => {
    expect(existsSync(path.join(ROOT, '.github', 'workflows', 'docs-claims.yml'))).toBe(false);
    const needs = /^ {4}needs:\s*\[([^\]]*)\]$/mu.exec(jobBlock('ci-success'))?.[1] ?? '';
    expect(needs.split(',').map((job) => job.trim())).toContain('docs-claims');
    // Only the heavy-tier condition (ci.yml, COST) may skip the job.
    expect(workflow).not.toMatch(/^ {4}if:(?! >-\r?\n {6}github\.event_name == 'schedule')/mu);
    expect(workflow).toContain('run: node tests/docs-claims/run.mjs');
    // Built once by ci.yml's `build` job and restored here, never rebuilt.
    expect(workflow).toContain('uses: ./.github/actions/workspace-build');
    expect(workflow).not.toContain('scripts/ci/nx.sh');
  });

  it('uploads the table and logs from where run.mjs writes them', () => {
    expect(workflow).toContain('DOCS_CLAIMS_WORK_DIR: ${{ runner.temp }}/docs-claims');
    expect(/^ {10}path: \|\n((?: {12}.+\n?)+)/mu.exec(workflow)?.[1]?.split('\n')).toEqual([
      '            ${{ runner.temp }}/docs-claims/summary.md',
      '            ${{ runner.temp }}/docs-claims/results.json',
      '            ${{ runner.temp }}/docs-claims/logs/',
      '',
    ]);
  });

  it('fits its steps inside the job timeout', () => {
    const numberOf = (pattern: RegExp): number => Number(pattern.exec(workflow)?.[1] ?? Number.NaN);
    const job = numberOf(/^ {4}timeout-minutes: (\d+)$/mu);
    const install = numberOf(/- name: Install\n {8}timeout-minutes: (\d+)/u);
    const claims = numberOf(
      /- name: Run, compile and compare every documented claim\n {8}timeout-minutes: (\d+)/u,
    );
    const setupAndUploads = 4;
    for (const value of [job, install, claims]) expect(Number.isSafeInteger(value)).toBe(true);
    expect(install + claims + setupAndUploads).toBeLessThanOrEqual(job);
  });
});

describe('the install-live workflow', () => {
  const source = readFileSync(path.join(ROOT, '.github', 'workflows', 'install-live.yml'), 'utf8');
  const steps = source
    .split(/^ {6}- /mu)
    .slice(1)
    .map((step) => `- ${step}`);
  const stepsUsing = (text: string) => steps.filter((step) => step.includes(text));

  it('runs on the three operating systems, from the public registry, with the real model', () => {
    for (const os of [
      '[self-hosted, ms-a2]',
      'blacksmith-6vcpu-macos-latest',
      'blacksmith-4vcpu-windows-2025',
    ]) {
      expect(source).toContain(`os: ${os}`);
    }
    expect(source).toContain('REGISTRY: https://registry.npmjs.org/');
    expect(source).not.toMatch(/verdaccio/iu);
    expect(source).toContain('--model live');
    for (const shell of ['sh', 'pwsh', 'bash']) expect(source).toContain(`--shell ${shell}`);
  });

  it('gives the key only to the two harness steps, in env, and never traces or echoes it', () => {
    const withKey = stepsUsing('secrets.ANTHROPIC_API_KEY');
    expect(withKey).toHaveLength(2);
    for (const step of withKey) {
      expect(step).toMatch(/\n {8}env:\n(?: {10}.+\n)*? {10}ANTHROPIC_API_KEY: \$\{\{ secrets\./u);
      expect(step).toMatch(/node tests\/docs-claims\/(?:run|use-cases)\.mjs/u);
    }
    expect(source.match(/\$\{\{ secrets\./gu)).toHaveLength(2);
    expect(source).not.toMatch(/set -\w*x|echo[^\n]*ANTHROPIC_API_KEY/u);
  });

  it('scans the evidence before it is uploaded, and uploads it only when the scan passed', () => {
    const scans = stepsUsing('run: node tests/docs-claims/scan-secrets.mjs');
    expect(scans).toHaveLength(2);
    for (const scan of scans) expect(scan).toContain('id: scan');
    const uploads = stepsUsing('actions/upload-artifact').filter((step) =>
      step.includes('/install-live/'),
    );
    expect(uploads).toHaveLength(2);
    for (const upload of uploads) expect(upload).toContain("steps.scan.outcome == 'success'");
    for (const job of ['claims', 'use-cases']) {
      const block = source.slice(source.indexOf(`\n  ${job}:`));
      expect(block.indexOf('scan-secrets.mjs')).toBeLessThan(block.indexOf('upload-artifact'));
    }
  });

  it('files issues from its report job only, for a failure, and never for a pull request', () => {
    expect(source).not.toMatch(/^\s*pull_request/mu);
    expect(source.match(/issues: write/gu)).toHaveLength(1);
    expect(source.indexOf('issues: write')).toBeGreaterThan(source.indexOf('\n  report:'));
    expect(source).toContain('gh label create install-live');
    expect(source).toContain('--label install-live');
    expect(source).toMatch(/ {12}fail\)\n(?:.*\n)*? {16}gh issue create/u);
    expect(source).not.toMatch(/skipped\)/u);
  });

  it('does not comment again on a failure set the open issue already reports', () => {
    const [step] = stepsUsing('gh issue comment');
    expect(step).toContain('DIGEST: ${{ steps.table.outputs.digest }}');
    expect(step).toContain('marker="<!-- install-live-digest:${DIGEST} -->"');
    expect(step).toContain('echo "$marker"');
    expect(step).toContain("--json body,comments --jq '[.body] + [.comments[].body] | last'");
    expect(step).toMatch(
      /\[\[ "\$latest" == \*"\$marker"\* \]\][^\n]*\n(?:.*\n)*? +else\n +gh issue comment/u,
    );
  });

  it('is not a required check', () => {
    const ci = readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
    const needs = /^ {2}ci-success:\n(?:.*\n)*? {4}needs:\s*\[([^\]]*)\]/mu.exec(ci)?.[1];
    expect(needs).toBeDefined();
    expect(needs).not.toMatch(/install-live|use-cases/u);
  });
});

describe('cleaning up after a page', () => {
  const roots: string[] = [];
  const scratch = (): string => {
    const root = mkdtempSync(path.join(tmpdir(), 'docs-claims-test-'));
    roots.push(root);
    return root;
  };
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  const [plan] = runPlans(
    extractClaims('a.mdx', fence('sh claim="run"', 'npm create x my-agent -- --yes')),
  );
  if (plan === undefined) throw new Error('the page plans one block');

  // A machine on this computer's file system whose commands leave a project behind, as npm does.
  const fakeMachine = (root: string, status: number, remove?: Machine['remove']): Machine => {
    const logs = path.join(root, 'logs');
    mkdirSync(logs);
    const make = (dir: string): Promise<void> => {
      mkdirSync(dir, { recursive: true });
      return Promise.resolve();
    };
    return {
      kind: 'host',
      shell: 'posix',
      fifo: false,
      env: {},
      commandMs: 1000,
      logs,
      claims: path.join(root, 'claims'),
      compile: path.join(root, 'compile'),
      resolve: (cwd, to) => path.resolve(cwd, to),
      mkdir: make,
      project: make,
      remove: remove ?? ((dir) => Promise.resolve(rmSync(dir, { recursive: true, force: true }))),
      list: () => Promise.resolve([]),
      stageCompile: (stage) => Promise.resolve(stage),
      exec: (_command, run) => {
        mkdirSync(path.join(run.cwd, 'node_modules', 'x'), { recursive: true });
        mkdirSync(path.join(run.cwd, '.agent-workspace', 'postgres'), { recursive: true });
        return Promise.resolve({ status, output: 'output', stdout: 'output' });
      },
      startDev: () => {
        throw new Error('not used');
      },
    };
  };

  it('removes the page directory and keeps its log', async () => {
    const machine = fakeMachine(scratch(), 0);
    const rows = await runPage(machine, plan, new Map(), false);
    expect(rows.map((row) => row.result)).toEqual(['pass']);
    expect(existsSync(path.join(machine.claims, plan.slug))).toBe(false);
    expect(readFileSync(path.join(machine.logs, `${plan.slug}.log`), 'utf8')).toContain('output');
  });

  it('removes it after a failing command too', async () => {
    const machine = fakeMachine(scratch(), 1);
    const rows = await runPage(machine, plan, new Map(), false);
    expect(rows[0]?.result).toMatch(/^FAIL/u);
    expect(existsSync(path.join(machine.claims, plan.slug))).toBe(false);
    expect(existsSync(path.join(machine.logs, `${plan.slug}.log`))).toBe(true);
  });

  it('does not change a claim when the removal fails', async () => {
    const machine = fakeMachine(scratch(), 0, () => Promise.reject(new Error('EBUSY')));
    const rows = await runPage(machine, plan, new Map(), false);
    expect(rows.map((row) => row.result)).toEqual(['pass']);
    expect(existsSync(path.join(machine.logs, `${plan.slug}.log`))).toBe(true);
  });

  it('refuses a page without a slug instead of removing the claims root', async () => {
    const machine = fakeMachine(scratch(), 0);
    mkdirSync(machine.claims);
    await expect(runPage(machine, { ...plan, slug: '' }, new Map(), false)).rejects.toThrow(
      JourneyFailure,
    );
    expect(existsSync(machine.claims)).toBe(true);
  });

  it('removes a nested project on the host machine', async () => {
    const work = scratch();
    const machine = createHostMachine({
      shell: 'sh',
      work,
      registry: 'http://127.0.0.1:1/',
      env: {},
      commandMs: 1000,
      logs: path.join(work, 'logs'),
    });
    const page = path.join(machine.claims, 'page');
    const project = path.join(page, '7');
    mkdirSync(path.join(project, 'node_modules', 'x'), { recursive: true });
    mkdirSync(path.join(project, '.agent-workspace', 'postgres'), { recursive: true });
    writeFileSync(path.join(project, '.agent-workspace', 'postgres', 'PG_VERSION'), '16');
    await machine.remove(page);
    expect(existsSync(page)).toBe(false);
  });
});

describe('saving the results', () => {
  const scratchWork = (): string => mkdtempSync(path.join(tmpdir(), 'docs-claims-save-'));

  it('names the file it could not write and leaves no truncated set behind', () => {
    const work = scratchWork();
    try {
      // A directory where results.json belongs makes the second write fail, as a full disk does.
      mkdirSync(path.join(work, 'results.json'));
      expect(() => save([], [], work)).toThrow(/could not write results\.json/u);
      expect(existsSync(path.join(work, 'summary.md'))).toBe(false);
      expect(existsSync(path.join(work, 'results.json'))).toBe(false);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('writes both files', () => {
    const work = scratchWork();
    try {
      const markdown = save([], [], work);
      expect(readFileSync(path.join(work, 'summary.md'), 'utf8')).toBe(markdown);
      expect(readFileSync(path.join(work, 'results.json'), 'utf8')).toBe('[]\n');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
