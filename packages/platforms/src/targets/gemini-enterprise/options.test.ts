import { describe, expect, it } from 'vitest';

import { GeminiEnterpriseOptionsSchema } from './options.js';

const BASE = {
  projectId: 'acme-agents',
  location: 'global',
  engineId: 'acme-support-app',
  publicBaseUrl: 'https://aw.example.com',
};

const parse = (patch: Record<string, unknown> = {}) =>
  GeminiEnterpriseOptionsSchema.safeParse({ ...BASE, ...patch });

describe('gemini-enterprise options', () => {
  it('accepts an https origin with or without the trailing slash', () => {
    expect(parse().success).toBe(true);
    expect(parse({ publicBaseUrl: 'https://aw.example.com/' }).success).toBe(true);
  });

  it.each([
    'http://aw.example.com',
    'https://aw.example.com/path',
    'https://aw.example.com/?q=1',
    'https://aw.example.com/#frag',
    'https://user:pw@aw.example.com',
    'not a url',
    'https://',
    'http://[::1',
  ])('refuses %s', (publicBaseUrl) => {
    expect(parse({ publicBaseUrl }).success).toBe(false);
  });

  it('defaults the card version and refuses unknown keys and locations', () => {
    const parsed = parse();
    expect(parsed.success && parsed.data.agentVersion).toBe('1.0.0');
    expect(parse({ extra: 1 }).success).toBe(false);
    expect(parse({ location: 'asia' }).success).toBe(false);
    expect(parse({ agentVersion: 'v1' }).success).toBe(false);
  });
});
