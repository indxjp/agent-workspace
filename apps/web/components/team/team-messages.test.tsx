import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { japaneseRole } from '../shell/shell-messages';

import { InvitationForm } from './invitation-form';
import { InvitationReveal } from './invitation-reveal';
import type { InvitationCapability, InvitationResource } from './invitations-model';
import { describeInvitationFailure, describeInvitationTiming } from './invitations-model';
import { InvitationsTable } from './invitations-table';
import { MembersTable } from './members-table';
import {
  describeMembershipFailure,
  describeRole,
  summariseRemovalImpact,
  type MembershipCapability,
  type MembershipResource,
} from './model';
import { RemoveMemberDialog } from './remove-dialog';
import { teamStrings, type TeamStrings } from './team-messages';
import { TeamScreen } from './team-screen';

// UX-15 in #2086: the Users screen in the reader's language.

/** Every word a `TeamStrings` holds, keyed by its path; functions are called with samples. */
function flatten(strings: TeamStrings): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(strings)) {
    if (key === 'dateLocale') continue;
    if (typeof value === 'string') out.set(key, value);
    else if (typeof value === 'function')
      out.set(key, (value as (...args: unknown[]) => string)(3, 2));
    else
      for (const [inner, word] of Object.entries(value as Record<string, string>))
        out.set(`${key}.${inner}`, word);
  }
  return out;
}

const en = teamStrings('en');
const ja = teamStrings('ja');

describe('teamStrings', () => {
  it('has a Japanese word for every English one', () => {
    const english = flatten(en);
    const japanese = flatten(ja);
    expect([...japanese.keys()].sort()).toEqual([...english.keys()].sort());
    for (const [key, word] of english) {
      expect(japanese.get(key), key).not.toBe('');
      expect(japanese.get(key), key).not.toBe(word);
    }
  });

  it('names roles as the sidebar does', () => {
    for (const role of ['owner', 'admin', 'builder', 'viewer'] as const) {
      expect(describeRole(role, ja)).toBe(japaneseRole(role));
    }
    expect(describeRole('admin')).toBe('Admin');
  });

  it('keeps English exactly as the model printed it', () => {
    expect(summariseRemovalImpact({ sessions: 1, projects: 2 })).toBe(
      '1 session and 2 projects stay in this workspace and keep naming this member. Removing them ends their access; no history is deleted. A member who still owns a session or project cannot be removed until those resources are deleted or reassigned, so this removal may be refused.',
    );
    expect(
      describeMembershipFailure({ kind: 'transport', reason: 'Request failed.' } as never, {
        status: 500,
        impact: { sessions: 2, projects: 0 },
      }),
    ).toBe(
      'Request failed. This member still owns 2 sessions in this workspace, and a workspace may not hold a session owned by someone who is not a member. Delete or reassign those sessions first, or leave the membership in place.',
    );
    expect(
      describeInvitationFailure({
        kind: 'api',
        code: 'no_such_invitation',
        message: 'Gone.',
      } as never),
    ).toBe('Gone. The list on this screen is out of date; reload it.');
  });

  it("words the model's sentences for a Japanese reader, keeping the server's own", () => {
    expect(summariseRemovalImpact({ sessions: 0, projects: 0 }, ja)).toContain(
      '所有するセッションとプロジェクトはありません',
    );
    expect(summariseRemovalImpact({ sessions: 4, projects: 1 }, ja)).toContain(
      'セッション 4 件とプロジェクト 1 件',
    );
    expect(
      describeMembershipFailure(
        { kind: 'transport', reason: 'Request failed.' } as never,
        { status: 500, impact: { sessions: 2, projects: 0 } },
        ja,
      ),
    ).toMatch(/^Request failed\. このメンバーはこのワークスペースでまだセッションを 2 件/u);
    expect(
      describeInvitationFailure(
        { kind: 'api', code: 'no_such_invitation', message: 'Gone.' } as never,
        ja,
      ),
    ).toBe('Gone. この画面の一覧は古くなっています。再読み込みしてください。');
    expect(describeInvitationTiming(PENDING, 'pending', ja)).toBe(
      '2026年9月21日 に期限切れになります',
    );
  });
});

const OWNER: MembershipResource = {
  id: 'membership-1',
  principalId: '11111111-1111-4111-8111-111111111111',
  userId: 'user-1',
  email: 'aya.ito@example.test',
  name: 'Aya Ito',
  role: 'owner',
  createdAt: '2026-09-12T00:00:00.000Z',
};

const ADMIN: MembershipResource = {
  ...OWNER,
  id: 'membership-2',
  principalId: '22222222-2222-4222-8222-222222222222',
  userId: 'user-2',
  email: 'kenji.sato@example.test',
  name: 'Kenji Sato',
  role: 'admin',
};

const CAPABILITY: MembershipCapability = {
  canListMembers: true,
  canChangeRole: true,
  canRemoveMember: true,
  conferrableRoles: ['owner', 'admin', 'builder', 'viewer'],
  viewerUserId: 'user-1',
};

const INVITATION_CAPABILITY: InvitationCapability = {
  canListInvitations: true,
  canCreateInvitation: true,
  canResendInvitation: true,
  canRevokeInvitation: true,
  invitableRoles: ['owner', 'admin', 'builder', 'viewer'],
};

const NOW = Date.parse('2026-09-14T12:00:00.000Z');

const PENDING: InvitationResource = {
  id: 'invitation-1',
  email: 'new.person@example.test',
  role: 'builder',
  invitedBy: 'user-1',
  expiresAt: '2026-09-21T12:00:00.000Z',
  acceptedAt: null,
  revokedAt: null,
  createdAt: '2026-09-14T11:00:00.000Z',
};

/** Every English word these screens print; a Japanese screen shows none as a text node or label. */
const ENGLISH = [...flatten(en).values()].map((word) => word.trim()).filter((word) => word !== '');

function expectJapanese(html: string, ...expected: string[]): void {
  for (const text of expected) expect(html).toContain(text);
  for (const english of ENGLISH) {
    expect(html, english).not.toContain(`>${english}<`);
    expect(html, english).not.toContain(`aria-label="${english}"`);
  }
}

const noop = (): void => {};

describe('the Users screen for a Japanese reader', () => {
  it('the screen itself, while it loads', () => {
    const html = renderToStaticMarkup(
      <TeamScreen
        capability={CAPABILITY}
        invitationCapability={INVITATION_CAPABILITY}
        locale="ja"
      />,
    );
    expect(html).toContain('lang="ja"');
    expectJapanese(html, '>ユーザー</h1>', 'メンバーを読み込み中…', '>招待</h2>', '招待を送る');
  });

  it('the members table: headings, roles, You, the last-Owner note and named controls', () => {
    const html = renderToStaticMarkup(
      <MembersTable
        state={{ kind: 'ready', members: [OWNER, ADMIN] }}
        capability={CAPABILITY}
        busyMembershipId={null}
        roleProblem={null}
        onChangeRole={noop}
        onRemove={noop}
        strings={ja}
      />,
    );
    expectJapanese(
      html,
      '>メンバー</th>',
      '>参加日</th>',
      '>あなた<',
      '最後のオーナーです。',
      'aria-label="Kenji Sato のロール"',
      'aria-label="Kenji Sato を削除"',
      '>管理者</option>',
      '2026年9月12日',
    );
    for (const kind of ['loading', 'refused'] as const) {
      expectJapanese(
        renderToStaticMarkup(
          <MembersTable
            state={{ kind }}
            capability={CAPABILITY}
            busyMembershipId={null}
            roleProblem={null}
            onChangeRole={noop}
            onRemove={noop}
            strings={ja}
          />,
        ),
      );
    }
  });

  it('the removal confirmation in each of its states', () => {
    const states = [
      { kind: 'counting' },
      { kind: 'counted', impact: { sessions: 0, projects: 0 } },
      { kind: 'impact-unavailable' },
      { kind: 'submitting' },
    ] as const;
    for (const state of states) {
      expectJapanese(
        renderToStaticMarkup(
          <RemoveMemberDialog
            member={ADMIN}
            state={state}
            onCancel={noop}
            onConfirm={noop}
            strings={ja}
          />,
        ),
        'Kenji Sato をこのワークスペースから削除しますか？',
      );
    }
  });

  it('the invitation form, the one-time reveal and the invitations table', () => {
    expectJapanese(
      renderToStaticMarkup(
        <InvitationForm
          capability={INVITATION_CAPABILITY}
          draft={{ email: '', role: null }}
          sending={false}
          problem={null}
          onChange={noop}
          onSubmit={noop}
          strings={ja}
        />,
      ),
      'このワークスペースに招待する',
      'メールアドレス',
      'ロールを選択',
      '>オーナー</option>',
    );
    const reveal = renderToStaticMarkup(
      <InvitationReveal
        revealed={{
          email: 'new.person@example.test',
          link: 'https://aw.example.test/accept-invitation?id=1&token=t',
          warning: 'This is the only time this token is shown.',
        }}
        copyState="copied"
        onCopy={noop}
        onDismiss={noop}
        strings={ja}
      />,
    );
    expectJapanese(reveal, 'new.person@example.test への招待リンク', 'リンクをコピーしました。');
    // The server's own sentence stays as the server worded it, marked as English.
    expect(reveal).toContain('lang="en"');
    const rows = [
      PENDING,
      { ...PENDING, id: 'i-2', email: 'a@example.test', acceptedAt: '2026-09-13T09:00:00.000Z' },
      { ...PENDING, id: 'i-3', email: 'r@example.test', revokedAt: '2026-09-13T10:00:00.000Z' },
      { ...PENDING, id: 'i-4', email: 'e@example.test', expiresAt: '2026-09-07T12:00:00.000Z' },
    ];
    expectJapanese(
      renderToStaticMarkup(
        <InvitationsTable
          state={{ kind: 'ready', invitations: rows, nowMs: NOW }}
          capability={INVITATION_CAPABILITY}
          busyInvitationId={null}
          actionProblem={null}
          onResend={noop}
          onRevoke={noop}
          strings={ja}
        />,
      ),
      '>招待した人</th>',
      '>保留中<',
      '>承諾済み<',
      '>取り消し済み<',
      '>期限切れ<',
      'aria-label="new.person@example.test への招待を再送"',
      '承諾済みです。',
    );
  });

  it('English readers see what they saw before', () => {
    const html = renderToStaticMarkup(
      <TeamScreen capability={CAPABILITY} invitationCapability={INVITATION_CAPABILITY} />,
    );
    expect(html).toContain('lang="en"');
    expect(html).toContain('>Users</h1>');
    expect(html).toContain('Send invitation');
  });
});
