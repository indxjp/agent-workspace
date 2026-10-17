import { describe, expect, it } from 'vitest';

import {
  SURFACE_DEFAULTS,
  surfaceAccentForeground,
  surfaceThemeStyle,
  surfaceWidgetLook,
} from './theme.js';

describe('surfaceThemeStyle (S1-18, #456)', () => {
  it('renders every default when the theme is unset', () => {
    expect(SURFACE_DEFAULTS).toEqual({
      colour: '#2f5fd0',
      radius: 8,
      mode: 'system',
      density: 'comfortable',
      locale: 'en',
      layout: 'dock',
      toolTrace: 'hidden',
    });
    expect(surfaceThemeStyle()).toEqual({
      colorScheme: 'light dark',
      '--accent': '#2f5fd0',
      '--accent-foreground': '#ffffff',
      '--radius': '8px',
      '--surface-gap': '16px',
      '--surface-pad': '24px',
      '--surface-text': '14px',
    });
  });

  it('sets the accent and a contrasting foreground from the colour', () => {
    expect(surfaceThemeStyle({ colour: '#0a7f5a' })).toMatchObject({
      '--accent': '#0a7f5a',
      '--accent-foreground': '#ffffff',
    });
    expect(surfaceThemeStyle({ colour: '#ffd400' })).toMatchObject({
      '--accent': '#ffd400',
      '--accent-foreground': '#1b1a18',
    });
    expect(surfaceAccentForeground('#000000')).toBe('#ffffff');
    expect(surfaceAccentForeground('#FFFFFF')).toBe('#1b1a18');
    expect(() => surfaceAccentForeground('blue')).toThrow(TypeError);
  });

  it('sets the radius in pixels and the density spacing', () => {
    expect(surfaceThemeStyle({ radius: 0 })['--radius']).toBe('0px');
    expect(surfaceThemeStyle({ radius: 32 })['--radius']).toBe('32px');
    expect(surfaceThemeStyle({ density: 'compact' })).toMatchObject({
      '--surface-gap': '8px',
      '--surface-pad': '12px',
      '--surface-text': '13px',
    });
  });

  it('writes the light or dark palette, and only the colour scheme for system', () => {
    expect(surfaceThemeStyle({ mode: 'light' })).toMatchObject({
      colorScheme: 'light',
      '--bg': '#faf9f7',
      '--text': '#1b1a18',
    });
    expect(surfaceThemeStyle({ mode: 'dark' })).toMatchObject({
      colorScheme: 'dark',
      '--bg': '#141416',
      '--surface': '#1c1c1f',
      '--text': '#ececef',
    });
    const system = surfaceThemeStyle({ mode: 'system' });
    expect(system.colorScheme).toBe('light dark');
    expect(system).not.toHaveProperty('--bg');
  });
});

describe('surfaceWidgetLook (S1-18, #456)', () => {
  it('falls back to the agent name and the default look', () => {
    expect(surfaceWidgetLook({ name: 'main', agent: 'Support triage' }, 'Support triage')).toEqual({
      colour: '#2f5fd0',
      foreground: '#ffffff',
      radius: 8,
      layout: 'dock',
      launcherLabel: 'Open Support triage',
      frameTitle: 'Support triage',
    });
  });

  it('uses the title, the theme and the locale labels', () => {
    expect(
      surfaceWidgetLook(
        {
          name: 'main',
          agent: 'Support triage',
          title: 'ヘルプ',
          theme: { colour: '#ffd400', radius: 16, locale: 'ja' },
          layout: 'side',
        },
        'Support triage',
      ),
    ).toEqual({
      colour: '#ffd400',
      foreground: '#1b1a18',
      radius: 16,
      layout: 'side',
      launcherLabel: 'ヘルプを開く',
      frameTitle: 'ヘルプ',
    });
  });
});
