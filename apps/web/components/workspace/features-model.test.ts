import {
  FEATURE_IDS,
  dependentsOf,
  type FeatureId,
  type WorkspaceFeatures,
} from '@indx-workspace/contracts/features';
import { describe, expect, it } from 'vitest';

import { disabledAfter, navEntriesHiddenBy, navLabelsHiddenBy, rowsFor } from './features-model';

function state(
  options: { off?: readonly FeatureId[]; notInstalled?: readonly FeatureId[] } = {},
): WorkspaceFeatures {
  const { off = [], notInstalled = [] } = options;
  return {
    features: FEATURE_IDS.map((id) => {
      const installed = !notInstalled.includes(id);
      return { id, installed, enabled: installed && !off.includes(id) };
    }),
  };
}

function row(rows: ReturnType<typeof rowsFor>, id: FeatureId) {
  const found = rows.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`no row for ${id}`);
  return found;
}

describe('rowsFor', () => {
  it('gives one row per feature, in FEATURE_IDS order', () => {
    expect(rowsFor(state()).map((candidate) => candidate.id)).toEqual([...FEATURE_IDS]);
  });

  it('refuses to switch runs off while evaluations and triggers are on', () => {
    const runs = row(rowsFor(state()), 'runs');
    expect(runs.neededBy).toEqual(['evaluations', 'triggers']);
    expect(runs.canToggle).toBe(false);
    expect(runs.reason).toEqual({ kind: 'needed_by', features: ['evaluations', 'triggers'] });
  });

  it('names only the dependents still on, and frees runs once both are off', () => {
    const one = row(rowsFor(state({ off: ['evaluations'] })), 'runs');
    expect(one.reason).toEqual({ kind: 'needed_by', features: ['triggers'] });
    const none = row(rowsFor(state({ off: ['evaluations', 'triggers'] })), 'runs');
    expect(none.neededBy).toEqual(['evaluations', 'triggers']);
    expect(none.canToggle).toBe(true);
    expect(none.reason).toBeNull();
  });

  it('refuses to switch chat off while surfaces is on, naming surfaces', () => {
    const chat = row(rowsFor(state()), 'chat');
    expect(chat.canToggle).toBe(false);
    expect(chat.reason).toEqual({ kind: 'needed_by', features: ['surfaces'] });
  });

  it('shows a feature the deployment does not install as off and disabled', () => {
    const builder = row(rowsFor(state({ notInstalled: ['builder'] })), 'builder');
    expect(builder).toMatchObject({ installed: false, enabled: false, canToggle: false });
    expect(builder.reason).toEqual({ kind: 'not_installed' });
  });

  it('refuses to switch a feature on while a feature it needs is off', () => {
    const rows = rowsFor(state({ off: ['chat', 'surfaces'] }));
    expect(row(rows, 'surfaces').needs).toEqual(['chat']);
    expect(row(rows, 'surfaces').reason).toEqual({ kind: 'needs', features: ['chat'] });
    expect(row(rows, 'chat').canToggle).toBe(true);
  });

  it('agrees with the contract’s dependentsOf for every feature', () => {
    const rows = rowsFor(state());
    for (const id of FEATURE_IDS) {
      expect(row(rows, id).neededBy).toEqual(dependentsOf(id, FEATURE_IDS));
    }
  });

  it('reads the dependency table it is given', () => {
    const files = row(rowsFor(state(), { skills: ['files'] }), 'files');
    expect(files.reason).toEqual({ kind: 'needed_by', features: ['skills'] });
  });
});

describe('disabledAfter', () => {
  it('adds or removes the one feature and keeps the rest of the off set', () => {
    expect(disabledAfter(state({ off: ['skills'] }), 'files', false)).toEqual(['files', 'skills']);
    expect(disabledAfter(state({ off: ['files', 'skills'] }), 'files', true)).toEqual(['skills']);
  });

  it('keeps a feature the deployment does not install in the off set', () => {
    expect(disabledAfter(state({ notInstalled: ['builder'] }), 'files', true)).toEqual(['builder']);
  });
});

describe('navEntriesHiddenBy', () => {
  it('derives the hidden entries from the navigation’s feature tags', () => {
    expect(navEntriesHiddenBy('sharing')).toEqual(['shares']);
    expect(navEntriesHiddenBy('chat')).toEqual(['home']);
    expect(navEntriesHiddenBy('files')).toEqual(['files']);
    expect(navEntriesHiddenBy('builder')).toEqual([]);
    expect(navLabelsHiddenBy('sharing')).toEqual(['Shared links']);
    expect(navLabelsHiddenBy('chat')).toEqual(['New chat']);
  });
});
