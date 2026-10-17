/**
 * Use case 1, the manual search agent: the definition passes the contract, the index server
 * answers like a search tool should, and the portal's backend turns a run into a cited answer it
 * has checked. See `../README.md` for the three tiers and what each proves.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startMcpServer, type McpSession } from '../harness/mcp-client.ts';
import { loadGalleryProject, type GalleryProject } from '../harness/project.ts';
import { scriptedWorkspace, type ScriptContext } from '../harness/scripted-workspace.ts';
import { askManual } from './backend/ask.ts';
import agentDefinition from './agents/manual-search.ts';
import surfaceDefinition from './surfaces/manual-desk.ts';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const CONNECTOR_ID = '6b1c1f0e-0000-4000-8000-000000000001';

interface Hit {
  readonly id: string;
  readonly source: string;
  readonly page: number;
  readonly section: string;
}
interface Section {
  readonly text: string;
  readonly citation: string;
}

let index: McpSession;
let project: GalleryProject;

beforeAll(async () => {
  index = await startMcpServer(path.join(DIR, 'mcp', 'manual-index.mjs'));
  project = await loadGalleryProject(DIR, {
    'agents/manual-search.ts': agentDefinition,
    'surfaces/manual-desk.ts': surfaceDefinition,
  });
});
afterAll(() => {
  index.close();
});

/**
 * What a model following `agents/manual-search.md` does: search, read the best section, answer in
 * the skill's format, or say it found nothing. The decisions are scripted; every tool result is
 * the real server's.
 */
async function followInstructions(context: ScriptContext): Promise<string> {
  const found = await context.tool('manual-index', 'search_manual', {
    query: context.prompt,
    limit: 3,
  });
  const hits = JSON.parse(found.text) as Hit[];
  const best = hits[0];
  if (best === undefined) {
    return '該当する記載が見つかりませんでした。設備保全課（内線 4410）にお問い合わせください。';
  }
  const read = await context.tool('manual-index', 'read_section', { id: best.id });
  const section = JSON.parse(read.text) as Section;
  return `${section.text.split('。')[0] ?? ''}。\n\n- 根拠: ${section.citation}`;
}

describe('manual search agent', () => {
  it('the project passes the contract aw check applies', () => {
    const [agent] = project.agents;
    expect(project.agents).toHaveLength(1);
    const definition = agent?.body.definition;
    expect(definition?.agent.permissions).toStrictEqual({
      readFiles: true,
      writeFiles: false,
      runCommands: false,
      unrestrictedNetwork: false,
    });
    expect(definition?.resources).toMatchObject({
      connectors: ['manual-index'],
      skills: ['cite-answer'],
      files: [{ path: 'manuals', access: 'read' }],
    });
    expect(agent?.body.surfaces?.map((surface) => surface.name)).toStrictEqual(['manual-desk']);
    expect(definition?.agent.instructions).toContain('search_manual');
    expect(project.skills.map((skill) => skill.name)).toStrictEqual(['cite-answer']);
    expect(project.project.policy?.permissions?.writeFiles).toBe(false);
  });

  it('the eval file and the promotion bar are valid', () => {
    const cases = project.agents[0]?.evals?.cases ?? [];
    expect(cases.map((entry) => entry.name)).toHaveLength(4);
    expect(cases.some((entry) => entry.expect.notContains?.includes('〔'))).toBe(true);
    expect(cases.every((entry) => entry.expect.tool === undefined)).toBe(true);
    expect(project.project.policy?.promotion?.minEvalScore).toBe(0.9);
  });

  it('the index finds the clause, reads it whole, and finds nothing for an unrelated question', async () => {
    expect(await index.tools()).toStrictEqual(['search_manual', 'read_section']);

    const hits = await index.callJson<Hit[]>('search_manual', {
      query: '油圧ユニットの定期点検の周期は？',
    });
    expect(hits[0]).toMatchObject({
      source: '油圧ユニット保守マニュアル',
      page: 12,
      section: '3.2',
    });

    // A rephrased query (full-width digits, different word order) lands on the same clause.
    const rephrased = await index.callJson<Hit[]>('search_manual', {
      query: '作動油　交換　４０００時間',
    });
    expect(rephrased[0]).toMatchObject({ page: 14, section: '3.4' });

    const section = await index.callJson<Section>('read_section', { id: hits[0]?.id });
    expect(section.citation).toBe('〔油圧ユニット保守マニュアル p.12 §3.2〕');
    expect(section.text).toContain('6か月');

    expect(
      await index.callJson<Hit[]>('search_manual', { query: '社員食堂の営業時間' }),
    ).toStrictEqual([]);
    expect((await index.call('read_section', { id: 'missing#9.9' })).isError).toBe(true);
  });

  it('the backend returns a cited answer and checks every citation against what the agent read', async () => {
    const workspace = scriptedWorkspace(followInstructions, {
      'manual-index': { id: CONNECTOR_ID, session: index },
    });
    const result = await askManual(
      workspace.aw,
      workspace.agentId,
      '油圧ユニットの定期点検の周期は？',
    );

    expect(result.answer).toContain('6か月');
    expect(result.citations.map((citation) => citation.raw)).toStrictEqual([
      '油圧ユニット保守マニュアル p.12 §3.2',
    ]);
    expect(result.citations[0]).toMatchObject({
      source: '油圧ユニット保守マニュアル',
      page: 12,
      section: '3.2',
    });
    expect(result.grounded).toBe(true);
    expect(result.queries).toStrictEqual(['油圧ユニットの定期点検の周期は？']);
    expect(workspace.calls[0]?.json).toMatchObject({
      prompt: '油圧ユニットの定期点検の周期は？',
      sessionId: null,
    });
  });

  it('the backend refuses to call an answer grounded when it cites a page the agent never opened', async () => {
    const workspace = scriptedWorkspace(
      async (context) => {
        await context.tool('manual-index', 'search_manual', { query: context.prompt });
        return '周期は 3か月 です。〔油圧ユニット保守マニュアル p.99 §9.9〕';
      },
      { 'manual-index': { id: CONNECTOR_ID, session: index } },
    );
    const result = await askManual(
      workspace.aw,
      workspace.agentId,
      '油圧ユニットの定期点検の周期は？',
    );
    expect(result.grounded).toBe(false);
    expect(result.unverified.map((citation) => citation.page)).toStrictEqual([99]);
  });

  it('the backend reports an honest no-answer and keeps the session for a follow-up', async () => {
    const workspace = scriptedWorkspace(followInstructions, {
      'manual-index': { id: CONNECTOR_ID, session: index },
    });
    const first = await askManual(workspace.aw, workspace.agentId, '社員食堂の営業時間は？');
    expect(first.answer).toContain('該当する記載が見つかりませんでした');
    expect(first.grounded).toBe(false);

    const followUp = await askManual(
      workspace.aw,
      workspace.agentId,
      '作動油の交換基準は？',
      first.sessionId,
    );
    expect(followUp.sessionId).toBe(first.sessionId);
    expect(followUp.answer).toContain('4,000時間');
  });
});
