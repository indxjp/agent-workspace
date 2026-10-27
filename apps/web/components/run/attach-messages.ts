/**
 * The console composer's Attach file control, in English and Japanese (issue #1680), in the shape
 * of `../agents/versions-messages.ts`, whose locale negotiation it shares.
 */
import { versionsLocaleOf, type VersionsLocale } from '../agents/versions-messages';

export interface AttachStrings {
  readonly attach: string;
  readonly uploading: string;
  readonly attachedLabel: string;
  readonly archivedReason: string;
  readonly noSessionReason: string;
  readonly failed: string;
}

const EN: AttachStrings = {
  attach: 'Attach file',
  uploading: 'Uploading…',
  attachedLabel: 'Attached files',
  archivedReason: 'This project is archived, so files can no longer be attached.',
  noSessionReason: 'Files can be attached once the session has started.',
  failed: 'The file could not be attached.',
};

const JA: AttachStrings = {
  attach: 'ファイルを添付',
  uploading: 'アップロード中…',
  attachedLabel: '添付ファイル',
  archivedReason: 'このプロジェクトはアーカイブされているため、ファイルを添付できません。',
  noSessionReason: 'セッションの開始後にファイルを添付できます。',
  failed: 'ファイルを添付できませんでした。',
};

const STRINGS: Readonly<Record<VersionsLocale, AttachStrings>> = { en: EN, ja: JA };

export function attachStrings(locale: VersionsLocale): AttachStrings {
  return STRINGS[locale];
}

/** The browser's own language list, as the `Accept-Language` list the shared negotiation reads. */
export function browserLocale(languages: readonly string[]): VersionsLocale {
  return versionsLocaleOf(languages.join(','));
}
