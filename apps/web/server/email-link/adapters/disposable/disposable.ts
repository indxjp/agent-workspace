import type { DisposableEmailList } from '../../ports';
import { DISPOSABLE_EMAIL_DOMAINS } from './domains';

/**
 * A {@link DisposableEmailList} over `domains` (lower-case). An address is disposable when its
 * domain, or any parent of its domain, is on the list: `x@mx.mailinator.com` matches
 * `mailinator.com`, `x@notmailinator.com` does not. Case and surrounding space do not matter.
 */
export function createDisposableEmailList(
  domains: readonly string[] = DISPOSABLE_EMAIL_DOMAINS,
): DisposableEmailList {
  const listed = new Set(domains);
  return {
    isDisposable(address) {
      const at = address.lastIndexOf('@');
      if (at < 0) return false;
      const labels = address
        .slice(at + 1)
        .trim()
        .toLowerCase()
        .replace(/\.$/u, '')
        .split('.');
      for (let start = 0; start < labels.length - 1; start += 1) {
        if (listed.has(labels.slice(start).join('.'))) return true;
      }
      return false;
    },
  };
}
