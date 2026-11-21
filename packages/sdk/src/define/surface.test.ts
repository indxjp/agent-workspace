import { describe, expect, expectTypeOf, it } from 'vitest';

import { SurfaceDefinitionSchema, type ResultChart } from '@indx-workspace/contracts/surfaces';

import { DefinitionError, defineSurface, isDefinedAgent, isDefinedSurface } from './index.js';

const FULL = {
  name: 'main',
  agent: 'Support triage',
  title: 'Acme help',
  theme: {
    colour: '#0055ff',
    radius: 12,
    mode: 'system',
    density: 'comfortable',
    locale: 'ja',
    logo: { url: 'https://example.test/logo.svg' },
  },
  layout: 'dock',
  parts: {
    greeting: 'Hello.',
    suggestedPrompts: ['Track my order', 'Talk to a person'],
    disclaimer: 'Answers may be wrong.',
    toolTrace: 'full',
    history: true,
    feedback: true,
    attachments: true,
    agentSwitcher: { agents: ['Billing', 'Returns'] },
  },
  toolResults: { lookup_order: 'card', list_orders: 'table' },
} as const;

function pathsOf(input: object): readonly string[] {
  try {
    defineSurface({ name: 'main', agent: 'assistant', ...input });
  } catch (error) {
    if (error instanceof DefinitionError) return error.issues.map((issue) => issue.path);
    throw error;
  }
  throw new Error('expected a DefinitionError');
}

describe('defineSurface', () => {
  it.each([{ name: 'main', agent: 'assistant' }, FULL])(
    'returns what SurfaceDefinitionSchema accepts, unchanged (C3)',
    (input) => {
      const surface = defineSurface(input);

      expect(surface).toStrictEqual(input);
      expect(SurfaceDefinitionSchema.parse(surface)).toStrictEqual(surface);
      expect(Object.isFrozen(surface)).toBe(true);
    },
  );

  it('accepts the embedding demo of #622 unchanged', () => {
    const input = {
      name: 'main',
      agent: 'support',
      allowedOrigins: ['https://shop.example.com'],
      limits: { turnsPerConversation: 30 },
    };
    expect(defineSurface(input)).toStrictEqual(input);
  });

  it('accepts a result chart declared over the typed output, and types it (ADR-0168)', () => {
    const input = {
      name: 'main',
      agent: 'analyst',
      resultCharts: [
        {
          kind: 'line',
          field: 'months',
          label: 'month',
          value: 'sales',
          title: { ja: '月次売上', en: 'Monthly sales' },
          axes: { label: { ja: '月', en: 'Month' }, value: { ja: '売上', en: 'Sales' } },
        },
      ],
    } as const;
    const surface = defineSurface(input);
    expect(surface).toStrictEqual(input);
    expectTypeOf(surface.resultCharts).toEqualTypeOf<readonly ResultChart[] | undefined>();
  });

  it('brands the surface without a visible key', () => {
    const surface = defineSurface(FULL);

    expect(isDefinedSurface(surface)).toBe(true);
    expect(isDefinedAgent(surface)).toBe(false);
    expect(Object.keys(surface)).toStrictEqual(Object.keys(FULL));
    expect(JSON.stringify(surface)).toBe(JSON.stringify(FULL));
    expect(isDefinedSurface({ ...surface })).toBe(false);
  });

  it.each([
    [{ audience: 'public' }, ['(root)']],
    [{ allowedOrigins: ['https://example.test/'] }, ['allowedOrigins.0']],
    [{ limits: { messagesPerMinute: 10 } }, ['limits']],
    [{ parts: { agentSwitcher: { agents: ['a', 'a'] } } }, ['parts.agentSwitcher.agents.1']],
    [{ toolResults: { x: 'chart' } }, ['toolResults.x']],
    [{ resultCharts: [] }, ['resultCharts']],
    [
      {
        resultCharts: [
          {
            kind: 'pie',
            field: 'rows',
            label: 'name',
            value: 'count',
            title: { ja: '件数', en: 'Count' },
            axes: { label: { ja: '名前', en: 'Name' }, value: { ja: '件数', en: 'Count' } },
          },
        ],
      },
      ['resultCharts.0.kind'],
    ],
    [{ parts: { attachments: 'yes' } }, ['parts.attachments']],
    [{ name: 'Main' }, ['name']],
  ])('refuses %j', (extra, paths) => {
    expect(pathsOf(extra)).toStrictEqual(paths);
  });
});
