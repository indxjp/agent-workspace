/**
 * The email link's own parts, read from the page's fragment (`#token=…&email=…&entry=…`). The
 * fragment never reaches a server, so the one-time token stays out of access logs; the page
 * removes it from the address bar as soon as it has read it. Pure, so `tests/store/try-*.test.ts`
 * runs it.
 */
import {
  EmailLinkVerifyRequestSchema,
  type EmailLinkVerifyRequest,
} from '@indx-workspace/contracts/email-link';

/** The link's parts when the fragment holds a well-formed link, else `null`. */
export function parseLinkFragment(hash: string): EmailLinkVerifyRequest | null {
  const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
  const entry = params.get('entry');
  const parsed = EmailLinkVerifyRequestSchema.safeParse({
    email: params.get('email') ?? '',
    token: params.get('token') ?? '',
    ...(entry === null ? {} : { entry }),
  });
  return parsed.success ? parsed.data : null;
}

/** Where a verified visitor goes: the entry's Try tab, or the shelves when the link named none. */
export function afterSignInPath(entry: string | undefined): string {
  return entry === undefined ? '/' : `/agents/${entry}#try`;
}
