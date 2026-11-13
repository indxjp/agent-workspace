/**
 * The sidebar: workspace mark (issue #120: now a switcher when a session names one), the §44
 * navigation, and the signed-in identity at the foot.
 *
 * Transcribed from `.sidebar`, `.brand`, `.sidebar-foot`, `.userchip` and `.avatar` in
 * `ui/assets/app.css`.
 *
 * The mockup fills the brand and the identity from a demo constant in `ui/assets/app.js` — a
 * fictional workspace and a fictional person, labelled there as "workspace demo context". Those
 * two strings are data, not design, so they are supplied by the layout from the session instead
 * of being transcribed; shipping "Meridian Manufacturing" as a product string would be a lie in
 * exactly the register §43 is written against.
 *
 * `workspace.slug` is what turns the static brand row into `WorkspaceSwitcher`: `null` for the
 * unidentified-session brand (`(shell)/layout.tsx`'s `UNIDENTIFIED_WORKSPACE`) — there is no
 * membership list to switch among when there is no session at all — and the session's own
 * workspace slug otherwise, so the switcher can tell which of `GET /api/workspaces`' rows is the
 * one already open.
 */
import { FEATURE_IDS, type FeatureId } from '@indx-workspace/contracts/features';

import { SidebarMenu } from './sidebar-menu';
import { SidebarNav, type RecentChat } from './sidebar-nav';
import { shellStrings, type ShellLocale } from './shell-messages';
import { WorkspaceSwitcher } from './workspace-switcher';

export interface WorkspaceBrand {
  /** The workspace's name, as the brand line. */
  readonly name: string;
  /** The line beneath it. The mockup carries the deployment mode there. */
  readonly detail: string;
  /** The session's workspace slug, or `null` when there is no session to switch from. */
  readonly slug: string | null;
}

export interface SidebarUser {
  readonly name: string;
  readonly role: string;
  readonly initials: string;
}

export function Sidebar({
  workspace,
  user,
  managers,
  features = FEATURE_IDS,
  locale = 'en',
  signOut,
  recentChats = [],
}: {
  readonly workspace: WorkspaceBrand;
  /** `null` when the request carries no session — the foot is then omitted, not faked. */
  readonly user: SidebarUser | null;
  /** Whether the caller is an Owner or Admin, who also see the entries meant for managers. */
  readonly managers: boolean;
  /** The features switched on; omitted means all of them, so the navigation is unchanged. */
  readonly features?: readonly FeatureId[];
  /** The reader's language (UX-15); English unless it is `ja`. */
  readonly locale?: ShellLocale;
  /** The sign-out server action; the foot shows "Sign out" when it is given and there is a user. */
  readonly signOut?: () => Promise<void>;
  /** The signed-in person's recent chats, listed under New chat (spec §44). */
  readonly recentChats?: readonly RecentChat[];
}) {
  return (
    <aside
      lang={locale}
      className="flex w-full flex-none flex-col border-border bg-surface-2 md:sticky md:top-0 md:h-screen md:w-(--sidebar-w) md:border-r"
    >
      <SidebarMenu
        menuLabel={shellStrings(locale).menu}
        brand={
          workspace.slug === null ? (
            <div className="flex items-center gap-2.5 border-b border-border px-4 pt-4 pb-3.5">
              <div className="grid size-[26px] flex-none place-items-center rounded-[7px] bg-text text-[13px] font-bold text-surface">
                {workspace.name.slice(0, 1).toUpperCase()}
              </div>
              <div className="min-w-0">
                <b className="block text-[13px] font-semibold">{workspace.name}</b>
                <span className="block text-[11.5px] text-muted">{workspace.detail}</span>
              </div>
            </div>
          ) : (
            <WorkspaceSwitcher
              currentSlug={workspace.slug}
              currentName={workspace.name}
              currentDetail={workspace.detail}
            />
          )
        }
      >
        <SidebarNav managers={managers} features={features} locale={locale} recent={recentChats} />

        {user === null ? null : (
          <div className="border-t border-border p-2.5">
            <div className="flex items-center gap-[9px] rounded-(--radius-sm) px-2 py-1.5">
              <div className="grid size-[26px] flex-none place-items-center rounded-[50%] bg-accent-soft text-[11px] font-bold text-accent">
                {user.initials}
              </div>
              <div className="min-w-0 leading-[1.3]">
                <b className="block text-[12.5px] font-semibold">{user.name}</b>
                <span className="block text-[11px] text-muted">{user.role}</span>
              </div>
            </div>
            {signOut === undefined ? null : (
              <form action={signOut}>
                <button
                  type="submit"
                  className="mt-1 w-full cursor-pointer rounded-(--radius-sm) border-0 bg-transparent px-2 py-1.5 text-left text-[12.5px] text-text-2 hover:bg-surface-3 hover:text-text focus-visible:outline-2 focus-visible:outline-accent"
                >
                  {shellStrings(locale).signOut}
                </button>
              </form>
            )}
          </div>
        )}
      </SidebarMenu>
    </aside>
  );
}
