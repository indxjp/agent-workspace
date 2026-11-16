import { DESK_TOKEN } from '../../server/desk';
import { PERSON_TOKEN_COOKIE } from '@indx-workspace/app/server';

/**
 * The desk's stand-in for an app's sign-in: it keeps the one person's platform token in the app's
 * own cookie, as a real app keeps the token `aw.auth.exchange` returns, then opens the board in
 * the language asked for (`?lang=ja`).
 */
export function GET(request: Request): Response {
  const lang = new URL(request.url).searchParams.get('lang') === 'ja' ? '?lang=ja' : '';
  return new Response(null, {
    status: 303,
    headers: {
      location: `/tickets${lang}`,
      'set-cookie': `${PERSON_TOKEN_COOKIE}=${DESK_TOKEN}; Path=/; HttpOnly; SameSite=Lax`,
      'cache-control': 'no-store',
    },
  });
}
