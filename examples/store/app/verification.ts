/**
 * What a live card and its detail page say about how the agent was verified (spec, "Real-model
 * verification gate (R1)"). Never "live" without a passed real-model record: until then it is
 * "verified with the scripted model"; an entry under maintenance says so. The rule is `cardState`
 * in the catalog.
 */
import { StoreDemoStatesSchema } from '@indx-workspace/contracts/demo';

import { recordingFor, type Recording } from '../catalog/recording.ts';
import { cardState } from '../catalog/verification.ts';
import type { Lang } from './lang.ts';
import { tr } from './text.ts';

/** The longest the store waits for the platform's list before it shows no maintenance. */
export const MAINTENANCE_FETCH_TIMEOUT_MS = 3000;

/** The live entries the platform lists as under maintenance (`GET /api/store/demos`); none if it cannot say. */
export async function maintenanceSlugs(platformUrl: string): Promise<readonly string[]> {
  try {
    const answer = await fetch(new URL('/api/store/demos', platformUrl), {
      cache: 'no-store',
      signal: AbortSignal.timeout(MAINTENANCE_FETCH_TIMEOUT_MS),
    });
    const parsed = StoreDemoStatesSchema.safeParse(await answer.json());
    return parsed.success ? parsed.data.maintenance : [];
  } catch {
    return [];
  }
}

/** The card line for `slug`, in `lang`: "Under maintenance", or how it was verified. */
export function verificationLabel(
  slug: string,
  lang: Lang,
  maintenance: readonly string[] = [],
): string {
  const t = tr(lang);
  const verification = cardState(slug, maintenance);
  if (verification.kind === 'maintenance') return t('メンテナンス中', 'Under maintenance');
  return verification.kind === 'real-model'
    ? t(
        `実際のClaudeで検証済み（${verification.date.slice(0, 10)}）`,
        `Verified with real Claude (${verification.date.slice(0, 10)})`,
      )
    : t('台本どおりのモデルで検証済み', 'Verified with the scripted model');
}

/** The Try it section: the live demo, or, under maintenance, the "unavailable" fallback with its recording. */
export type TryChoice =
  | { readonly kind: 'live' }
  | { readonly kind: 'unavailable'; readonly recording: Recording | null };

export function tryChoice(
  slug: string,
  maintenance: readonly string[],
  recordings: readonly Recording[],
  lang: Lang,
): TryChoice {
  return maintenance.includes(slug)
    ? { kind: 'unavailable', recording: recordingFor(recordings, slug, lang) }
    : { kind: 'live' };
}
