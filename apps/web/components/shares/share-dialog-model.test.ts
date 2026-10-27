import { createClient } from '@indx-workspace/sdk';
import { fetchDouble, jsonResponse, type RecordedRequest } from '@indx-workspace/sdk/testing';
import { describe, expect, it } from 'vitest';

import { publishShare, sharePublishCommand, type ShareSubject } from './share-dialog-model';

const SESSION: ShareSubject = {
  type: 'session',
  id: '55555555-5555-4555-8555-555555555555',
  label: 'General',
};
const RUN = '11111111-1111-4111-8111-111111111111';

const share = {
  id: '99999999-9999-4999-8999-999999999999',
  subjectType: 'session',
  subjectId: SESSION.id,
  subjectLabel: 'General',
  visibility: 'workspace',
  mode: null,
  snapshot: null,
  include: {},
  budgetCapUsd: null,
  spentUsd: '0',
  stopped: false,
  expiresAt: null,
  revokedAt: null,
  suspendedAt: null,
  createdAt: '2026-10-19T10:00:00.000Z',
};

function api(route: (request: RecordedRequest) => Response) {
  const double = fetchDouble(route);
  const client = createClient({
    baseUrl: 'https://aw.example.com',
    auth: { kind: 'session' },
    fetch: double.fetch,
  });
  return { client, calls: double.calls };
}

describe('sharePublishCommand', () => {
  it('names the runs a session share publishes, never their text', () => {
    expect(sharePublishCommand(SESSION, 'public', '24 h', '', [RUN])).toEqual({
      subjectType: 'session',
      subjectId: SESSION.id,
      subjectLabel: 'General',
      visibility: 'public',
      expiry: '24 h',
      transcript: { runIds: [RUN] },
    });
  });

  it('sends no transcript without runs, and a definition mode for an agent', () => {
    expect(sharePublishCommand(SESSION, 'private', 'never', 'pw')).not.toHaveProperty('transcript');
    expect(
      sharePublishCommand({ type: 'agent', id: 'a', label: 'A' }, 'workspace', 'never', '', [RUN]),
    ).toEqual({
      subjectType: 'agent',
      subjectId: 'a',
      subjectLabel: 'A',
      visibility: 'workspace',
      mode: 'definition',
      expiry: 'never',
    });
  });
});

describe('publishShare', () => {
  const command = sharePublishCommand(SESSION, 'workspace', 'never', '', [RUN]);

  it('publishes through the SDK and answers the public link, or null without one', async () => {
    const workspace = api(() => jsonResponse(201, share));
    expect(await publishShare(workspace.client, command)).toEqual({ url: null });
    expect(workspace.calls[0]?.json).toMatchObject({ transcript: { runIds: [RUN] } });

    const link = api(() =>
      jsonResponse(201, { ...share, visibility: 'public', url: '/p/pub_abcdefghijklmnopqrstuvwx' }),
    );
    expect(await publishShare(link.client, command)).toEqual({
      url: '/p/pub_abcdefghijklmnopqrstuvwx',
    });
  });

  it("shows the server's sentence when it refuses the share", async () => {
    const refused = api(() =>
      jsonResponse(400, {
        error: {
          code: 'invalid_share',
          message: 'transcript.runIds[0] is not a run of this session.',
        },
      }),
    );
    expect(await publishShare(refused.client, command)).toEqual({
      problem: 'transcript.runIds[0] is not a run of this session.',
    });
  });
});
