/**
 * Every archetype template is a project that works once generated (use-cases/README.md, "The
 * templates"). For each folder of `templates/`, the real generator writes a probe entry into a
 * temporary folder under `use-cases/`, removed afterwards, and the probe must
 *
 * - ship eval cases of the four kinds and the promotion bar (the contract tier's `evalProblems`);
 * - carry only triggers the server accepts: each `triggers/*.json`, and the default export of each
 *   `triggers/*.ts`, parses with `CreateTriggerRequestSchema`;
 * - pass the contract tier of `describeUseCase`: the project loads the way `aw check` loads it, it
 *   agrees with a coming-soon catalog entry of its own, it writes no Office file without approval,
 *   and every folder it is granted is named from its slug, so two entries generated from one
 *   template never share a seed collection or an output folder;
 * - name every skill it carries from its slug, so two seeded entries never carry one skill name with
 *   different content.
 *
 * The last two, and an import of every other code file of the probe (a helper, a skill script), run
 * in a child Vitest run, from a test written beside the probe: a probe's modules can
 * only be imported statically by a file that names them. So a broken template fails here even when
 * no entry still matches it byte for byte. With no template there is nothing to probe, and the test
 * says so.
 */
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { CreateTriggerRequestSchema } from '@indx-workspace/contracts/triggers';
import { parseProjectFile, readEvalCaseFile } from '@indx-workspace/sdk/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { filesOf } from '../../tests/apps/handwritten.ts';
import { ARCHETYPES } from './archetypes.ts';
import { MEASURED_CODE } from './budget.ts';
import { CONTRACT_TESTS, evalProblems } from './contract.ts';
import { generateUseCase } from './generate.ts';
import { REPOSITORY_ROOT, runVitest } from './nested-vitest.ts';

const USE_CASES_DIR = path.resolve(import.meta.dirname, '..');
const TEMPLATES_DIR = path.join(USE_CASES_DIR, 'templates');
const PROBE_TEST = 'probe.test.ts';
const TEST_FILE = /\.(?:test|spec|test-support)\.[cm]?[jt]sx?$/u;

const templates = existsSync(TEMPLATES_DIR)
  ? readdirSync(TEMPLATES_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  : [];

const slugOf = (code: string): string => `template-probe-${code}`;

/**
 * A trigger file names no agent: `aw triggers create --file <json> --agent <id>` adds the pushed
 * agent's id, so the probe adds one before it parses the request the server would get.
 */
const PROBE_AGENT_ID = '00000000-0000-4000-8000-000000000000';

async function filesIn(dir: string, folder: string, extension: string): Promise<string[]> {
  if (!existsSync(path.join(dir, folder))) return [];
  return (await readdir(path.join(dir, folder)))
    .filter((name) => name.endsWith(extension) && !name.endsWith(`.d${extension}`))
    .map((name) => `${folder}/${name}`)
    .sort();
}

/** Why the probe in `dir` falls short, read without importing it; empty when it does not. */
async function staticProblems(dir: string, slug: string): Promise<string[]> {
  const read = parseProjectFile(await readFile(path.join(dir, 'agent-workspace.yaml'), 'utf8'));
  if (read.lifted) return [`${slug}: agent-workspace.yaml is a v1 profile; write it as v2`];
  const bar = read.project.policy?.promotion?.minEvalScore;
  const problems: string[] = [];
  const evals = await filesIn(dir, 'evals', '.yaml');
  if (evals.length === 0) problems.push(`${slug}: no evals/*.yaml`);
  for (const file of evals) {
    const parsed = readEvalCaseFile(await readFile(path.join(dir, file), 'utf8'), file);
    problems.push(...evalProblems(slug, parsed, bar));
  }
  for (const file of await filesIn(dir, 'triggers', '.json')) {
    const parsed = CreateTriggerRequestSchema.safeParse({
      ...(JSON.parse(await readFile(path.join(dir, file), 'utf8')) as object),
      agentId: PROBE_AGENT_ID,
    });
    if (!parsed.success) problems.push(`${slug}: ${file} is not a trigger the server accepts`);
  }
  // A skill is named from the slug too: a verification workspace holds every seeded entry at once,
  // and two entries carrying one skill name with different content would replace each other's.
  const skills = path.join(dir, 'skills');
  if (existsSync(skills)) {
    for (const name of await readdir(skills)) {
      if (name !== slug) problems.push(`${slug}: skill ${name} is not named from the slug`);
    }
  }
  return problems;
}

/**
 * The test written beside a probe: `describeUseCase` with a coming-soon catalog entry of its own,
 * and each TypeScript trigger's default export parsed as the server parses a trigger.
 */
async function writeProbeTest(dir: string, slug: string): Promise<void> {
  const definitions = [
    ...(await filesIn(dir, 'agents', '.ts')),
    ...(await filesIn(dir, 'surfaces', '.ts')),
  ];
  const triggers = await filesIn(dir, 'triggers', '.ts');
  // Every other code file too (a helper, a skill script), so a broken import anywhere fails here.
  const named = new Set([...definitions, ...triggers]);
  const others = (await filesOf(dir)).filter(
    (file) => MEASURED_CODE.test(file) && !TEST_FILE.test(file) && !named.has(file),
  );
  const from = (target: string): string => {
    const found = path.relative(dir, target).split(path.sep).join('/');
    return found.startsWith('.') ? found : `./${found}`;
  };
  const lines = [
    "import { CreateTriggerRequestSchema } from '@indx-workspace/contracts/triggers';",
    "import { expect, it } from 'vitest';",
    `import { defineEntry } from '${from(path.join(REPOSITORY_ROOT, 'examples/store/catalog/define.ts'))}';`,
    `import { describeUseCase } from '${from(path.join(import.meta.dirname, 'describe-use-case.ts'))}';`,
    ...definitions.map((file, at) => `import d${String(at)} from './${file}';`),
    ...triggers.map((file, at) => `import t${String(at)} from './${file}';`),
    ...others.map((file) => `import './${file}';`),
    '',
    `describeUseCase('${slug}', {`,
    '  dir: import.meta.dirname,',
    `  definitions: { ${definitions.map((file, at) => `'${file}': d${String(at)}`).join(', ')} },`,
    '  catalog: [',
    '    defineEntry({',
    `      slug: '${slug}',`,
    "      area: 'knowledge',",
    "      status: 'soon',",
    '      wave: 2,',
    "      name: { ja: 'テンプレートの確認', en: 'Template probe' },",
    "      summary: { ja: 'テンプレートを確かめる。', en: 'Checks a template.' },",
    '    }),',
    '  ],',
    '  recordings: [],',
    '});',
    '',
    "it('carries only triggers the server accepts', () => {",
    `  for (const trigger of [${triggers.map((_, at) => `t${String(at)}`).join(', ')}]) {`,
    '    expect(CreateTriggerRequestSchema.safeParse(trigger).error).toBeUndefined();',
    '  }',
    '});',
    '',
  ];
  await writeFile(path.join(dir, PROBE_TEST), lines.join('\n'));
}

describe('the archetype templates', () => {
  it('are each named by an archetype code', () => {
    const codes = ARCHETYPES.map((code) => code.toLowerCase());
    expect(templates.filter((name) => !codes.includes(name))).toEqual([]);
  });

  if (templates.length === 0) {
    it('has no template yet, so there is nothing to probe', () => {
      expect(templates).toEqual([]);
    });
    return;
  }

  let probes = '';
  beforeAll(async () => {
    // A dot folder: the layout and the budget, which list use cases, pass over it. The generator
    // reads the templates through a link, as it reads them from use-cases/.
    probes = await mkdtemp(path.join(USE_CASES_DIR, '.template-probes-'));
    await symlink(TEMPLATES_DIR, path.join(probes, 'templates'), 'dir');
    for (const code of templates) {
      await generateUseCase({ useCasesDir: probes, archetype: code, slug: slugOf(code) });
    }
  });

  afterAll(async () => {
    if (probes !== '') await rm(probes, { recursive: true, force: true });
  });

  for (const code of templates) {
    it(`${code}: evals of the four kinds and the bar, JSON triggers the server accepts`, async () => {
      expect(await staticProblems(path.join(probes, slugOf(code)), slugOf(code))).toEqual([]);
    });
  }

  it('every probe passes the contract tier, in a child Vitest run', async () => {
    for (const code of templates) {
      await writeProbeTest(path.join(probes, slugOf(code)), slugOf(code));
    }
    const files = templates.map((code) => path.join(probes, slugOf(code), PROBE_TEST));
    const run = runVitest(
      [
        '--project',
        'use-cases',
        '--dir',
        path.relative(REPOSITORY_ROOT, probes),
        '--reporter=verbose',
        ...files.map((file) => path.relative(REPOSITORY_ROOT, file).split(path.sep).join('/')),
      ],
      { USE_CASES_PROBES: '1' },
    );
    expect(run.status, run.output).toBe(0);
    for (const code of templates) {
      expect(run.output, `${code}: its probe's contract tier did not run`).toContain(
        `${slugOf(code)} > contract > ${CONTRACT_TESTS.loads}`,
      );
      // Every folder the probe is granted is named from its slug, so two entries generated from
      // one template never share a seed collection or an output folder.
      expect(run.output, `${code}: its probe's folder check did not run`).toContain(
        `${slugOf(code)} > contract > ${CONTRACT_TESTS.folders}`,
      );
    }
  }, 120_000);
});
