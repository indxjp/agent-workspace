import { sessionCookieName } from '../auth/session';

/** Read the configured session cookie value from a raw Cookie header. */
export function sessionCookieValue(header: string | null): string | undefined {
  if (header === null) return undefined;
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at < 0) continue;
    if (part.slice(0, at).trim() !== sessionCookieName()) continue;
    return part.slice(at + 1).trim();
  }
  return undefined;
}
