import { describe, expect, it } from 'vitest';

import {
  MODEL_OPTIONS,
  ROOT,
  sampleWith,
  compile,
  versionOf,
  verdictAt,
  sample,
  planOf,
} from '../../testing/foundry-compile.fixture.test-support.js';

const report = compile(sample).report;
const sampleVerdictAt = (path: string) => report.find((entry) => entry.path === path);

describe('Foundry knowledge and subagents', () => {
  it('drops skills, url and connector knowledge, and files without a vector store', () => {
    expect(sampleVerdictAt(`${ROOT}.skills.0`)).toMatchObject({
      verdict: 'dropped',
      code: 'skills_unsupported',
    });
    expect(sampleVerdictAt(`${ROOT}.knowledge.0`)).toMatchObject({
      verdict: 'dropped',
      code: 'knowledge_unsupported',
    });
    expect(sampleVerdictAt(`${ROOT}.knowledge.1`)).toMatchObject({
      verdict: 'dropped',
      code: 'knowledge_unsupported',
    });
    const connector = compile(sampleWith({ knowledge: [{ kind: 'connector', name: 'drive' }] }));
    expect(verdictAt(connector, `${ROOT}.knowledge.0`).code).toBe('knowledge_unsupported');
  });

  it('maps files knowledge to one file_search tool over the single vector store', () => {
    const result = compile(
      sampleWith({
        knowledge: [
          { kind: 'files', paths: ['knowledge/faq.md'] },
          { kind: 'files', paths: ['knowledge/more.md'] },
        ],
      }),
      { ...MODEL_OPTIONS, vectorStores: { [ROOT]: 'vs_1' } },
    );
    const searches = (versionOf(result).definition.tools ?? []).filter(
      (tool) => tool.type === 'file_search',
    );
    expect(searches).toEqual([{ type: 'file_search', vector_store_ids: ['vs_1'] }]);
    expect(verdictAt(result, `${ROOT}.knowledge.0`).verdict).toBe('mapped');
    expect(verdictAt(result, `${ROOT}.knowledge.1`).verdict).toBe('mapped');
  });

  it('maps a subagent to an a2a tool, a plan connection and an endpoint file', () => {
    const result = compile(sample);
    expect(sampleVerdictAt(`${ROOT}.subagents.0`)?.verdict).toBe('mapped');
    expect(versionOf(result).definition.tools?.at(-1)).toEqual({
      type: 'a2a',
      a2a_version: '1.0',
      project_connection_id: 'aw-agent-billing-specialist',
    });
    const plan = planOf(result);
    expect(plan.connections).toContainEqual({
      name: 'aw-agent-billing-specialist',
      kind: 'a2a',
      targetPath: '/agents/billing-specialist/endpoint/protocols/a2a',
      auth: { type: 'agentic-identity', audience: 'https://ai.azure.com' },
    });
    expect(plan.agents.map((entry) => entry.name)).toEqual(['billing-specialist', ROOT]);
    expect(plan.agents[0]?.endpoint).toBe('agents/billing-specialist.endpoint.json');
    expect(plan.agents[1]).not.toHaveProperty('endpoint');
  });

  it('drops limits, engine and engine extensions, and reads only its own platform block', () => {
    const result = compile(
      sampleWith({
        engine: 'claude-agent-sdk',
        extensions: {
          engines: { 'claude-agent-sdk': { effort: 'high' } },
          platforms: { 'microsoft-foundry': { modelDeployment: 'x' }, 'copilot-studio': {} },
        },
      }),
    );
    expect(verdictAt(result, `${ROOT}.limits.maxTurns`)).toMatchObject({
      code: 'limits_unsupported',
    });
    expect(verdictAt(result, `${ROOT}.limits.maxBudgetUsd`)).toMatchObject({
      code: 'limits_unsupported',
    });
    expect(verdictAt(result, `${ROOT}.engine`)).toMatchObject({ code: 'field_unsupported' });
    expect(verdictAt(result, `${ROOT}.extensions.engines.claude-agent-sdk`).code).toBe(
      'field_unsupported',
    );
    expect(verdictAt(result, `${ROOT}.extensions.platforms.microsoft-foundry`).verdict).toBe(
      'mapped',
    );
    expect(verdictAt(result, `${ROOT}.extensions.platforms.copilot-studio`).code).toBe(
      'field_unsupported',
    );
  });

  it('reports the tool endpoint as mapped, used or not', () => {
    expect(sampleVerdictAt('toolEndpoint')?.verdict).toBe('mapped');
    const unused = compile(sampleWith({ tools: [] }));
    expect(verdictAt(unused, 'toolEndpoint').note).toBe('no code tool uses it');
  });
});
