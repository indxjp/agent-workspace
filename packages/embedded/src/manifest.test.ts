import { readFileSync } from 'node:fs';

import { CONTRACTS_VERSION } from '@indx-workspace/contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const manifest = z
  .looseObject({
    name: z.string(),
    version: z.string(),
    private: z.boolean().optional(),
    exports: z.unknown(),
    bin: z.unknown(),
  })
  .parse(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')));

describe('the workspace manifest of @indx-workspace/embedded (ADR-0109)', () => {
  it('is named in the published scope and stays private: only publish/ is ever packed', () => {
    expect(manifest.name).toBe('@indx-workspace/embedded');
    expect(manifest.private).toBe(true);
  });

  it('is released in lock-step with the contracts', () => {
    expect(manifest.version).toBe(CONTRACTS_VERSION);
  });

  it('exports the launch entry and its own manifest, and no importable API', () => {
    expect(manifest.exports).toStrictEqual({
      './launch': './dist/bin.js',
      './package.json': './package.json',
    });
  });

  it('names one bin, the wrapper, never the bundle', () => {
    expect(manifest.bin).toStrictEqual({ 'agent-workspace-embedded': './dist/bin.js' });
  });
});
