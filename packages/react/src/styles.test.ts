/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { surfaceThemeStyle } from './theme.js';

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
const css = read('./styles.css');
const sources = ['./layout.tsx', './parts.tsx', './surface-chat.tsx'].map(read);

describe("styles.css (#699): the default parts look right without the host's Tailwind", () => {
  it('styles every aw- class the components use', () => {
    const used = new Set(sources.flatMap((source) => source.match(/\baw-[a-z-]+/gu) ?? []));
    expect(used.size).toBeGreaterThan(30);
    for (const name of used) expect(css, name).toContain(`.${name}`);
  });

  it('leaves no Tailwind utility class in the components and no Tailwind in the stylesheet', () => {
    for (const source of sources) {
      expect(source).not.toMatch(/className="[^"]*(?:flex|px-|rounded-|text-\[|bg-)/u);
    }
    expect(css).not.toMatch(/@(?:import|apply|tailwind|theme|source)/u);
  });

  it('is driven by the theme custom properties', () => {
    for (const property of ['--accent', '--accent-foreground', '--radius', '--surface-gap']) {
      expect(css).toContain(`var(${property}`);
    }
    expect(Object.keys(surfaceThemeStyle({}))).toEqual(
      expect.arrayContaining(['--accent', '--radius']),
    );
  });

  it('keeps the system palette equal to the one theme.ts forces', () => {
    const [light, dark] = css.split('@media (prefers-color-scheme: dark)');
    for (const [block, mode] of [
      [light, 'light'],
      [dark, 'dark'],
    ] as const) {
      const palette = Object.entries(surfaceThemeStyle({ mode })).filter(([key]) =>
        ['--bg', '--surface', '--border', '--text', '--text-2', '--muted'].includes(key),
      );
      expect(palette).toHaveLength(6);
      for (const [key, value] of palette) expect(block).toContain(`${key}: ${value};`);
    }
  });

  it('keeps the dock composer pinned and the message list floored (#558)', () => {
    expect(css).toMatch(/\[data-layout='side'\] \{[^}]*height: 100vh;[^}]*overflow-y: auto/u);
    expect(css).toMatch(/\.aw-frame-body \{[^}]*min-height: 6rem;[^}]*overflow-y: auto/u);
    expect(css).toMatch(
      /\.aw-frame-footer \{[^}]*position: sticky;[^}]*bottom: 0;[^}]*max-height: 50vh;[^}]*overflow-y: auto;[^}]*background: var\(--bg\)/u,
    );
    expect(css).toMatch(/\.aw-frame-column \{[^}]*max-width: 760px/u);
  });

  it('keeps the resets at zero specificity so every aw-* part rule wins', () => {
    expect(css).not.toMatch(/\.aw-surface :is\(/u);
  });
});
