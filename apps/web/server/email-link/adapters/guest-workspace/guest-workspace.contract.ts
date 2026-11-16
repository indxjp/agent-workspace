import { DEMO_WORKSPACE_LIFETIME_SECONDS } from '@indx-workspace/contracts/email-link';
import { CONFERRABLE_ROLES } from '@indx-workspace/contracts/team';
import { describe, expect, it } from 'vitest';

import type { Role } from '../../../rbac/core/roles';
import type { DirectoryRoot } from '../../../rbac/directory';
import type { GuestBinding, GuestWorkspaceBinder } from '../../ports';

export interface GuestWorkspaceFixture {
  readonly binder: GuestWorkspaceBinder;
  /** Reads the rows the binder wrote, through the same directory the application reads. */
  readonly directory: Pick<DirectoryRoot, 'membershipsForUser' | 'findUserByEmail'>;
  /** Makes `email` a user holding a real membership of `role` in a workspace of its own. */
  seedMember(email: string, role: Role): Promise<void>;
  /** The workspace's `demo_expires_at`: `null` for a workspace that is not a demo. */
  demoExpiresAt(workspaceId: string): Promise<Date | null>;
  /** An address no other test uses: `users.email` is global and a database outlives one test. */
  email(local: string): string;
}

const T0 = new Date('2026-11-16T09:00:00.000Z');
const after = (base: Date, seconds: number): Date => new Date(base.getTime() + seconds * 1000);

/** A binding the test expects to be made; a refusal here is a test failure. */
async function bind(
  fixture: GuestWorkspaceFixture,
  input: { readonly email: string; readonly now: Date },
): Promise<GuestBinding> {
  const binding = await fixture.binder.bind(input);
  if (binding === null) throw new Error(`no binding for ${input.email}`);
  return binding;
}

/** The two adapters of `GuestWorkspaceBinder` make the same demo workspaces for the same inputs. */
export function describeGuestWorkspaceConformance(
  label: string,
  make: () => Promise<GuestWorkspaceFixture>,
): void {
  describe(`GuestWorkspaceBinder: ${label}`, () => {
    async function roles(fixture: GuestWorkspaceFixture, email: string) {
      const user = await fixture.directory.findUserByEmail(email);
      if (user === null) throw new Error(`no user for ${email}`);
      return fixture.directory.membershipsForUser(user.id);
    }

    it('creates the user and a demo workspace with one guest membership for a new address', async () => {
      const fixture = await make();
      const email = fixture.email('new');
      const binding = await bind(fixture, { email, now: T0 });
      expect(binding.created).toBe(true);
      expect(binding.workspaceSlug).toMatch(/^demo-[0-9a-f]{12}$/u);
      const user = await fixture.directory.findUserByEmail(email);
      expect(user).toMatchObject({ id: binding.userId, email });
      expect(user?.name).toBe(email.split('@')[0]);
      const held = await roles(fixture, email);
      expect(held).toHaveLength(1);
      expect(held[0]).toMatchObject({
        workspaceId: binding.workspaceId,
        workspaceSlug: binding.workspaceSlug,
        role: 'guest',
      });
    });

    it('finds the user by lower-cased address, whatever the case of the address given', async () => {
      const fixture = await make();
      const email = fixture.email('case');
      const first = await bind(fixture, { email: email.toUpperCase(), now: T0 });
      const second = await bind(fixture, { email, now: after(T0, 60) });
      expect(second.userId).toBe(first.userId);
      expect(second.workspaceId).toBe(first.workspaceId);
    });

    it.each(CONFERRABLE_ROLES)(
      'binds nothing for an address that holds a real %s membership, and changes none',
      async (role) => {
        const fixture = await make();
        const email = fixture.email(`real-${role}`);
        await fixture.seedMember(email, role);
        const before = await roles(fixture, email);
        expect(before.map((m) => m.role)).toEqual([role]);
        expect(await fixture.binder.bind({ email, now: T0 })).toBeNull();
        expect(await fixture.binder.bind({ email, now: after(T0, 5) })).toBeNull();
        expect(await roles(fixture, email)).toEqual(before);
      },
    );

    it('returns the same workspace, created:false, within the demo lifetime', async () => {
      const fixture = await make();
      const email = fixture.email('again');
      const first = await bind(fixture, { email, now: T0 });
      const second = await bind(fixture, {
        email,
        now: after(T0, DEMO_WORKSPACE_LIFETIME_SECONDS - 1),
      });
      expect(second).toEqual({ ...first, created: false });
      expect(await roles(fixture, email)).toHaveLength(1);
    });

    it('marks a new demo workspace to end DEMO_WORKSPACE_LIFETIME_SECONDS after it was made', async () => {
      const fixture = await make();
      const binding = await bind(fixture, { email: fixture.email('ends'), now: T0 });
      expect(await fixture.demoExpiresAt(binding.workspaceId)).toEqual(
        after(T0, DEMO_WORKSPACE_LIFETIME_SECONDS),
      );
    });

    it('never moves the end of a demo workspace the guest returns to', async () => {
      const fixture = await make();
      const email = fixture.email('fixed');
      const first = await bind(fixture, { email, now: T0 });
      const later = after(T0, DEMO_WORKSPACE_LIFETIME_SECONDS - 60);
      const second = await bind(fixture, { email, now: later });
      expect(second.workspaceId).toBe(first.workspaceId);
      expect(await fixture.demoExpiresAt(first.workspaceId)).toEqual(
        after(T0, DEMO_WORKSPACE_LIFETIME_SECONDS),
      );
    });

    it('does not return the workspace at the moment it ends', async () => {
      const fixture = await make();
      const email = fixture.email('edge');
      const first = await bind(fixture, { email, now: T0 });
      const second = await bind(fixture, {
        email,
        now: after(T0, DEMO_WORKSPACE_LIFETIME_SECONDS),
      });
      expect(second.created).toBe(true);
      expect(second.workspaceId).not.toBe(first.workspaceId);
    });

    it('makes a new workspace once the demo lifetime has passed', async () => {
      const fixture = await make();
      const email = fixture.email('later');
      const first = await bind(fixture, { email, now: T0 });
      const second = await bind(fixture, {
        email,
        now: after(T0, DEMO_WORKSPACE_LIFETIME_SECONDS + 1),
      });
      expect(second.created).toBe(true);
      expect(second.workspaceId).not.toBe(first.workspaceId);
      expect(second.userId).toBe(first.userId);
      const held = await roles(fixture, email);
      expect(held.map((m) => m.role)).toEqual(['guest', 'guest']);
    });

    it('never writes a role but guest, for a new and a returning address', async () => {
      const fixture = await make();
      const fresh = fixture.email('fresh');
      await bind(fixture, { email: fresh, now: T0 });
      await bind(fixture, { email: fresh, now: after(T0, 5) });
      await bind(fixture, { email: fresh, now: after(T0, DEMO_WORKSPACE_LIFETIME_SECONDS + 5) });
      expect((await roles(fixture, fresh)).map((m) => m.role)).toEqual(['guest', 'guest']);
    });

    it('makes one workspace when two links for one address are opened at once', async () => {
      const fixture = await make();
      const email = fixture.email('race');
      const [a, b] = await Promise.all([
        bind(fixture, { email, now: T0 }),
        bind(fixture, { email, now: T0 }),
      ]);
      expect(a.workspaceId).toBe(b.workspaceId);
      expect([a.created, b.created].sort()).toEqual([false, true]);
      expect(await roles(fixture, email)).toHaveLength(1);
    });
  });
}
