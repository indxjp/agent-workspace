import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

/**
 * `ProjectsScreen` reads `useSearchParams`/`usePathname`/`useRouter` from `next/navigation` since
 * issue #184 put the archived filter in the URL, and those return `null`/throw outside a real Next
 * router. Mocking the module is the pattern `../run/history-screen.test.tsx` already established
 * here for exactly this.
 */
let searchParams = new URLSearchParams('');

vi.mock('next/navigation', () => ({
  usePathname: () => '/projects',
  useSearchParams: () => searchParams,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), forward: vi.fn() }),
}));

const { ProjectsScreen } = await import('./projects-screen');
const { describeEmptyProjectList, parseProjectFilter, projectsListQuery } = await import('./model');

function render(query: string): string {
  searchParams = new URLSearchParams(query);
  return renderToStaticMarkup(<ProjectsScreen />);
}

describe('ProjectsScreen', () => {
  it('renders the heading and a control to start a new project, before any fetch resolves', () => {
    // `renderToStaticMarkup` never runs effects, so this is the screen's very first paint — the
    // same state a browser shows for the instant before `/api/projects` and `/api/agents` answer.
    const html = render('');
    expect(html).toContain('Projects');
    expect(html).toContain('New project');
    expect(html).toContain('Loading');
  });

  it('renders the archived filter on first paint, with an accessible name', () => {
    const html = render('');
    expect(html).toContain('id="projects-archived-filter"');
    expect(html).toContain('for="projects-archived-filter"');
    expect(html).toContain('Active');
    expect(html).toContain('Archived');
    expect(html).toContain('All');
  });

  it('selects the filter the URL names, so an archived view is linkable', () => {
    expect(render('archived=archived')).toContain('<option value="archived" selected="">');
    expect(render('archived=all')).toContain('<option value="all" selected="">');
  });

  it('falls back to the active view for a filter the URL spells wrong', () => {
    expect(render('archived=nonsense')).toContain('<option value="active" selected="">');
  });

  it('asks the list route for the slice the URL names', () => {
    // The screen fetches in an effect this renderer never runs, so the URL itself is pinned here —
    // `projects-screen.tsx` builds it from exactly these two functions.
    expect(projectsListQuery(parseProjectFilter('archived'))).toBe(
      '/api/projects?archived=archived',
    );
    expect(projectsListQuery(parseProjectFilter(null))).toBe('/api/projects?archived=active');
  });

  it('has empty-state copy that fits the filter the view is showing', () => {
    // Reached only after a fetch resolves, which this renderer never does — the copy is pinned at
    // its own function, which is what the screen renders.
    expect(describeEmptyProjectList(parseProjectFilter('archived'))).toBe('No archived projects.');
    expect(describeEmptyProjectList(parseProjectFilter('active'))).toContain('Create one above');
  });
});
