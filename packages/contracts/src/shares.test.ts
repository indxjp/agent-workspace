import { describe, expect, it } from 'vitest';

import {
  SHARE_EXPIRIES,
  SHARE_MODES,
  SHARE_PASSPHRASE_MAX_LENGTH,
  SHARE_SUBJECT_TYPES,
  SHARE_VISIBILITIES,
  SHARES_PROBLEM_CODES,
  ShareIncludeSchema,
  ShareListItemSchema,
  ShareListResponseSchema,
  ShareResourceSchema,
} from './shares.js';

const share = {
  id: '99999999-9999-4999-8999-999999999999',
  subjectType: 'session',
  subjectId: '55555555-5555-4555-8555-555555555555',
  subjectLabel: 'Incident review',
  visibility: 'workspace',
  mode: null,
  snapshot: { messages: [] },
  include: { technicalDetails: true },
  budgetCapUsd: null,
  spentUsd: '0',
  stopped: false,
  expiresAt: null,
  revokedAt: null,
  suspendedAt: null,
  createdAt: '2026-09-21T10:00:00.000Z',
};

const publicShare = {
  ...share,
  visibility: 'public',
  url: '/p/pub_abcdefghijklmnopqrstuvwx',
  expiresAt: '2026-09-28T10:00:00.000Z',
};

describe('ShareResourceSchema', () => {
  it('accepts a workspace share, a public one with its link, and a runnable agent share', () => {
    expect(ShareResourceSchema.safeParse(share).success).toBe(true);
    expect(ShareResourceSchema.safeParse(publicShare).success).toBe(true);
    expect(
      ShareResourceSchema.safeParse({
        ...publicShare,
        subjectType: 'agent',
        mode: 'runnable',
        include: {},
        snapshot: null,
        budgetCapUsd: '20.0000',
        spentUsd: '1.250000',
        stopped: true,
        suspendedAt: '2026-09-22T10:00:00.000Z',
      }).success,
    ).toBe(true);
  });

  it('holds the public-link invariant in both directions', () => {
    expect(ShareResourceSchema.safeParse({ ...share, url: '/p/leaked' }).success).toBe(false);
    const withoutUrl = Object.fromEntries(
      Object.entries(publicShare).filter(([key]) => key !== 'url'),
    );
    expect(ShareResourceSchema.safeParse(withoutUrl).success).toBe(false);
    expect(ShareResourceSchema.safeParse({ ...publicShare, url: 'https://x/p/t' }).success).toBe(
      false,
    );
  });

  it('rejects an unknown subject type, visibility or mode, and a wrongly typed field', () => {
    expect(ShareResourceSchema.safeParse({ ...share, subjectType: 'run' }).success).toBe(false);
    expect(ShareResourceSchema.safeParse({ ...share, visibility: 'org' }).success).toBe(false);
    expect(ShareResourceSchema.safeParse({ ...share, mode: 'editable' }).success).toBe(false);
    expect(ShareResourceSchema.safeParse({ ...share, spentUsd: 0 }).success).toBe(false);
    expect(ShareResourceSchema.safeParse({ ...share, stopped: 'no' }).success).toBe(false);
    expect(ShareResourceSchema.safeParse({ ...share, createdAt: 1_700_000_000 }).success).toBe(
      false,
    );
  });

  it('rejects the persistence-only fields, any unknown key, and a missing required field', () => {
    for (const leaked of ['token', 'passphraseHash', 'workspaceId', 'createdBy']) {
      expect(ShareResourceSchema.safeParse({ ...share, [leaked]: 'x' }).success).toBe(false);
    }
    expect(ShareResourceSchema.safeParse({ ...share, viewCount: 1 }).success).toBe(false);
    const withoutSpent = Object.fromEntries(
      Object.entries(share).filter(([key]) => key !== 'spentUsd'),
    );
    expect(ShareResourceSchema.safeParse(withoutSpent).success).toBe(false);
  });

  it('keeps include to the two flags the server knows', () => {
    expect(ShareIncludeSchema.safeParse({}).success).toBe(true);
    expect(ShareIncludeSchema.safeParse({ outputFiles: false }).success).toBe(true);
    expect(ShareIncludeSchema.safeParse({ privateNotes: true }).success).toBe(false);
    expect(ShareIncludeSchema.safeParse({ outputFiles: 'yes' }).success).toBe(false);
    expect(ShareResourceSchema.safeParse({ ...share, include: null }).success).toBe(false);
  });
});

describe('list envelope', () => {
  it('requires a view count on every item and refuses one on the bare resource', () => {
    expect(ShareListItemSchema.safeParse({ ...publicShare, viewCount: 3 }).success).toBe(true);
    expect(ShareListItemSchema.safeParse(share).success).toBe(false);
    expect(ShareListItemSchema.safeParse({ ...share, viewCount: -1 }).success).toBe(false);
    expect(ShareListItemSchema.safeParse({ ...share, viewCount: 1.5 }).success).toBe(false);
    expect(
      ShareListResponseSchema.safeParse({ shares: [{ ...share, viewCount: 0 }] }).success,
    ).toBe(true);
    expect(ShareListResponseSchema.safeParse({ shares: [share] }).success).toBe(false);
    expect(ShareListResponseSchema.safeParse({ shares: [], total: 0 }).success).toBe(false);
  });
});

describe('vocabulary', () => {
  it('publishes the tuples, the passphrase bound and the problem codes the routes use', () => {
    expect(SHARE_SUBJECT_TYPES).toEqual(['agent', 'session', 'project', 'skill']);
    expect(SHARE_VISIBILITIES).toEqual(['private', 'workspace', 'public']);
    expect(SHARE_MODES).toEqual(['definition', 'runnable']);
    expect(SHARE_EXPIRIES).toEqual(['24 h', '7 days', '30 days', 'never']);
    expect(SHARE_PASSPHRASE_MAX_LENGTH).toBe(1024);
    expect(SHARES_PROBLEM_CODES.invalid_share).toBe(400);
    expect(SHARES_PROBLEM_CODES.share_not_found).toBe(404);
    expect(SHARES_PROBLEM_CODES.shares_runtime_not_configured).toBe(503);
  });
});
