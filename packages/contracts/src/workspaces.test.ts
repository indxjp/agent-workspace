import { describe, expect, it } from 'vitest';

import {
  SharingPolicySchema,
  WorkspaceSwitchRequestSchema,
  WorkspaceSwitchResponseSchema,
} from './workspaces.js';

describe('SharingPolicySchema', () => {
  it('accepts the one boolean the sharing-policy routes render', () => {
    expect(SharingPolicySchema.safeParse({ publicSharing: true }).success).toBe(true);
    expect(SharingPolicySchema.safeParse({ publicSharing: false }).success).toBe(true);
  });

  it('rejects a non-boolean, a missing field, and an unknown key', () => {
    expect(SharingPolicySchema.safeParse({ publicSharing: 'true' }).success).toBe(false);
    expect(SharingPolicySchema.safeParse({ publicSharing: null }).success).toBe(false);
    expect(SharingPolicySchema.safeParse({}).success).toBe(false);
    expect(
      SharingPolicySchema.safeParse({ publicSharing: true, runnableLinks: false }).success,
    ).toBe(false);
    expect(SharingPolicySchema.safeParse({ publicSharingEnabled: true }).success).toBe(false);
  });
});

describe('WorkspaceSwitchRequestSchema', () => {
  it('accepts an id or a slug and rejects everything else', () => {
    expect(WorkspaceSwitchRequestSchema.safeParse({ workspace: 'acme' }).success).toBe(true);
    expect(WorkspaceSwitchRequestSchema.safeParse({ workspace: '' }).success).toBe(false);
    expect(WorkspaceSwitchRequestSchema.safeParse({}).success).toBe(false);
    expect(WorkspaceSwitchRequestSchema.safeParse({ workspace: 'acme', extra: true }).success).toBe(
      false,
    );
  });
});

describe('WorkspaceSwitchResponseSchema', () => {
  const workspace = {
    id: 'ws_1',
    slug: 'acme',
    name: 'Acme',
    publicSharingEnabled: false,
    archivedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    role: 'owner',
  };

  it('accepts the membership view and rejects an unknown key or a missing field', () => {
    expect(WorkspaceSwitchResponseSchema.safeParse({ workspace }).success).toBe(true);
    const { role, ...withoutRole } = workspace;
    void role;
    expect(WorkspaceSwitchResponseSchema.safeParse({ workspace: withoutRole }).success).toBe(false);
    expect(WorkspaceSwitchResponseSchema.safeParse({ workspace, extra: 1 }).success).toBe(false);
  });
});
