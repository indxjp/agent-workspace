import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { parseA10 } from '../driver-matrix/renderer.mjs';
import { decideEvidenceMark } from '../providers/renderer.mjs';

describe('Wave 8 evidence-backed matrix weakening gates', () => {
  it.each(['skipped', 'failed', 'missing'] as const)(
    'never turns a %s scenario into a positive mark',
    (status) => {
      expect(decideEvidenceMark(status, 'native')).toBe('unverified');
      expect(decideEvidenceMark(status, 'approximated')).toBe('unverified');
    },
  );

  it('never turns a renamed or deleted scenario or missing capability into a positive mark', () => {
    expect(decideEvidenceMark('missing', 'native')).toBe('unverified');
    expect(decideEvidenceMark('passed', 'missing')).toBe('unverified');
  });

  it('requires an explicit unsupported declaration and a passing approximation', () => {
    expect(decideEvidenceMark('missing', 'unsupported')).toBe('unsupported');
    expect(decideEvidenceMark('passed', 'approximated')).toBe('approximated');
    expect(decideEvidenceMark('failed', 'approximated')).toBe('unverified');
  });

  it('quotes both source legends and publishes the two honesty extensions', async () => {
    const [spec, providers, runtimes] = await Promise.all([
      readFile(new URL('../../docs/spec.md', import.meta.url), 'utf8'),
      readFile(new URL('../../docs/compatibility/providers.md', import.meta.url), 'utf8'),
      readFile(new URL('../../docs/runtime-driver-matrix.md', import.meta.url), 'utf8'),
    ]);
    expect(spec).toContain('✓ native/compatible\n~ approximated\n- unsupported');
    expect(providers).toContain('✓ native/compatible\n~ approximated\n- unsupported');
    const a10Legend = parseA10(spec).legend;
    expect(spec).toContain(a10Legend);
    expect(runtimes).toContain(a10Legend);
    for (const document of [providers, runtimes]) {
      expect(document).toContain('? not verified in this build');
      expect(document).toContain('n/d not derivable');
    }
  });
});
