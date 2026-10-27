import { CONTRACTS_VERSION, CONTRACTS_VERSION_HEADER } from '@indx-workspace/contracts';
import { jsonResponse } from '@indx-workspace/sdk/testing';
import { describe, expect, it } from 'vitest';

import {
  detectionOf,
  INVALID_ADMIN_CREDENTIALS_MESSAGE,
  SETUP_REQUEST_HEADERS,
  SETUP_UNANSWERED,
  setupOutcomeOf,
  setupUnanswered,
} from './setup-requests-model';

const refused = (status: number, code: string, message: string) =>
  jsonResponse(status, { error: { code, message } });

it('states the contracts version on both setup calls', () => {
  expect(SETUP_REQUEST_HEADERS).toEqual({ [CONTRACTS_VERSION_HEADER]: CONTRACTS_VERSION });
});

describe('setupOutcomeOf', () => {
  it('returns the first agent of a completed setup', async () => {
    await expect(
      setupOutcomeOf(jsonResponse(201, { agentId: 'agent-1', runtimeRefusal: null })),
    ).resolves.toEqual({ ok: true, agentId: 'agent-1' });
  });

  it('names the generator values when the administrator credentials do not match', async () => {
    await expect(
      setupOutcomeOf(
        refused(401, 'invalid_credentials', 'Administrator credentials did not match.'),
      ),
    ).resolves.toEqual({ ok: false, message: INVALID_ADMIN_CREDENTIALS_MESSAGE });
  });

  it("shows any other refusal's own message", async () => {
    await expect(
      setupOutcomeOf(refused(400, 'invalid_setup', 'Every setup field is required.')),
    ).resolves.toEqual({ ok: false, message: 'Every setup field is required.' });
  });

  it.each([
    ['an unenveloped failure', () => new Response('<html>boom</html>', { status: 502 }), 502],
    ['a success without an agent', () => jsonResponse(201, { agentId: '' }), 201],
  ])('words %s by its status', async (_name, respond, status) => {
    await expect(setupOutcomeOf(respond())).resolves.toEqual({
      ok: false,
      message: `Setup returned ${String(status)}.`,
    });
  });
});

describe('setupUnanswered', () => {
  it('says the server was not reached, whatever the network error said', () => {
    expect(setupUnanswered()).toEqual({ ok: false, message: SETUP_UNANSWERED });
  });
});

describe('detectionOf', () => {
  const detection = {
    defaultDriver: 'docker',
    drivers: [
      { id: 'local', available: true, reason: 'Runs on this host.' },
      { id: 'docker', available: true, reason: 'The runner manager answered.' },
    ],
  };

  it('reads which drivers the host offers', async () => {
    await expect(detectionOf(jsonResponse(200, detection))).resolves.toEqual(detection);
  });

  it.each([
    ['a refusal', () => refused(503, 'setup_unavailable', 'Not configured.')],
    ['an unreadable answer', () => jsonResponse(200, { drivers: 'docker' })],
    ['a body that is not JSON', () => new Response('<html></html>', { status: 200 })],
  ])('is null on %s', async (_name, respond) => {
    await expect(detectionOf(respond())).resolves.toBeNull();
  });
});
