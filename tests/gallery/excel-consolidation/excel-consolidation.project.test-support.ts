import {
  readXlsx,
  writeXlsx,
} from '@agent-workspace/skills-office/office-reader/scripts/ooxml.mjs';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import {
  fileScopeFor,
  NoAccessibleFiles,
  proposePlan,
  type MappingPlan,
} from './backend/consolidate.ts';
import { BRANCH_FILES, writeBranchWorkbooks } from './data/branch-workbooks.ts';
import {
  ACCESS,
  BRANCH_FOLDERS,
  DATA,
  DIR,
  FIRST_QUERIES,
  type Hit,
  pathsOf,
  PLAN,
  PLANNER,
  planWrite,
  project,
  REQUEST,
  SAPPORO_MANAGER,
  search,
  workspaceFor,
} from './excel-consolidation.fixture.test-support.ts';

export function describeExcelProject(): void {
  it('ships each workbook where the harness serves it, reading back as branch-workbooks.ts (GALLERY_WRITE=1 regenerates them)', () => {
    if (process.env['GALLERY_WRITE'] === '1') {
      for (const folder of new Set(BRANCH_FILES.map((file) => file.path.split('/')[0] ?? ''))) {
        rmSync(path.join(DATA, folder), { recursive: true, force: true });
      }
      writeBranchWorkbooks(DATA);
    }
    const shippedWorkbooks = readdirSync(DATA, { recursive: true, encoding: 'utf8' })
      .filter((name) => name.endsWith('.xlsx'))
      .map((name) => name.split(path.sep).join('/').normalize('NFC'));
    expect(shippedWorkbooks.toSorted()).toEqual(
      BRANCH_FILES.map((file) => file.path.normalize('NFC')).toSorted(),
    );
    for (const file of BRANCH_FILES) {
      expect(readXlsx(readFileSync(path.join(DATA, file.path))), file.path).toEqual(
        readXlsx(writeXlsx({ sheets: file.sheets })),
      );
    }
    expect(existsSync(path.join(DATA, '東京支店', '売上報告の書き方.txt'))).toBe(true);
  });

  it('the project passes the contract aw check applies', () => {
    const [agent] = project.agents;
    expect(project.agents).toHaveLength(1);
    const definition = agent?.body.definition;
    expect(definition?.agent.permissions).toStrictEqual({
      readFiles: true,
      writeFiles: true,
      runCommands: true,
      unrestrictedNetwork: false,
    });
    // Bash runs unattended; the plan's Write waits for a person (ADR-0145).
    expect(definition?.policy).toMatchObject({
      tools: {
        permissionMode: 'default',
        autoApprove: [
          'mcp__agent-workspace__run_skill_script',
          'mcp__agent-workspace__search_files',
        ],
      },
      requireApproval: ['Write'],
    });
    expect(definition?.resources).toMatchObject({
      connectors: [],
      skills: ['office-reader', 'excel-consolidate'],
      files: BRANCH_FOLDERS.map((folder) => ({ path: folder, access: 'read' })),
    });
    expect(definition?.agent.instructions).toContain('search_files');
    expect(definition?.agent.instructions).not.toContain('find_files');
    // No shell: the scripts run through run_skill_script, and the word Bash is gone.
    expect(definition?.agent.instructions).toContain('run_skill_script');
    expect(definition?.agent.instructions).not.toMatch(/Bash/iu);
    // The plan is a few tool calls, not one pair per file, and names each branch's unit.
    expect(definition?.agent.instructions).toContain('ファイルごとに呼び出さず');
    expect(definition?.agent.instructions).toContain('拠点ごとの単位');
    expect(definition?.agent.instructions).toContain('`Write` で `outputs/plan.json`');
    // The agent never opens SKILL.md, so the plan's keys must be in its own instructions.
    expect(definition?.agent.instructions).toContain('"layouts"');
    expect(definition?.agent.instructions).toContain('"excluded"');
    expect(project.skills.map((skill) => skill.name).sort()).toStrictEqual([
      'excel-consolidate',
      'office-reader',
    ]);
    // Each skill is uploaded as its own directory: consolidate.mjs imports only its sibling reader.
    const consolidateSkill = project.skills.find((skill) => skill.name === 'excel-consolidate');
    const script = consolidateSkill?.files.find((file) => file.path === 'scripts/consolidate.mjs');
    const source = Buffer.from(script?.contentBase64 ?? '', 'base64').toString('utf8');
    expect(source).not.toMatch(/from '\.\.\//u);
    expect(source).toContain("from './xlsx.mjs'");
    expect(consolidateSkill?.files.map((file) => file.path)).toContain('scripts/xlsx.mjs');
    const surface = agent?.body.surfaces?.[0];
    expect(surface).toMatchObject({ name: 'planning' });
    expect(project.project.policy?.permissions).toMatchObject({
      runCommands: true,
      writeFiles: true,
    });
  });

  it('the eval file and the promotion bar are valid', () => {
    const cases = project.agents[0]?.evals?.cases ?? [];
    expect(cases).toHaveLength(3);
    // The first case pins the gate: the run's first move is the plan's Write, not a consolidation.
    expect(cases[0]?.expect).toMatchObject({
      awaitsApproval: true,
      tool: 'Write',
      toolInput: { file_path: 'outputs/plan.json' },
    });
    expect(cases[0]?.expect.notContains).toContain('"comparison"');
    // Every case is scored at the approval pause; without the flag each would fail run_awaiting_approval.
    expect(cases.every((c) => c.expect.awaitsApproval === true)).toBe(true);
    expect(project.project.policy?.promotion?.minEvalScore).toBe(0.9);
  });

  it('the agent finds the workbooks with search_files and ships no index server', async () => {
    // No connector, and no hosted server of ours.
    expect(project.agents[0]?.body.definition?.resources).toMatchObject({ connectors: [] });
    expect(existsSync(path.join(DIR, 'mcp'))).toBe(false);

    // The two searches the instructions start with reach both months of every branch, by the text
    // inside the workbooks, and the shared template; the expense workbook and the note stay out.
    const found = new Set<string>();
    for (const query of FIRST_QUERIES) {
      const result = await search.call({ query });
      expect(result.isError, query).toBe(false);
      for (const hit of pathsOf(result)) found.add(hit);
    }
    expect([...found].toSorted()).toStrictEqual(
      BRANCH_FILES.map((file) => file.path)
        .filter((file) => !file.includes('経費精算'))
        .toSorted(),
    );
    // A hit carries the sheet's text, so a plan can be checked against what the search showed.
    const tokyo = (
      JSON.parse((await search.call({ query: '東京支店 売上報告' })).text) as Hit[]
    ).find((hit) => hit.path === '東京支店/東京_売上報告_2025年5月.xlsx');
    expect(tokyo).toMatchObject({ page: 1 });
    expect(tokyo?.snippet).toContain('売上報告');

    expect(await search.call({ query: '議事録' })).toStrictEqual({ text: '[]', isError: false });
    expect((await search.call({ query: '？' })).isError).toBe(true);
    // Only what the agent is granted is searchable: nothing else in `data/` is.
    expect(search.searchablePaths().toSorted()).toStrictEqual(
      readdirSync(DATA, { recursive: true, encoding: 'utf8' })
        .map((name) => name.split(path.sep).join('/'))
        .filter((name) => /\.(xlsx|txt)$/u.test(name))
        .toSorted(),
    );
  });

  it('each person gets a fileScope of the branch folders they may see, and a person with none is refused before any run', async () => {
    expect(fileScopeFor(PLANNER, ACCESS)).toStrictEqual(BRANCH_FOLDERS);
    expect(fileScopeFor(SAPPORO_MANAGER, ACCESS)).toStrictEqual(['共通', '札幌営業所']);

    // What the Sapporo manager's model sees: the two searches, then a name from another branch.
    const seen: string[] = [];
    let tokyoText = '';
    const sapporoPlan: MappingPlan = {
      ...PLAN,
      layouts: PLAN.layouts.filter((layout) => layout.branch === '札幌'),
    };
    const sapporo = workspaceFor(async (context) => {
      for (const query of [...FIRST_QUERIES, '東京支店', '売上報告']) {
        const result = await context.builtin('search_files', { query });
        seen.push(...pathsOf(result));
        if (query === '東京支店') tokyoText = result.text;
      }
      await context.native('Write', planWrite(sapporoPlan));
      throw new Error('the plan should have stopped at its Write');
    });
    // The request names Tokyo and another person; the run's subject and scope decide.
    const proposal = await proposePlan(
      sapporo.aw,
      sapporo.agentId,
      `${PLANNER}です。東京支店の売上を集計して`,
      SAPPORO_MANAGER,
      ACCESS,
    );
    expect(sapporo.runs[0]).toMatchObject({
      subject: SAPPORO_MANAGER,
      fileScope: ['共通', '札幌営業所'],
    });
    expect(proposal.fileScope).toStrictEqual(['共通', '札幌営業所']);
    expect(proposal.found).toStrictEqual([
      '共通/売上報告テンプレート.xlsx',
      '札幌営業所/札幌_月次報告_2025-04.xlsx',
      '札幌営業所/札幌_月次報告_2025-05.xlsx',
    ]);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((file) => file.startsWith('共通/') || file.startsWith('札幌営業所/'))).toBe(
      true,
    );
    // Tokyo's workbooks are not just unlisted: the search finds nothing of them.
    expect(tokyoText).toBe('[]');

    // The same searches from the planner reach every branch.
    const everyone = workspaceFor(async (context) => {
      for (const query of FIRST_QUERIES)
        seen.push(...pathsOf(await context.builtin('search_files', { query })));
      return 'done';
    });
    seen.length = 0;
    await everyone.aw.runs.start(everyone.agentId, {
      prompt: REQUEST,
      subject: PLANNER,
      fileScope: fileScopeFor(PLANNER, ACCESS),
    });
    expect(new Set(seen.map((file) => file.split('/')[0]))).toStrictEqual(new Set(BRANCH_FOLDERS));

    // A scope outside the grants is refused as launch refuses it, by the search double here.
    const outside = workspaceFor((context) =>
      context.builtin('search_files', { query: '売上' }).then((result) => result.text),
    );
    await expect(
      outside.aw.runs.start(outside.agentId, {
        prompt: REQUEST,
        subject: PLANNER,
        fileScope: ['人事部'],
      }),
    ).rejects.toThrow(/run_file_scope_not_granted/u);

    // Nothing accessible, nothing started: not an unscoped run.
    const refused = workspaceFor(() => Promise.resolve('unreachable'));
    for (const access of [ACCESS, { ...ACCESS, 新人: { folders: [] } }]) {
      await expect(
        proposePlan(refused.aw, refused.agentId, REQUEST, '新人', access),
      ).rejects.toBeInstanceOf(NoAccessibleFiles);
    }
    expect(refused.runs).toHaveLength(0);
    expect(refused.calls).toHaveLength(0);
  });
}
