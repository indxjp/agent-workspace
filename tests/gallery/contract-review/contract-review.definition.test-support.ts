import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createFileSearch } from '../harness/file-search.ts';
import { readDocx } from '@agent-workspace/skills-office/office-reader/scripts/ooxml.mjs';
import { contractPath, DRAFTS } from './data/drafts.ts';
import { DIR, DATA, CONTRACTS, project, docxOf } from './contract-review.fixture.test-support.ts';
export function defineDefinitionCases(): void {
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
    // The skill scripts run unattended; the redline's Write waits for legal (ADR-0145).
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
      skills: ['office-reader', 'contract-playbook'],
      files: [
        { path: 'contracts', access: 'read' },
        { path: 'playbook', access: 'read' },
        { path: 'drafts', access: 'read-write' },
      ],
    });
    expect(agent?.body.surfaces?.map((surface) => surface.name)).toStrictEqual(['legal-desk']);
    expect(agent?.body.surfaces).toMatchObject([{ parts: { attachments: true } }]);
    expect(project.surfaces[0]?.layout).toBe('page');
    expect(definition?.agent.instructions).toContain('clauses.mjs check');
    expect(project.skills.map((skill) => skill.name).sort()).toStrictEqual([
      'contract-playbook',
      'office-reader',
    ]);
    // The agent reads the Word file with office-reader; the playbook skill never opens one.
    expect(definition?.agent.instructions).toContain('ooxml.mjs docx');
    expect(definition?.agent.instructions).toContain('ooxml.mjs write');
    expect(definition?.agent.instructions).toContain('clauses.mjs split');
    expect(definition?.agent.instructions).toContain('リスク表の作成では `playbook/` を読まない');
    expect(definition?.agent.instructions).toContain('`search_files`');
    expect(definition?.agent.instructions).toContain('締結の可否は法務担当者が判断してください。');
    expect(definition?.agent.instructions).toContain('clauses.mjs redline');
    expect(project.project.policy?.permissions).toMatchObject({
      writeFiles: true,
      runCommands: true,
      unrestrictedNetwork: false,
    });
  });

  it('the agent finds the playbook rule with search_files and ships no index server', async () => {
    const data = path.join(DIR, 'data');
    // No connector, and no hosted server of ours: the detector is a skill script, not retrieval.
    expect(project.agents[0]?.body.definition?.resources).toMatchObject({ connectors: [] });
    expect(existsSync(path.join(DIR, 'mcp'))).toBe(false);

    const search = createFileSearch({ root: data, grants: ['playbook'] });
    const hitsOf = async (query: string): Promise<string[]> => {
      const result = await search.call({ query });
      expect(result.isError).toBe(false);
      return (JSON.parse(result.text) as { path: string }[]).map((hit) => hit.path);
    };
    // Only the nine rules are searchable; the drafts under `contracts/` are not granted.
    expect(search.searchablePaths()).toHaveLength(9);
    expect(search.searchablePaths().every((file) => file.startsWith('playbook/PB-'))).toBe(true);
    expect(await hitsOf('損害賠償 上限')).toStrictEqual(['playbook/PB-01-liability-cap.md']);
    expect(await hitsOf('量子コンピュータ')).toStrictEqual([]);
    expect((await search.call({ query: '？' })).isError).toBe(true);

    // A grant never leaks a file outside it.
    const one = createFileSearch({ root: data, grants: ['playbook/PB-01-liability-cap.md'] });
    expect(one.searchablePaths()).toStrictEqual(['playbook/PB-01-liability-cap.md']);
    const other = createFileSearch({ root: data, grants: ['contracts'] });
    const leaked = (
      JSON.parse((await other.call({ query: '損害賠償 上限' })).text) as { path: string }[]
    )
      .map((hit) => hit.path)
      .filter((file) => !file.startsWith('contracts/'));
    expect(leaked).toStrictEqual([]);
  });

  it('the eval file and the promotion bar are valid, with a judge rubric for every must-flag', () => {
    const cases = project.agents[0]?.evals?.cases ?? [];
    expect(cases).toHaveLength(6);
    expect(cases.every((entry) => entry.expect.tool === undefined)).toBe(true);
    const judged = cases
      .filter((entry) => entry.expect.judge !== undefined)
      .flatMap((entry) => entry.expect.contains ?? []);
    for (const rule of ['PB-01', 'PB-02', 'PB-03', 'PB-04', 'PB-05', 'PB-06']) {
      expect(judged, `no judged case pins ${rule}`).toContain(`〔${rule}〕`);
    }
    expect(cases.some((entry) => entry.expect.notContains?.includes('〔PB-06〕'))).toBe(true);
    expect(project.project.policy?.promotion?.minEvalScore).toBe(0.9);
  });

  it('ships each draft as a Word file that reads back as drafts.ts (GALLERY_WRITE=1 regenerates them)', () => {
    expect(
      readdirSync(CONTRACTS, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) =>
          path.relative(DATA, path.join(entry.parentPath, entry.name)).replaceAll(path.sep, '/'),
        )
        .toSorted(),
    ).toEqual(DRAFTS.map(contractPath).toSorted());
    for (const draft of DRAFTS) {
      const shipped = readDocx(readFileSync(path.join(DATA, contractPath(draft))));
      expect(shipped.paragraphs, draft.file).toEqual(readDocx(docxOf(draft)).paragraphs);
    }
  });
}
