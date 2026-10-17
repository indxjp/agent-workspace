/**
 * The navigation gate. Spec §44 prints the main navigation as a literal block and this file is
 * that block, typed out from the specification rather than from the implementation, compared
 * against what the shell renders. If somebody adds a fourteenth entry, reorders the five working
 * areas, or renames "Shared links", this fails and names the difference.
 *
 * ADR-0015: the assertions are positive. The inert entries are enumerated and checked by id, not
 * inferred from "nothing threw"; a new entry that silently forgets its `href` shows up as an
 * extra id in the inert list rather than as a link that 404s.
 */
import { describe, expect, it } from 'vitest';

import { NAVIGATION, activeNavId, crumbsFor } from './navigation';

/** docs/spec.md §44, in order, both groups flattened. */
const SPEC_44_ORDER = [
  'New chat',
  'Projects',
  'Agents',
  'Files',
  'Skills',
  'Connectors',
  'Runs',
  'Models',
  'Users',
  'API Keys',
  'Runtimes',
  'Shared links',
  'Settings',
];

const items = NAVIGATION.flatMap((group) => group.items);

describe('the main navigation is spec §44', () => {
  it('lists §44’s entries, in §44’s order, and nothing else', () => {
    expect(items.map((item) => item.label)).toEqual(SPEC_44_ORDER);
  });

  it('has two groups: the unlabelled working areas, then Administration', () => {
    expect(NAVIGATION.map((group) => group.label)).toEqual([null, 'Administration']);
    expect(NAVIGATION[1]?.items.map((item) => item.label)).toEqual([
      'Models',
      'Users',
      'API Keys',
      'Runtimes',
      'Shared links',
      'Settings',
    ]);
  });

  it('gives every entry a distinct id', () => {
    expect(new Set(items.map((item) => item.id)).size).toBe(items.length);
  });
});

describe('which entries actually go somewhere', () => {
  it('resolves every delivered screen', () => {
    const resolving = items.filter((item) => item.href !== null);
    expect(resolving.map((item) => [item.id, item.href])).toEqual([
      ['home', '/'],
      ['projects', '/projects'],
      ['agents', '/agents'],
      ['files', '/files'],
      ['skills', '/skills'],
      ['connectors', '/connectors'],
      ['runs', '/runs'],
      ['models', '/admin/models'],
      ['users', '/admin/users'],
      ['apikeys', '/admin/api-keys'],
      ['runtimes', '/admin/runtimes'],
      ['shares', '/admin/shares'],
      ['settings', '/admin/settings'],
    ]);
  });

  it('marks the remaining entries inert, by id, so a forgotten href is visible here', () => {
    expect(items.filter((item) => item.href === null).map((item) => item.id)).toEqual([]);
  });
});

describe('activeNavId', () => {
  it('highlights the entry whose route is on screen', () => {
    expect(activeNavId('/')).toBe('home');
    expect(activeNavId('/?agent=general')).toBe('home');
    expect(activeNavId('/#top')).toBe('home');
  });

  it('highlights the Agents entry for /agents, and nothing for a route the navigation does not name', () => {
    expect(activeNavId('/agents')).toBe('agents');
    expect(activeNavId('/p/run/abc')).toBeNull();
  });

  it('highlights Runtimes and derives its Administration breadcrumb', () => {
    expect(activeNavId('/admin/runtimes')).toBe('runtimes');
    expect(crumbsFor('/admin/runtimes')).toEqual(['Administration', 'Runtimes']);
  });

  it('refuses input that is not a path, instead of falling through to the first entry', () => {
    expect(activeNavId(undefined)).toBeNull();
    expect(activeNavId(null)).toBeNull();
    expect(activeNavId('')).toBeNull();
    expect(activeNavId('agents')).toBeNull();
    expect(activeNavId(42)).toBeNull();
  });
});

describe('crumbsFor', () => {
  it('reproduces the mockup’s own trail for the home screen', () => {
    expect(crumbsFor('/')).toEqual(['New chat']);
  });

  it('reproduces the mockup’s own trail for the Agents screen', () => {
    expect(crumbsFor('/agents')).toEqual(['Agents']);
  });

  it('prefixes an administration screen with its group heading', () => {
    expect(crumbsFor('/admin/settings')).toEqual(['Administration', 'Settings']);
  });

  it('returns an empty trail rather than a guess for an unknown or malformed path', () => {
    expect(crumbsFor('/not-a-page')).toEqual([]);
    expect(crumbsFor(undefined)).toEqual([]);
    expect(crumbsFor('')).toEqual([]);
  });
});
