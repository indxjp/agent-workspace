/**
 * The email-link sign-in's rules: pure functions and named limits, no I/O (AGENTS.md, hexagonal
 * rule 1). Time is an argument, never read here.
 */
import { EMAIL_LINK_TTL_SECONDS } from '@indx-workspace/contracts/email-link';

/** Link requests per client per minute (`POST /api/auth/email-link`). */
export const EMAIL_LINK_ISSUES_PER_MINUTE_PER_CLIENT = 5;

/** Link verifications per client per minute (`POST /api/auth/email-link/verify`). */
export const EMAIL_LINK_VERIFIES_PER_MINUTE_PER_CLIENT = 10;

/** Links sent to one address within {@link EMAIL_LINK_ADDRESS_WINDOW_MS}, counted from the table. */
export const EMAIL_LINK_ISSUES_PER_ADDRESS = 3;

/** The window the per-address limit counts over: 15 minutes. */
export const EMAIL_LINK_ADDRESS_WINDOW_MS = 15 * 60 * 1000;

/** When a link issued at `now` stops being usable. */
export function linkExpiry(now: Date): Date {
  return new Date(now.getTime() + EMAIL_LINK_TTL_SECONDS * 1000);
}

/** The start of the window the per-address limit counts over, for a request at `now`. */
export function addressWindowStart(now: Date): Date {
  return new Date(now.getTime() - EMAIL_LINK_ADDRESS_WINDOW_MS);
}

/**
 * The link a visitor opens: `<base>/sign-in#token=<token>&email=<address>`, with `&entry=<slug>`
 * when the visitor chose a demo. Every value sits in the fragment, which a browser never sends to a
 * server, so none reaches an access log or a `Referer`. A trailing slash on `base` is dropped.
 */
export function buildLinkUrl(base: string, token: string, email: string, entry?: string): string {
  const root = base.replace(/\/+$/u, '');
  const fragment = new URLSearchParams(
    entry === undefined ? { token, email } : { token, email, entry },
  ).toString();
  return `${root}/sign-in#${fragment}`;
}
