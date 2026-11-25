/**
 * The guards a `use-cases/<slug>` recorder relies on to stay honest (`./recordings/use-case-script.ts`):
 * a scripted model fixed to one request refuses a prompt that lacks its identifiers or narrows the
 * request, and a report is never written from a search that missed a file it is written from.
 */
import { describe, expect, it } from 'vitest';

import type { McpToolResult } from '../gallery/harness/mcp-client.ts';
import type { ScriptContext } from '../gallery/harness/scripted-workspace.ts';
import type { Ask } from './recordings/types.ts';
import { carries, reporting, unnarrowed } from './recordings/use-case-script.ts';

const ask = (prompt: string): Ask => ({
  slug: 'deal-risk',
  agent: 'deal-risk',
  lang: 'ja',
  prompt,
  ja: prompt,
  records: null,
  outputSchema: null,
});

/** A context whose search finds `found` and whose every other call answers `ok`, logging the calls. */
function context(
  prompt: string,
  found: readonly string[],
): { ctx: ScriptContext; calls: string[] } {
  const calls: string[] = [];
  const ok: McpToolResult = { text: 'ok', isError: false };
  const ctx = {
    prompt,
    builtin: (tool: string) => {
      calls.push(tool);
      return Promise.resolve({
        text: JSON.stringify(found.map((path) => ({ path }))),
        isError: false,
      });
    },
    native: (name: string, input: Record<string, unknown>) => {
      calls.push(`${name} ${String(input['file_path'])}`);
      return Promise.resolve(ok);
    },
  } as unknown as ScriptContext;
  return { ctx, calls };
}

const plan = {
  queries: ['opportunity_id'],
  needs: ['deal-risk/opportunities.csv', 'deal-risk/activities.csv'],
  file: 'deal-risk-reports/2026-11-24.md',
  report: '# report\n',
  answer: 'saved',
};

describe('a use-cases recorder', () => {
  it('plays only the request it is scripted for', () => {
    expect(() => carries(ask('2026-11-24 時点の失注リスクレポート'), '2026-11-24')).not.toThrow();
    expect(() => carries(ask('2026-11-25 時点'), '2026-11-24')).toThrow(
      'deal-risk ja: the scripted model does not handle this prompt (it lacks 2026-11-24)',
    );
    expect(() => unnarrowed(ask('2026-11-24 時点の失注リスクレポート'), '樋渡')).not.toThrow();
    expect(() => unnarrowed(ask('樋渡さんの担当案件に絞って'), '樋渡', 'Hiwatari')).toThrow(
      'deal-risk ja: the scripted model does not handle a narrowed prompt (it names 樋渡)',
    );
  });

  it('reads what the search found and writes the report once it has every file it needs', async () => {
    const { ctx, calls } = context('make it', plan.needs);
    await expect(reporting(plan)(ctx)).resolves.toBe('saved');
    expect(calls).toEqual([
      'search_files',
      'Read /workspace/deal-risk/opportunities.csv',
      'Read /workspace/deal-risk/activities.csv',
      'Write /workspace/deal-risk-reports/2026-11-24.md',
    ]);
  });

  it('writes no report from a search that missed a file it needs', async () => {
    const { ctx, calls } = context('make it', ['deal-risk/opportunities.csv']);
    await expect(reporting(plan)(ctx)).rejects.toThrow(
      'search_files did not find deal-risk/activities.csv',
    );
    expect(calls).toEqual(['search_files']);
  });

  it('makes the approved Write again and answers on the continuation', async () => {
    const { ctx, calls } = context('approved', []);
    await expect(reporting(plan)(ctx)).resolves.toBe('saved');
    expect(calls).toEqual(['Write /workspace/deal-risk-reports/2026-11-24.md']);
  });
});
