/**
 * Turning a session into the two strings the sidebar foot shows.
 *
 * The mockup's avatar carries two letters ("AI" for "Aya Ito"). A Wave 1 session carries an email
 * address and nothing else — no display name exists to split, because no task has built one — so
 * the same two-letter shape is derived from the address's local part: one letter from each of its
 * first two dot/underscore/hyphen-separated words, or its first two letters when it has only one
 * word.
 *
 * ADR-0015: the input is parsed before it is used, and every path that cannot produce two letters
 * ends in an explicit refusal that says what it refused, rather than in an empty circle.
 */

/** What the avatar shows when the address yields no letters at all. */
export const UNKNOWN_INITIALS = '?';

export function initialsFrom(email: unknown): string {
  if (typeof email !== 'string') return UNKNOWN_INITIALS;
  const local = email.split('@')[0] ?? '';
  const words = local.split(/[^a-z0-9]+/iu).filter((word) => word.length > 0);
  if (words.length === 0) return UNKNOWN_INITIALS;
  if (words.length === 1) return (words[0] ?? '').slice(0, 2).toUpperCase();
  return `${(words[0] ?? '').slice(0, 1)}${(words[1] ?? '').slice(0, 1)}`.toUpperCase();
}

/** `'owner'` → `'Owner'`. Spec §21 names the four roles in lower case; the chip shows them capitalised. */
export function roleLabel(role: unknown): string {
  if (typeof role !== 'string' || role.length === 0) return 'Unknown role';
  return `${role.slice(0, 1).toUpperCase()}${role.slice(1)}`;
}
