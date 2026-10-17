import { describe, expect, it } from 'vitest';

import {
  PROJECT_KEY_PATTERN,
  SESSION_STATUSES,
  SESSION_LIST_MAX_LIMIT,
  SessionListResponseSchema,
  SessionResourceSchema,
  SessionResponseSchema,
  TRANSCRIPT_SUBPATH_MAX_LENGTH,
  TRANSCRIPT_SUBPATH_PATTERN,
  TranscriptResponseSchema,
  TranscriptSubkeysResponseSchema,
  transcriptSearchParams,
} from './sessions.js';

const session = {
  id: '55555555-5555-4555-8555-555555555555',
  workspaceId: '44444444-4444-4444-8444-444444444444',
  agentId: '11111111-1111-4111-8111-111111111111',
  userId: null,
  ownerPrincipalId: 'principal-1',
  projectId: null,
  engineSessionId: null,
  engine: null,
  title: null,
  status: 'active',
  resumable: false,
  createdAt: '2026-09-21T10:00:00.000Z',
  updatedAt: '2026-09-21T10:00:00.000Z',
};

describe('SessionResourceSchema', () => {
  it('accepts a fresh session and a resumable, titled, project-attributed one', () => {
    expect(SessionResourceSchema.safeParse(session).success).toBe(true);
    expect(
      SessionResourceSchema.safeParse({
        ...session,
        userId: '77777777-7777-4777-8777-777777777777',
        projectId: '66666666-6666-4666-8666-666666666666',
        engineSessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        engine: 'claude-agent-sdk',
        title: 'Incident 42',
        status: 'archived',
        resumable: true,
      }).success,
    ).toBe(true);
  });

  it('rejects an unknown status, an unknown key, a wrong type, and a missing field', () => {
    expect(SessionResourceSchema.safeParse({ ...session, status: 'paused' }).success).toBe(false);
    expect(SessionResourceSchema.safeParse({ ...session, transcript: [] }).success).toBe(false);
    expect(SessionResourceSchema.safeParse({ ...session, resumable: 'yes' }).success).toBe(false);
    expect(SessionResourceSchema.safeParse({ ...session, createdAt: 1_700_000_000 }).success).toBe(
      false,
    );
    const withoutOwner = Object.fromEntries(
      Object.entries(session).filter(([key]) => key !== 'ownerPrincipalId'),
    );
    expect(SessionResourceSchema.safeParse(withoutOwner).success).toBe(false);
  });

  it('publishes the two lifecycle states', () => {
    expect([...SESSION_STATUSES]).toEqual(['active', 'archived']);
  });
});

describe('session envelopes', () => {
  it('reads the item and the page, and refuses a page without its projectKey or nextCursor', () => {
    const page = { sessions: [session], projectKey: session.workspaceId, nextCursor: null };
    expect(SessionResponseSchema.safeParse({ session }).success).toBe(true);
    expect(SessionResponseSchema.safeParse({ session, extra: 1 }).success).toBe(false);
    expect(SessionListResponseSchema.safeParse(page).success).toBe(true);
    expect(SessionListResponseSchema.safeParse({ ...page, nextCursor: 'eyJ2IjoxfQ' }).success).toBe(
      true,
    );
    expect(SessionListResponseSchema.safeParse({ ...page, nextCursor: '' }).success).toBe(false);
    expect(
      SessionListResponseSchema.safeParse({ sessions: [session], projectKey: 'ws' }).success,
    ).toBe(false);
    expect(
      SessionListResponseSchema.safeParse({ sessions: [session], nextCursor: null }).success,
    ).toBe(false);
    expect(SessionListResponseSchema.safeParse({ ...page, projectKey: '' }).success).toBe(false);
    expect(SessionListResponseSchema.safeParse({ ...page, total: 1 }).success).toBe(false);
  });

  it('exposes the page ceiling', () => {
    expect(SESSION_LIST_MAX_LIMIT).toBe(200);
  });
});

describe('TranscriptResponseSchema', () => {
  it('accepts an empty transcript and provider-native entries of any shape', () => {
    expect(TranscriptResponseSchema.safeParse({ entries: [] }).success).toBe(true);
    expect(
      TranscriptResponseSchema.safeParse({
        entries: [
          { type: 'user', uuid: 'u-1', timestamp: '2026-09-21T10:00:00.000Z', message: {} },
          { type: 'assistant', uuid: 'a-1', message: { content: [{ type: 'text', text: 'hi' }] } },
          { type: 'summary', summary: 'A short chat', leafUuid: 'a-1' },
          'a bare line',
          42,
          null,
        ],
      }).success,
    ).toBe(true);
  });

  it('rejects a body without entries, entries that are not an array, and an unknown key', () => {
    expect(TranscriptResponseSchema.safeParse({}).success).toBe(false);
    expect(TranscriptResponseSchema.safeParse({ entries: 'user\nassistant' }).success).toBe(false);
    expect(TranscriptResponseSchema.safeParse({ entries: [], subkeys: [] }).success).toBe(false);
    expect(TranscriptResponseSchema.safeParse([]).success).toBe(false);
  });
});

describe('TranscriptSubkeysResponseSchema', () => {
  it('accepts no subkeys and the shape the Claude Agent SDK writes', () => {
    expect(TranscriptSubkeysResponseSchema.safeParse({ subkeys: [] }).success).toBe(true);
    expect(
      TranscriptSubkeysResponseSchema.safeParse({
        subkeys: ['subagents/agent-1a2b3c', 'subagents/agent-4d5e6f'],
      }).success,
    ).toBe(true);
  });

  it('rejects a missing field, a wrong type, an unknown key, and a subkey outside the grammar', () => {
    expect(TranscriptSubkeysResponseSchema.safeParse({}).success).toBe(false);
    expect(TranscriptSubkeysResponseSchema.safeParse({ subkeys: 'subagents' }).success).toBe(false);
    expect(TranscriptSubkeysResponseSchema.safeParse({ subkeys: [1] }).success).toBe(false);
    expect(TranscriptSubkeysResponseSchema.safeParse({ subkeys: [], entries: [] }).success).toBe(
      false,
    );
    for (const subkey of ['', '/subagents', 'a/../b', 'a\\b', 'sub agents']) {
      expect(
        TranscriptSubkeysResponseSchema.safeParse({ subkeys: [subkey] }).success,
        `subkey ${JSON.stringify(subkey)} must be refused`,
      ).toBe(false);
    }
  });

  it('holds a subkey to the route length bound', () => {
    const longest = 'a'.repeat(TRANSCRIPT_SUBPATH_MAX_LENGTH);
    expect(TranscriptSubkeysResponseSchema.safeParse({ subkeys: [longest] }).success).toBe(true);
    expect(TranscriptSubkeysResponseSchema.safeParse({ subkeys: [`${longest}a`] }).success).toBe(
      false,
    );
    expect(TRANSCRIPT_SUBPATH_PATTERN.test('subagents/agent-1')).toBe(true);
  });
});

describe('transcriptSearchParams', () => {
  it('renders nothing when both fields are absent — issue #235, S-21', () => {
    expect(transcriptSearchParams({}).toString()).toBe('');
  });

  it('renders only the fields that were given', () => {
    expect(transcriptSearchParams({ projectKey: session.workspaceId }).toString()).toBe(
      `projectKey=${session.workspaceId}`,
    );
    expect(transcriptSearchParams({ subpath: 'subagents/agent-1' }).toString()).toBe(
      'subpath=subagents%2Fagent-1',
    );
    const both = transcriptSearchParams({
      projectKey: session.workspaceId,
      subpath: 'subagents/agent-1',
    });
    expect(both.get('projectKey')).toBe(session.workspaceId);
    expect(both.get('subpath')).toBe('subagents/agent-1');
  });
});

describe('PROJECT_KEY_PATTERN', () => {
  it('matches a workspace id and refuses what the Claude Agent SDK would ignore silently', () => {
    expect(PROJECT_KEY_PATTERN.test(session.workspaceId)).toBe(true);
    expect(PROJECT_KEY_PATTERN.test('')).toBe(false);
    expect(PROJECT_KEY_PATTERN.test('a'.repeat(65))).toBe(false);
    expect(PROJECT_KEY_PATTERN.test('ws/acme')).toBe(false);
  });
});
