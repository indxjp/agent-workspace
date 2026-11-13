/**
 * The shell's words in the reader's language (UX-15 in #2086): the navigation, its group heading,
 * the Menu button, the skip link, the runtime chip and band, and the role under the user's name.
 *
 * English is §44's own text. The navigation's English labels stay in `navigation.ts`, copied from
 * §44 and never reworded; this file only adds the Japanese a `ja` reader sees instead. The
 * Japanese matches the terms the Settings → Features card already uses for the same features
 * (`components/workspace/features-messages.ts`), so a screen and its menu entry share a name.
 *
 * The locale comes from the request's `Accept-Language`, negotiated once in the shell layout the
 * way `app/layout.tsx` sets `<html lang>`, and is passed down as a prop, so the server render and
 * the client render cannot disagree.
 */
import type { MembershipRoleName } from '@indx-workspace/contracts/team';

import type { VersionsLocale } from '../agents/versions-messages';

import type { NavGroup, NavId, NavItem } from './navigation';

export type ShellLocale = VersionsLocale;

export interface ShellStrings {
  readonly menu: string;
  readonly skipToContent: string;
  /** Before the driver's name in the top bar chip: "Runtime: local". */
  readonly runtimePrefix: string;
  readonly runtimeNotConfigured: string;
  readonly runtimeTitle: string;
  /** Before the driver's name in the band under the top bar. */
  readonly driverInForce: string;
  readonly localIsolation: string;
  readonly chooseRuntime: string;
  readonly unknownRole: string;
  readonly dismiss: string;
  readonly signOut: string;
  /** The recent chats under New chat (spec §44): their list's name, a row with no label, the link to Runs. */
  readonly recentChats: string;
  readonly untitledChat: string;
  readonly seeAllChats: string;
}

const EN: ShellStrings = {
  menu: 'Menu',
  skipToContent: 'Skip to content',
  runtimePrefix: 'Runtime:',
  runtimeNotConfigured: 'not configured',
  runtimeTitle: 'Runtime driver in force for this workspace',
  driverInForce: 'Runtime driver in force:',
  localIsolation: 'No tenant isolation: commands run as the host user',
  chooseRuntime: 'Choose and test a runtime on the Runtimes screen',
  unknownRole: 'Unknown role',
  dismiss: 'Dismiss',
  signOut: 'Sign out',
  recentChats: 'Recent chats',
  untitledChat: 'Untitled chat',
  seeAllChats: 'See all',
};

const JA: ShellStrings = {
  menu: 'メニュー',
  skipToContent: '本文へ移動',
  runtimePrefix: 'ランタイム:',
  runtimeNotConfigured: '未設定',
  runtimeTitle: 'このワークスペースで使われているランタイムドライバー',
  driverInForce: '使用中のランタイムドライバー:',
  localIsolation: 'テナントの分離なし：コマンドはホストのユーザーとして実行されます',
  chooseRuntime: 'ランタイム画面でランタイムを選んでテストしてください',
  unknownRole: '不明なロール',
  dismiss: '閉じる',
  signOut: 'サインアウト',
  recentChats: '最近のチャット',
  untitledChat: '無題のチャット',
  seeAllChats: 'すべて表示',
};

/** Each navigation entry in Japanese; a `Record` over `NavId`, so a new entry fails typecheck here. */
const JA_NAV: Record<NavId, string> = {
  home: '新しいチャット',
  projects: 'プロジェクト',
  agents: 'エージェント',
  files: 'ファイル',
  skills: 'スキル',
  connectors: 'コネクタ',
  runs: '実行',
  models: 'モデル',
  storage: 'ストレージ',
  users: 'ユーザー',
  apikeys: 'API キー',
  runtimes: 'ランタイム',
  shares: '共有リンク',
  settings: '設定',
};

const JA_GROUP: Record<string, string> = { Administration: '管理' };

const JA_ROLE: Record<MembershipRoleName, string> = {
  owner: 'オーナー',
  admin: '管理者',
  builder: 'ビルダー',
  viewer: '閲覧者',
};

export function shellStrings(locale: ShellLocale): ShellStrings {
  return locale === 'ja' ? JA : EN;
}

/** An entry's label: §44's English, or its Japanese for a `ja` reader. */
export function navLabel(item: Pick<NavItem, 'id' | 'label'>, locale: ShellLocale): string {
  return locale === 'ja' ? JA_NAV[item.id] : item.label;
}

/** A group heading: §44's English, or its Japanese; `null` stays the unlabelled first group. */
export function groupLabel(group: Pick<NavGroup, 'label'>, locale: ShellLocale): string | null {
  if (group.label === null || locale !== 'ja') return group.label;
  return JA_GROUP[group.label] ?? group.label;
}

/** A §21 role in Japanese, or `undefined` for a value that is not one of the four. */
export function japaneseRole(role: string): string | undefined {
  return Object.hasOwn(JA_ROLE, role) ? JA_ROLE[role as MembershipRoleName] : undefined;
}
