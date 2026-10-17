import { describe, expect, it } from 'vitest';

import {
  archiveConfirmationMatches,
  buildArchivePayload,
  buildCreatePayload,
  buildRenamePayload,
  isCreateFormValid,
  isRenameReady,
  suggestSlug,
} from './model';

describe('suggestSlug', () => {
  it('lower-cases, hyphenates and trims', () => {
    expect(suggestSlug('Acme  Corp!')).toBe('acme-corp');
    expect(suggestSlug('  -- Beta -- ')).toBe('beta');
  });

  it('caps the length so a very long name still suggests a usable slug', () => {
    expect(suggestSlug('a'.repeat(100)).length).toBe(64);
  });

  it('is blank for a name with no slug-able characters', () => {
    expect(suggestSlug('   ')).toBe('');
    expect(suggestSlug('!!!')).toBe('');
  });
});

describe('isCreateFormValid', () => {
  it('requires both fields non-blank', () => {
    expect(isCreateFormValid('Acme', 'acme')).toBe(true);
    expect(isCreateFormValid('', 'acme')).toBe(false);
    expect(isCreateFormValid('Acme', '')).toBe(false);
    expect(isCreateFormValid('   ', '   ')).toBe(false);
  });
});

describe('buildCreatePayload / buildRenamePayload / buildArchivePayload', () => {
  it('trims the create payload', () => {
    expect(buildCreatePayload('  Acme  ', '  acme  ')).toEqual({ name: 'Acme', slug: 'acme' });
  });

  it('trims the rename payload', () => {
    expect(buildRenamePayload('  Acme Corp  ')).toEqual({ name: 'Acme Corp' });
  });

  it('carries exactly the archived flag, nothing renamed alongside it', () => {
    expect(buildArchivePayload(true)).toEqual({ archived: true });
    expect(buildArchivePayload(false)).toEqual({ archived: false });
  });
});

describe('isRenameReady', () => {
  it('is false for a blank or unchanged name', () => {
    expect(isRenameReady('', 'Acme')).toBe(false);
    expect(isRenameReady('   ', 'Acme')).toBe(false);
    expect(isRenameReady('Acme', 'Acme')).toBe(false);
  });

  it('is true once the trimmed name actually differs', () => {
    expect(isRenameReady('Acme Corp', 'Acme')).toBe(true);
    expect(isRenameReady('  Acme Corp  ', 'Acme')).toBe(true);
  });
});

describe('archiveConfirmationMatches', () => {
  it('requires an exact, case-sensitive match of the workspace name', () => {
    expect(archiveConfirmationMatches('Acme Corp', 'Acme Corp')).toBe(true);
    expect(archiveConfirmationMatches('acme corp', 'Acme Corp')).toBe(false);
    expect(archiveConfirmationMatches('Acme Cor', 'Acme Corp')).toBe(false);
    expect(archiveConfirmationMatches('', 'Acme Corp')).toBe(false);
  });

  // BREAK-IT CHECK (done by hand, reverted before commit): loosening this to a
  // case-insensitive or trimmed comparison lets "acme corp" (typed without checking case) archive
  // "Acme Corp" — the mis-type this control exists to catch — and the second assertion above
  // fails (`true` instead of `false`). Restoring the exact `===` comparison fixes it.
});
