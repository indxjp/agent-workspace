import type { WorkspaceSharing } from '../core/runtime';
import { describe, expect, it, vi } from 'vitest';

import { isPublicSharingEnabled, setPublicSharingPolicy } from './service';

function sharing(enabled = true) {
  const getPublicSharingEnabled = vi.fn().mockResolvedValue(enabled);
  const setPublicSharingEnabled = vi.fn();
  const writeAudit = vi.fn();
  const repositories: WorkspaceSharing = {
    shares: {
      list: vi.fn(),
      get: vi.fn(),
      findByToken: vi.fn(),
      create: vi.fn(),
      getPublicSharingEnabled,
      setPublicSharingEnabled,
      revoke: vi.fn(),
      stop: vi.fn(),
      reserveVisitorMessage: vi.fn(),
    },
    views: { record: vi.fn(), count: vi.fn() },
    audit: { write: writeAudit },
  };
  return { repositories, getPublicSharingEnabled, setPublicSharingEnabled, writeAudit };
}

describe('public sharing policy', () => {
  it('reads the durable repository value', async () => {
    const { repositories, getPublicSharingEnabled } = sharing(false);

    await expect(isPublicSharingEnabled(repositories)).resolves.toBe(false);
    expect(getPublicSharingEnabled).toHaveBeenCalledOnce();
  });

  it('persists the policy before recording the audit event', async () => {
    const { repositories, setPublicSharingEnabled, writeAudit } = sharing();

    await setPublicSharingPolicy(false, 'owner', repositories, {
      principalId: '00000000-0000-4000-8000-000000000004',
      userId: 'user-1',
      userLabel: 'owner@example.test',
    });

    expect(setPublicSharingEnabled).toHaveBeenCalledWith(false);
    expect(writeAudit).toHaveBeenCalledOnce();
  });

  it('does not mutate policy for non-owners', async () => {
    const { repositories, setPublicSharingEnabled } = sharing();

    await expect(
      setPublicSharingPolicy(true, 'admin', repositories, {
        principalId: '00000000-0000-4000-8000-000000000005',
        userId: 'user-1',
        userLabel: 'admin@example.test',
      }),
    ).rejects.toThrow('Only an Owner');
    expect(setPublicSharingEnabled).not.toHaveBeenCalled();
  });
});
