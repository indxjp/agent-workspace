/**
 * The Users screen's own words in the reader's language (UX-15 in #2086): the members table, the
 * removal confirmation and the invitations section, plus the sentences `model.ts` and
 * `invitations-model.ts` build for them, in the shape of `../resources/admin-messages.ts`.
 *
 * English is the text this screen printed before, unchanged. What the server sends — a member's
 * name and address, an invitee's address, a refusal's own sentence, the one-time link and the
 * server's warning beside it — is shown as it comes. Role names come from
 * `../shell/shell-messages.ts`, so they read as the sidebar's do.
 */
import type { MembershipRoleName } from '../../contracts/team';
import type { VersionsLocale } from '../agents/versions-messages';

/** The sentences the two model files build: they reach the screen through these words. */
export interface TeamModelWords {
  readonly roleLabel: Readonly<Record<MembershipRoleName, string>>;
  /** The `Intl` locale a date is printed in; `undefined` is the browser's own. */
  readonly dateLocale: string | undefined;
  readonly lastOwnerCanPromote: string;
  readonly lastOwnerAskOwner: string;
  readonly ownsNothing: string;
  readonly ownsSome: (sessions: number, projects: number) => string;
  readonly stillOwnsSessions: (reason: string, sessions: number) => string;
  readonly invitationState: Readonly<
    Record<'pending' | 'expired' | 'accepted' | 'revoked', string>
  >;
  readonly revokedOn: (date: string) => string;
  readonly acceptedOn: (date: string) => string;
  readonly expiredOn: (date: string) => string;
  readonly expiresOn: (date: string) => string;
  readonly settledAccepted: string;
  readonly settledRevoked: string;
  readonly copied: string;
  readonly copyUnavailable: string;
  readonly listOutOfDate: (message: string) => string;
}

export interface TeamStrings extends TeamModelWords {
  readonly title: string;
  readonly intro: string;
  readonly loadingMembers: string;
  readonly membersRefused: string;
  readonly noMembers: string;
  readonly membersCaption: string;
  readonly member: string;
  readonly role: string;
  readonly joined: string;
  readonly actions: string;
  readonly you: string;
  readonly roleFor: (name: string) => string;
  readonly removeLabel: (name: string) => string;
  readonly remove: string;

  readonly removeTitle: (name: string) => string;
  readonly removeConfirmLabel: (name: string) => string;
  readonly cancel: string;
  readonly removing: string;
  readonly removeMember: string;
  readonly counting: string;
  readonly impactUnavailable: string;
  readonly removalNote: string;

  readonly invitations: string;
  readonly invitationsIntro: string;
  /**
   * A create succeeded but its body could not be read. It quotes no part of the response: a body
   * this screen failed to parse still has a token in it, and an error built from a fragment of it
   * is the leak #186 forbids. The invitation exists, so the remedy is to revoke and start again.
   */
  readonly unreadableIssued: string;
  /**
   * The same failure on the resend path, which needs the opposite remedy: a resend created nothing
   * and rotated the token, so revoking would destroy a live invitation where resending costs
   * nothing.
   */
  readonly unreadableResent: string;
  readonly inviteHeading: string;
  readonly inviteNote: string;
  readonly email: string;
  readonly chooseRole: string;
  readonly sending: string;
  readonly sendInvitation: string;
  readonly linkFor: (email: string) => string;
  readonly relayNote: string;
  readonly copyLabel: (email: string) => string;
  readonly copyLink: string;
  readonly dismissLabel: (email: string) => string;
  readonly dismiss: string;
  readonly loadingInvitations: string;
  readonly invitationsRefused: string;
  readonly noInvitations: string;
  readonly invitationsCaption: string;
  readonly invitee: string;
  readonly status: string;
  readonly resendLabel: (email: string) => string;
  readonly resend: string;
  readonly revokeLabel: (email: string) => string;
  readonly revoke: string;
}

function countPhrase(count: number, singular: string, plural: string): string {
  return count === 1 ? `1 ${singular}` : `${String(count)} ${plural}`;
}

const EN: TeamStrings = {
  roleLabel: { owner: 'Owner', admin: 'Admin', builder: 'Builder', viewer: 'Viewer' },
  dateLocale: undefined,
  lastOwnerCanPromote:
    'Last Owner. Promote another member to Owner before changing or removing this one.',
  lastOwnerAskOwner:
    'Last Owner. Only an Owner can promote another member to Owner, so ask one before this member can be changed or removed.',
  ownsNothing:
    'This member owns no sessions and no projects in this workspace. Removing them ends their access here; nothing already run is deleted.',
  ownsSome: (sessions, projects) =>
    `${countPhrase(sessions, 'session', 'sessions')} and ${countPhrase(projects, 'project', 'projects')} stay in this workspace and keep naming this member. Removing them ends their access; no history is deleted. A member who still owns a session or project cannot be removed until those resources are deleted or reassigned, so this removal may be refused.`,
  stillOwnsSessions: (reason, sessions) =>
    `${reason} This member still owns ${countPhrase(sessions, 'session', 'sessions')} ` +
    `in this workspace, and a workspace may not hold a session owned by someone who is not a ` +
    `member. Delete or reassign those sessions first, or leave the membership in place.`,
  invitationState: {
    pending: 'Pending',
    expired: 'Expired',
    accepted: 'Accepted',
    revoked: 'Revoked',
  },
  revokedOn: (date) => `Revoked ${date}`,
  acceptedOn: (date) => `Accepted ${date}`,
  expiredOn: (date) => `Expired ${date}`,
  expiresOn: (date) => `Expires ${date}`,
  settledAccepted: 'Accepted. Manage this person in the members table above.',
  settledRevoked: 'Revoked. Send a new invitation if they still need access.',
  copied: 'Link copied. Send it to the person you invited; it is not shown again.',
  copyUnavailable:
    'This browser would not give the page the clipboard. Select the link above and copy it before leaving this screen.',
  listOutOfDate: (message) => `${message} The list on this screen is out of date; reload it.`,

  title: 'Users',
  intro:
    'Active members of this workspace, their roles, who may change them, and who has been invited.',
  loadingMembers: 'Loading members…',
  membersRefused:
    'Managing members is not part of your role in this workspace, so its member list is not shown here. Ask an Owner or an Admin if you need a change made.',
  noMembers: 'This workspace has no members yet. Members join by accepting an invitation.',
  membersCaption: 'Active members of this workspace and the role each one holds.',
  member: 'Member',
  role: 'Role',
  joined: 'Joined',
  actions: 'Actions',
  you: 'You',
  roleFor: (name) => `Role for ${name}`,
  removeLabel: (name) => `Remove ${name}`,
  remove: 'Remove',

  removeTitle: (name) => `Remove ${name} from this workspace?`,
  removeConfirmLabel: (name) => `Remove ${name} from this workspace`,
  cancel: 'Cancel',
  removing: 'Removing…',
  removeMember: 'Remove member',
  counting: 'Counting the sessions and projects this member owns…',
  impactUnavailable:
    'What this member owns could not be counted, so this summary is incomplete. Removing a member ends their access here and deletes no history.',
  removalNote:
    'Removing a member ends their access to this workspace. Completed sessions and the projects they created stay where they are.',

  invitations: 'Invitations',
  invitationsIntro: 'People invited to this workspace, and what became of each invitation.',
  unreadableIssued:
    'The invitation was created, but the response carrying its link could not be read, so the link is gone. Revoke the invitation below and send a new one.',
  unreadableResent:
    'The invitation was resent, but the response carrying its new link could not be read, so the link is gone. Resend it again to get a fresh one.',
  inviteHeading: 'Invite someone to this workspace',
  inviteNote: 'They receive no email. The link appears once, here, for you to relay.',
  email: 'Email',
  chooseRole: 'Choose a role',
  sending: 'Sending…',
  sendInvitation: 'Send invitation',
  linkFor: (email) => `Invitation link for ${email}`,
  relayNote:
    'This deployment sends no email, so relay this link yourself. It is not stored anywhere and leaving this screen loses it.',
  copyLabel: (email) => `Copy the invitation link for ${email}`,
  copyLink: 'Copy link',
  dismissLabel: (email) => `Dismiss the invitation link for ${email}`,
  dismiss: 'Dismiss',
  loadingInvitations: 'Loading invitations…',
  invitationsRefused:
    'Inviting people is not part of your role in this workspace, so its invitations are not shown here. Ask an Owner or an Admin if someone needs access.',
  noInvitations: 'No invitations have been sent from this workspace.',
  invitationsCaption: 'Invitations this workspace has sent, and what became of each one.',
  invitee: 'Invitee',
  status: 'Status',
  resendLabel: (email) => `Resend the invitation for ${email}`,
  resend: 'Resend',
  revokeLabel: (email) => `Revoke the invitation for ${email}`,
  revoke: 'Revoke',
};

const JA: TeamStrings = {
  roleLabel: { owner: 'オーナー', admin: '管理者', builder: 'ビルダー', viewer: '閲覧者' },
  dateLocale: 'ja-JP',
  lastOwnerCanPromote:
    '最後のオーナーです。このメンバーを変更・削除する前に、別のメンバーをオーナーにしてください。',
  lastOwnerAskOwner:
    '最後のオーナーです。別のメンバーをオーナーにできるのはオーナーだけです。このメンバーを変更・削除するには、オーナーに依頼してください。',
  ownsNothing:
    'このメンバーがこのワークスペースで所有するセッションとプロジェクトはありません。削除するとここへのアクセスがなくなります。実行済みのものは削除されません。',
  ownsSome: (sessions, projects) =>
    `セッション ${String(sessions)} 件とプロジェクト ${String(projects)} 件はこのワークスペースに残り、このメンバーを所有者として示し続けます。削除するとアクセスがなくなりますが、履歴は削除されません。セッションやプロジェクトを所有しているメンバーは、それらを削除するか引き継ぐまで削除できないため、この削除は拒否される場合があります。`,
  stillOwnsSessions: (reason, sessions) =>
    `${reason} このメンバーはこのワークスペースでまだセッションを ${String(sessions)} 件所有しています。メンバーでない人が所有するセッションはワークスペースに置けません。先にそれらのセッションを削除するか引き継ぐか、メンバーシップをそのままにしてください。`,
  invitationState: {
    pending: '保留中',
    expired: '期限切れ',
    accepted: '承諾済み',
    revoked: '取り消し済み',
  },
  revokedOn: (date) => `${date} に取り消し`,
  acceptedOn: (date) => `${date} に承諾`,
  expiredOn: (date) => `${date} に期限切れ`,
  expiresOn: (date) => `${date} に期限切れになります`,
  settledAccepted: '承諾済みです。このユーザーは上のメンバー一覧で管理してください。',
  settledRevoked: '取り消し済みです。まだアクセスが必要なら、新しい招待を送ってください。',
  copied: 'リンクをコピーしました。招待した人に送ってください。二度と表示されません。',
  copyUnavailable:
    'このブラウザではクリップボードを使えませんでした。この画面を離れる前に、上のリンクを選択してコピーしてください。',
  listOutOfDate: (message) =>
    `${message} この画面の一覧は古くなっています。再読み込みしてください。`,

  title: 'ユーザー',
  intro: 'このワークスペースのメンバーとそのロール、ロールを変更できる人、招待した人です。',
  loadingMembers: 'メンバーを読み込み中…',
  membersRefused:
    'メンバーの管理はこのワークスペースでのあなたのロールに含まれないため、メンバー一覧は表示されません。変更が必要な場合は、オーナーか管理者に依頼してください。',
  noMembers: 'このワークスペースにはまだメンバーがいません。メンバーは招待を承諾すると参加します。',
  membersCaption: 'このワークスペースのメンバーと、それぞれのロールです。',
  member: 'メンバー',
  role: 'ロール',
  joined: '参加日',
  actions: '操作',
  you: 'あなた',
  roleFor: (name) => `${name} のロール`,
  removeLabel: (name) => `${name} を削除`,
  remove: '削除',

  removeTitle: (name) => `${name} をこのワークスペースから削除しますか？`,
  removeConfirmLabel: (name) => `${name} をこのワークスペースから削除`,
  cancel: 'キャンセル',
  removing: '削除中…',
  removeMember: 'メンバーを削除',
  counting: 'このメンバーが所有するセッションとプロジェクトを数えています…',
  impactUnavailable:
    'このメンバーが所有するものを数えられなかったため、この概要は不完全です。メンバーを削除するとここへのアクセスがなくなりますが、履歴は削除されません。',
  removalNote:
    'メンバーを削除すると、このワークスペースへのアクセスがなくなります。完了したセッションと作成したプロジェクトはそのまま残ります。',

  invitations: '招待',
  invitationsIntro: 'このワークスペースに招待した人と、それぞれの招待の状況です。',
  unreadableIssued:
    '招待は作成されましたが、リンクを含む応答を読み取れなかったため、リンクは失われました。下の招待を取り消して、新しい招待を送ってください。',
  unreadableResent:
    '招待を再送しましたが、新しいリンクを含む応答を読み取れなかったため、リンクは失われました。もう一度再送して新しいリンクを取得してください。',
  inviteHeading: 'このワークスペースに招待する',
  inviteNote:
    'メールは送信されません。リンクはここに一度だけ表示されるので、あなたから伝えてください。',
  email: 'メールアドレス',
  chooseRole: 'ロールを選択',
  sending: '送信中…',
  sendInvitation: '招待を送る',
  linkFor: (email) => `${email} への招待リンク`,
  relayNote:
    'このデプロイはメールを送信しないため、このリンクはあなたから伝えてください。リンクはどこにも保存されず、この画面を離れると失われます。',
  copyLabel: (email) => `${email} への招待リンクをコピー`,
  copyLink: 'リンクをコピー',
  dismissLabel: (email) => `${email} への招待リンクを閉じる`,
  dismiss: '閉じる',
  loadingInvitations: '招待を読み込み中…',
  invitationsRefused:
    'ユーザーの招待はこのワークスペースでのあなたのロールに含まれないため、招待は表示されません。アクセスが必要な人がいる場合は、オーナーか管理者に依頼してください。',
  noInvitations: 'このワークスペースから送った招待はありません。',
  invitationsCaption: 'このワークスペースが送った招待と、それぞれの状況です。',
  invitee: '招待した人',
  status: '状態',
  resendLabel: (email) => `${email} への招待を再送`,
  resend: '再送',
  revokeLabel: (email) => `${email} への招待を取り消す`,
  revoke: '取り消す',
};

const STRINGS: Readonly<Record<VersionsLocale, TeamStrings>> = { en: EN, ja: JA };

export function teamStrings(locale: VersionsLocale): TeamStrings {
  return STRINGS[locale];
}
