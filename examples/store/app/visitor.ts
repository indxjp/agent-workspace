/**
 * How the store's visitor pages (/runs, /runs/:id, /chat, /files) read the platform as the
 * signed-in visitor (spec "The store app"). The store's server cannot see the platform's session
 * cookie, so the browser asks with the visitor's own email-link session, which belongs to their own
 * demo workspace with the guest role: the platform narrows every answer to that visitor, and a
 * second visitor's cookie reaches only the second visitor's runs. The allowance is read first, and
 * says whether there is a demo at all and whether it has ended.
 */
import { DEMO_ALLOWANCE_PATH, DemoAllowanceSchema } from '@indx-workspace/contracts/demo';
import { ApiProblemError, createClient, type AgentWorkspaceClient } from '@indx-workspace/sdk';

import type { Lang } from './lang.ts';
import { callPlatform } from './platform-api.ts';

/** What a visitor page can show instead of its content. */
export type VisitorRead<T> =
  { readonly kind: 'ok'; readonly value: T } | { readonly kind: 'signed-out' | 'ended' | 'failed' };

/**
 * `read` as the visitor at `platformUrl`. `signed-out`: no session, or a session with no demo
 * workspace. `ended`: the demo's expiry has passed, and `read` is never called. `failed`: no
 * answer. `signed-out` also when `read` is refused with 401 or 403 (a session that ended since the
 * allowance, or rights the guest role lacks).
 */
export async function readAsVisitor<T>(
  platformUrl: string,
  read: (client: AgentWorkspaceClient) => Promise<T>,
  now: Date = new Date(),
): Promise<VisitorRead<T>> {
  const allowance = await callPlatform(platformUrl, DEMO_ALLOWANCE_PATH, DemoAllowanceSchema);
  if (!allowance.ok) {
    const gone = allowance.status === 401 || allowance.code === 'demo_workspace_not_found';
    return { kind: gone ? 'signed-out' : 'failed' };
  }
  if (new Date(allowance.value.expiresAt) <= now) return { kind: 'ended' };
  try {
    const client = createClient({ baseUrl: platformUrl, auth: { kind: 'session' } });
    return { kind: 'ok', value: await read(client) };
  } catch (error) {
    const refused = error instanceof ApiProblemError && [401, 403].includes(error.status);
    return { kind: refused ? 'signed-out' : 'failed' };
  }
}

/** The words of a page that has no content to show, by why. */
const NOTICES = {
  'signed-out': {
    ja: 'ご自身のデモを見るには、エージェントの「試す」タブでメールアドレスからサインインしてください。',
    en: 'To see your own demo, sign in with your email from the Try tab of an agent.',
  },
  ended: {
    ja: 'デモは終了しました。もう一度試すには、エージェントの「試す」タブから始めてください。',
    en: 'Your demo has ended. To try again, start one from the Try tab of an agent.',
  },
  failed: {
    ja: '読み込めませんでした。しばらくしてからもう一度お試しください。',
    en: 'This could not be read. Please try again in a moment.',
  },
};

/** The sentence for a page with no content, in `lang`. */
export const visitorNotice = (kind: keyof typeof NOTICES, lang: Lang) => NOTICES[kind][lang];
