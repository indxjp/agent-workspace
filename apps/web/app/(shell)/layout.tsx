/**
 * The application shell — spec §43 (calm, sparse, obvious) and §44 (the navigation and its order).
 *
 * `(shell)` is a route group, so it adds no path segment: every authenticated screen of the
 * control plane is a page inside this group and inherits the sidebar and the top bar from here.
 * The group holds no page of its own on this branch — the home chat screen at `/` is W1-UI-02's
 * file (`(shell)/page.tsx`, spec §19.5, §45) and this task must not write it.
 *
 * ## What the shell reads, and what it refuses to invent
 *
 * `getSession()` never throws and returns `null` for an absent or invalid session, so reading it
 * here does not gate the page surface — which matters, because no Wave 1 task owns a sign-in
 * page and gating the shell would send an unauthenticated browser to a route that does not exist
 * (see `apps/web/middleware.ts` and docs/adr/W1-CP-06-the-gate-covers-api-only.md).
 *
 * Where the session answers, the shell shows what it says. Where it does not, the shell says
 * less rather than inventing: no identity chip instead of a placeholder person, and a runtime
 * chip that reads **not configured** instead of naming a driver nothing has registered. The
 * mockup's "Docker · Standard Sandbox" is demo data, and A.3's requirement is that the bar names
 * the driver *in force* — when none is, the honest chip is the one that says so.
 *
 * ## Issue #120: a removed or archived current workspace offers a route back to selection
 *
 * A session token stays cryptographically valid — `getSession()` only checks its signature and
 * expiry — long after the membership it names has been deleted, or the workspace itself archived
 * out from under it. `resolveIdentity` (`server/features/console.ts`) already re-reads the
 * directory on every request rather than trusting the token, so it already notices; the only piece
 * this task adds is acting on a `null` it returns for the right reason. `shouldRecoverSession`
 * (`components/shell/session-recovery.ts`) is that positive check (ADR-0015): it tells "the
 * caller's own membership is genuinely gone" apart from "the RBAC runtime is not wired at all"
 * (`server/rbac/runtime.ts`'s own declared gap, a different task's), so this redirect fires for the
 * first and never loops on the second.
 */
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

import { initialsFrom, roleLabel } from '../../components/shell/identity';
import {
  SESSION_RECOVERY_PATH,
  shouldRecoverSession,
} from '../../components/shell/session-recovery';
import { Sidebar, type SidebarUser, type WorkspaceBrand } from '../../components/shell/sidebar';
import { Topbar, type RuntimeChip } from '../../components/shell/topbar';
import {
  DeploymentDriverBanner,
  LOCAL_ISOLATION_REASON,
} from '../../components/shell/driver-banner';
import { getSession } from '../../server/auth';
import { applicationContext } from '../../server/application-context';
import { currentWorkspaceFeatures, resolveIdentity } from '../../server/features/console';

import { roleManagesStorage } from './admin/storage/manages-storage';

export const dynamic = 'force-dynamic';

/** Shown as the brand line when the request carries no session and no workspace is known. */
const UNIDENTIFIED_WORKSPACE: WorkspaceBrand = {
  name: 'Agent Workspace',
  detail: 'Self-hosted',
  slug: null,
};

/**
 * Wave 1 registers no runtime with the control plane — `apps/web/server/runs/environment.ts`
 * refuses to serve a run until an adapter is installed — so there is no driver to name. "Not
 * configured" is the vocabulary the runtimes mockup already uses for exactly this state, and the
 * chip carries the warn variant so it reads as a gap rather than as a healthy default. It links
 * nowhere because the Runtimes screen is not built.
 */
function runtimeChip(): RuntimeChip {
  const driver = process.env['RUNTIME_DRIVER']?.trim();
  if (driver === 'local') {
    return {
      label: driver,
      warn: true,
      href: '/admin/runtimes',
      reason: LOCAL_ISOLATION_REASON,
    };
  }
  return driver
    ? { label: driver, warn: false, href: '/admin/runtimes' }
    : { label: 'not configured', warn: true, href: '/admin/runtimes' };
}

export default async function ShellLayout({ children }: { children: ReactNode }) {
  const session = await getSession();
  const resolved = session === null ? null : await resolveIdentity(session);
  // ADR-0160 D8: the sidebar hides a switched-off feature's entry. No session, no runtime and no
  // switch all answer every feature, so the markup is then the one it always was.
  const features = await currentWorkspaceFeatures(resolved);

  if (
    shouldRecoverSession({
      hasSession: session !== null,
      identityResolved: resolved !== null,
      runtimeConfigured: applicationContext() !== null,
    })
  ) {
    redirect(SESSION_RECOVERY_PATH);
  }

  const workspace: WorkspaceBrand =
    session === null
      ? UNIDENTIFIED_WORKSPACE
      : {
          name: resolved?.workspaceName ?? session.ws,
          detail: UNIDENTIFIED_WORKSPACE.detail,
          slug: session.ws,
        };

  const user: SidebarUser | null =
    session === null
      ? null
      : {
          name: resolved?.userName ?? session.sub,
          role: roleLabel(resolved?.role),
          initials: initialsFrom(resolved?.userName ?? session.sub),
        };

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <Sidebar
        workspace={workspace}
        user={user}
        managers={roleManagesStorage(resolved?.role)}
        features={features}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar runtime={runtimeChip()} />
        <DeploymentDriverBanner />
        {children}
      </div>
    </div>
  );
}
