// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SidebarMenu } from './sidebar-menu';

const route = { pathname: '/agents' };
vi.mock('next/navigation', () => ({ usePathname: () => route.pathname }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

function menu() {
  return (
    <SidebarMenu brand={<span>Acme Corp</span>}>
      <nav>
        <a href="/files">Files</a>
      </nav>
    </SidebarMenu>
  );
}

function button(): HTMLButtonElement {
  const found = host.querySelector('button');
  if (found === null) throw new Error('no Menu button');
  return found;
}

function panel(): HTMLElement {
  const id = button().getAttribute('aria-controls');
  const found = id === null ? null : document.getElementById(id);
  if (found === null) throw new Error('aria-controls names no element');
  return found;
}

const shown = () => panel().classList.contains('flex') && !panel().classList.contains('hidden');

function press(target: HTMLElement, key: string) {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
}

beforeEach(() => {
  route.pathname = '/agents';
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root.render(menu());
  });
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
});

describe('SidebarMenu (UX-10)', () => {
  it('starts closed on a narrow screen, and the panel is always shown from md up', () => {
    expect(button().textContent).toBe('Menu');
    expect(button().getAttribute('aria-expanded')).toBe('false');
    expect(button().classList.contains('md:hidden')).toBe(true);
    expect(shown()).toBe(false);
    expect(panel().classList.contains('md:flex')).toBe(true);
    // The navigation stays in the tree, so the desktop sidebar is unchanged.
    expect(panel().textContent).toContain('Files');
  });

  it('opens and closes with the button', () => {
    act(() => {
      button().click();
    });
    expect(button().getAttribute('aria-expanded')).toBe('true');
    expect(shown()).toBe(true);

    act(() => {
      button().click();
    });
    expect(button().getAttribute('aria-expanded')).toBe('false');
    expect(shown()).toBe(false);
  });

  it('closes on Esc from inside the menu and returns focus to the button', () => {
    act(() => {
      button().click();
    });
    const link = panel().querySelector('a');
    if (link === null) throw new Error('no link');
    link.focus();

    press(link, 'Escape');

    expect(button().getAttribute('aria-expanded')).toBe('false');
    expect(shown()).toBe(false);
    expect(document.activeElement).toBe(button());
  });

  it('closes on Esc from the button, and ignores other keys', () => {
    act(() => {
      button().click();
    });
    press(button(), 'Enter');
    expect(shown()).toBe(true);

    press(button(), 'Escape');
    expect(shown()).toBe(false);
  });

  it('closes after a link in it takes the reader to another page', () => {
    act(() => {
      button().click();
    });
    expect(shown()).toBe(true);

    route.pathname = '/files';
    act(() => {
      root.render(menu());
    });
    expect(button().getAttribute('aria-expanded')).toBe('false');
    expect(shown()).toBe(false);
  });
});
