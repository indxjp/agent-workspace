import { describe, expect, it } from 'vitest';

import {
  FEATURE_DEPENDENCIES,
  FEATURE_IDS,
  FEATURE_PROBLEM_CODES,
  FeatureIdSchema,
  FeatureListSchema,
  UpdateWorkspaceFeaturesRequestSchema,
  WorkspaceFeaturesSchema,
  dependentsOf,
  featuresMissingDependencies,
  type FeatureId,
} from './features.js';

function messages(result: {
  success: boolean;
  error?: { issues: readonly { message: string }[] };
}): string {
  return (result.error?.issues ?? []).map((issue) => issue.message).join('; ');
}

describe('FeatureIdSchema', () => {
  it('accepts every feature id and refuses an unknown one', () => {
    for (const id of FEATURE_IDS) expect(FeatureIdSchema.parse(id)).toBe(id);
    expect(FeatureIdSchema.safeParse('core').success).toBe(false);
    expect(FeatureIdSchema.safeParse('nope').success).toBe(false);
  });
});

describe('FEATURE_DEPENDENCIES', () => {
  it('holds the ADR-0160 D3 edges and nothing else', () => {
    expect(FEATURE_DEPENDENCIES).toEqual({
      surfaces: ['chat'],
      triggers: ['runs'],
      evaluations: ['runs'],
    });
  });

  it('names only feature ids and gives builder no edge', () => {
    const known = new Set<string>(FEATURE_IDS);
    for (const [feature, needs] of Object.entries(FEATURE_DEPENDENCIES)) {
      expect(known.has(feature)).toBe(true);
      for (const need of needs) expect(known.has(need)).toBe(true);
    }
    expect('builder' in FEATURE_DEPENDENCIES).toBe(false);
  });

  it('is acyclic', () => {
    const edges: Readonly<Record<string, readonly string[]>> = FEATURE_DEPENDENCIES;
    const state = new Map<string, 'visiting' | 'done'>();
    const visit = (id: string): void => {
      expect(state.get(id), `cycle through ${id}`).not.toBe('visiting');
      if (state.get(id) === 'done') return;
      state.set(id, 'visiting');
      for (const need of edges[id] ?? []) visit(need);
      state.set(id, 'done');
    };
    for (const id of FEATURE_IDS) visit(id);
  });
});

describe('featuresMissingDependencies and dependentsOf', () => {
  it('names each feature whose dependency is not listed', () => {
    expect(featuresMissingDependencies(['surfaces'])).toEqual([
      { feature: 'surfaces', needs: 'chat' },
    ]);
    expect(featuresMissingDependencies(['chat', 'surfaces'])).toEqual([]);
    expect(featuresMissingDependencies(FEATURE_IDS)).toEqual([]);
  });

  it('lists dependents in sorted order, and only the enabled ones', () => {
    expect(dependentsOf('runs', FEATURE_IDS)).toEqual(['evaluations', 'triggers']);
    expect(dependentsOf('runs', ['runs', 'triggers'])).toEqual(['triggers']);
    expect(dependentsOf('chat', ['chat'])).toEqual([]);
    expect(dependentsOf('builder', FEATURE_IDS)).toEqual([]);
  });
});

describe('FeatureListSchema', () => {
  it('round-trips a dependency-closed list', () => {
    const list = ['chat', 'files', 'surfaces'];
    expect(FeatureListSchema.parse(list)).toEqual(list);
    expect(FeatureListSchema.parse(FEATURE_IDS)).toEqual(FEATURE_IDS);
  });

  it('accepts builder alone', () => {
    expect(FeatureListSchema.parse(['builder'])).toEqual(['builder']);
  });

  it('refuses an empty list, an unknown id and a duplicate', () => {
    expect(FeatureListSchema.safeParse([]).success).toBe(false);
    expect(FeatureListSchema.safeParse(['chat', 'nope']).success).toBe(false);
    expect(FeatureListSchema.safeParse(['chat', 'chat']).success).toBe(false);
  });

  it('refuses a feature without its dependency, naming it', () => {
    const result = FeatureListSchema.safeParse(['surfaces']);
    expect(result.success).toBe(false);
    expect(messages(result)).toContain('surfaces needs chat');
  });
});

describe('WorkspaceFeaturesSchema', () => {
  it('round-trips one row per feature id, in order', () => {
    const body = {
      features: FEATURE_IDS.map((id, index) => ({ id, installed: true, enabled: index % 2 === 0 })),
    };
    const parsed = WorkspaceFeaturesSchema.parse(body);
    expect(parsed).toEqual(body);
    expect(parsed.features.map((row) => row.id)).toEqual([...FEATURE_IDS]);
    expect(parsed.features).toHaveLength(FEATURE_IDS.length);
    expect(parsed.features.at(-1)?.id).toBe('builder');
  });

  it('refuses an unknown key and an unknown id', () => {
    expect(
      WorkspaceFeaturesSchema.safeParse({
        features: [{ id: 'chat', installed: true, enabled: true, x: 1 }],
      }).success,
    ).toBe(false);
    expect(
      WorkspaceFeaturesSchema.safeParse({
        features: [{ id: 'nope', installed: true, enabled: true }],
      }).success,
    ).toBe(false);
  });

  it('refuses rows out of FEATURE_IDS order, a missing row and a repeated row', () => {
    const rows = FEATURE_IDS.map((id) => ({ id, installed: true, enabled: true }));
    const reversed = [...rows].reverse();
    const missing = rows.slice(0, -1);
    const repeated = [...missing, ...rows.slice(0, 1)];
    for (const features of [reversed, missing, repeated]) {
      const result = WorkspaceFeaturesSchema.safeParse({ features });
      expect(result.success).toBe(false);
      expect(messages(result)).toContain('one row per feature, in FEATURE_IDS order');
    }
  });
});

describe('UpdateWorkspaceFeaturesRequestSchema', () => {
  it('round-trips the full off set, including an empty one', () => {
    const disabled: FeatureId[] = ['files', 'skills'];
    expect(UpdateWorkspaceFeaturesRequestSchema.parse({ disabled })).toEqual({ disabled });
    expect(UpdateWorkspaceFeaturesRequestSchema.parse({ disabled: [] })).toEqual({ disabled: [] });
  });

  it('refuses a duplicate, an unknown id and an unknown key', () => {
    expect(
      UpdateWorkspaceFeaturesRequestSchema.safeParse({ disabled: ['files', 'files'] }).success,
    ).toBe(false);
    expect(UpdateWorkspaceFeaturesRequestSchema.safeParse({ disabled: ['nope'] }).success).toBe(
      false,
    );
    expect(
      UpdateWorkspaceFeaturesRequestSchema.safeParse({ disabled: [], extra: true }).success,
    ).toBe(false);
  });
});

describe('FEATURE_PROBLEM_CODES', () => {
  it('maps the three ADR-0160 D7 codes to their statuses', () => {
    expect(FEATURE_PROBLEM_CODES).toEqual({
      feature_disabled: 404,
      feature_in_use: 409,
      feature_not_installed: 409,
    });
  });
});
