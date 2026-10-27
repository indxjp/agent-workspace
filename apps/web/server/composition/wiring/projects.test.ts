/**
 * The daily cost cap (issue #1851) on the public share run path: `createPublicShareRun` starts
 * runs without `startRunOnSession`, so it must consult the cap itself before writing any row.
 */
import type { ShareRecord } from '@agent-workspace/core/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getRunApi, type RunApiEnvironment } from '../../runs/environment';
import { createPublicShareRun } from './projects';

vi.mock('../../runs/environment', () => ({ getRunApi: vi.fn() }));

const WORKSPACE = '00000000-0000-4000-8000-000000000002';

const share: ShareRecord = {
  id: '00000000-0000-4000-8000-000000000001',
  workspaceId: WORKSPACE,
  token: 'pub_runnable',
  subjectType: 'agent',
  subjectId: 'agent-1',
  subjectLabel: 'Agent',
  visibility: 'public',
  mode: 'runnable',
  snapshot: null,
  include: {},
  budgetCapUsd: '20.0000',
  spentUsd: '0.000000',
  stopped: false,
  expiresAt: null,
  passphraseHash: null,
  createdBy: '00000000-0000-4000-8000-000000000003',
  publisherPrincipalId: '00000000-0000-4000-8000-000000000004',
  revokedAt: null,
  suspendedAt: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
};

const create = vi.fn();
const launch = vi.fn();
const forWorkspaceId = vi.fn();

function runPublicWith(refusal: RunApiEnvironment['dailyCostCap']) {
  vi.mocked(getRunApi).mockReturnValue({
    dailyCostCap: refusal,
    store: { create },
    launch,
  } as unknown as RunApiEnvironment);
  // Only the archived-workspace gate runs before the cap; every later dependency must stay unread.
  const runPublic = createPublicShareRun({
    runGate: { isUsable: () => Promise.resolve(true) },
    scopes: { forWorkspaceId },
  } as unknown as Parameters<typeof createPublicShareRun>[0]);
  return runPublic({ workspaceId: WORKSPACE, share, prompt: 'hi', sessionId: 'visitor-1' });
}

describe('createPublicShareRun daily cost cap', () => {
  beforeEach(() => vi.clearAllMocks());

  it('refuses a capped workspace before any session or run is written', async () => {
    const refusal = vi.fn(() =>
      Promise.resolve({ capUsd: 5, spentUsd: 5, resetsAt: '2026-10-27T00:00:00.000Z' }),
    );

    await expect(runPublicWith({ refusal })).rejects.toThrow(
      'The public share is unavailable: the workspace cannot start runs now.',
    );
    expect(refusal).toHaveBeenCalledWith(WORKSPACE);
    expect(forWorkspaceId).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });

  it('fails closed with the same unavailable error, and no cause, when the spend cannot be read', async () => {
    const failure = runPublicWith({
      refusal: () => Promise.reject(new Error('ledger unreachable')),
    });
    await expect(failure).rejects.toThrow(
      'The public share is unavailable: the workspace cannot start runs now.',
    );
    await expect(failure).rejects.not.toThrow('ledger unreachable');
    expect(forWorkspaceId).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });

  it('goes on to the later checks when the workspace is under its cap', async () => {
    forWorkspaceId.mockResolvedValue(null);
    await expect(runPublicWith({ refusal: () => Promise.resolve(null) })).rejects.toThrow(
      'The publishing workspace no longer exists.',
    );
    expect(create).not.toHaveBeenCalled();
  });
});
