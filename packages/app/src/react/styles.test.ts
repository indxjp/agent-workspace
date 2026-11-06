/// <reference types="node" />
import { readFileSync } from 'node:fs';

import { surfaceThemeStyle } from '@indx-workspace/react/theme';
import { describe, expect, it } from 'vitest';

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
const css = read('./styles.css');
const sources = [
  './resource-list.tsx',
  './resource-board.tsx',
  './resource-form.tsx',
  './resource-detail.tsx',
  './resource-cell.tsx',
  './theme.tsx',
  './agent-panel.tsx',
  './recipe-graph.tsx',
  './dashboard.tsx',
  './channel-view.tsx',
  './page-tree.tsx',
  './rich-text.tsx',
  './page-view.tsx',
].map(read);

/** The custom properties `surfaceThemeStyle` may set, in any mode and density. */
const themed = new Set(
  [
    surfaceThemeStyle({}),
    surfaceThemeStyle({ mode: 'light', density: 'compact' }),
    surfaceThemeStyle({ mode: 'dark' }),
  ].flatMap((style) => Object.keys(style).filter((key) => key.startsWith('--'))),
);

/** `name: #rrggbb;` declarations of a block of the stylesheet. */
function palette(block: string): ReadonlyMap<string, string> {
  return new Map(
    [...block.matchAll(/(--[a-z0-9-]+):\s*(#[0-9a-f]{6});/giu)].map((m) => [
      m[1] ?? '',
      m[2] ?? '',
    ]),
  );
}

function luminance(hex: string): number {
  const linear = (offset: number): number => {
    const channel = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(1) + 0.7152 * linear(3) + 0.0722 * linear(5);
}

function contrast(left: string, right: string): number {
  const [a, b] = [luminance(left), luminance(right)];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const [lightBlock = '', darkBlock = ''] = css.split('@media (prefers-color-scheme: dark)');

describe('styles.css (#1508)', () => {
  it('styles every aw-app class the parts use', () => {
    const used = new Set(sources.flatMap((source) => source.match(/\baw-app[a-z-]*/gu) ?? []));
    expect(used.size).toBeGreaterThan(30);
    for (const name of used) expect(css, name).toContain(`.${name}`);
  });

  it('references only custom properties it declares or the theme sets', () => {
    const declared = new Set([...css.matchAll(/(--[a-z0-9-]+):/gu)].map((m) => m[1]));
    const referenced = [...css.matchAll(/var\((--[a-z0-9-]+)/gu)].map((m) => m[1] ?? '');
    expect(referenced.length).toBeGreaterThan(20);
    for (const name of referenced) {
      expect(declared.has(name) || themed.has(name), name).toBe(true);
    }
    for (const property of ['--accent', '--accent-foreground', '--radius', '--surface-gap']) {
      expect(css).toContain(`var(${property}`);
    }
  });

  it('keeps the system palette equal to the one theme.ts forces', () => {
    for (const [block, mode] of [
      [lightBlock, 'light'],
      [darkBlock, 'dark'],
    ] as const) {
      const declared = palette(block);
      const forced = Object.entries(surfaceThemeStyle({ mode })).filter(([key]) =>
        ['--bg', '--surface', '--surface-2', '--border', '--text', '--text-2', '--muted'].includes(
          key,
        ),
      );
      expect(forced).toHaveLength(7);
      for (const [key, value] of forced) expect(declared.get(key), `${mode} ${key}`).toBe(value);
    }
  });

  it('keeps text and danger colours at WCAG AA contrast on every background, light and dark', () => {
    for (const block of [lightBlock, darkBlock]) {
      const colour = palette(block);
      const get = (name: string): string => colour.get(name) ?? '#000000';
      for (const background of ['--bg', '--surface', '--surface-2']) {
        for (const foreground of ['--text', '--text-2', '--aw-app-danger']) {
          expect(
            contrast(get(foreground), get(background)),
            `${foreground} on ${background}`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
      for (const foreground of ['--text', '--aw-app-danger']) {
        expect(contrast(get(foreground), get('--aw-app-danger-surface'))).toBeGreaterThanOrEqual(
          4.5,
        );
      }
    }
  });

  it('draws a visible focus ring and no Tailwind', () => {
    expect(css).toMatch(/:focus-visible \{[^}]*outline: 2px solid var\(--accent\)/u);
    expect(css).not.toMatch(/@(?:import|apply|tailwind|theme|source)/u);
    for (const source of sources) {
      expect(source).not.toMatch(/className="[^"]*(?:flex|px-|rounded-|text-\[|bg-)/u);
    }
  });
});
