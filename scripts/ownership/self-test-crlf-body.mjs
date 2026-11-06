/* global console */

/** @param {Pick<import('./types.mjs').SelfTestContext,'check'|'parses'|'body'|'quotedTemplate'>} context */
export function runCrlfBodyCases({ check, parses, body, quotedTemplate }) {
  console.log('\nCRLF PR bodies');

  // GitHub stores the body exactly as the author's client sent it, so a PR opened from a
  // Windows editor arrives CRLF. Before normalisation OWNS_LINE's `(.*)$` could not span the
  // trailing \r and this parsed as "the section has no Owns globs: line" — fail-closed, but
  // with a reason that blamed the author for a line they had written correctly.
  /** @param {string} b */
  const crlf = (b) => b.replace(/\n/g, '\r\n');

  check('a CRLF body parses like an LF one', parses(crlf(body)), [
    '.github/**',
    'scripts/check-file-ownership.mjs',
  ]);

  check('a CRLF fenced quote is still stripped', parses(crlf(quotedTemplate)), ['.github/**']);

  check(
    'a CRLF whole-repo declaration is still refused',
    parses(crlf('## Ownership\nOwns globs: `**`')),
    'REJECTED',
  );

  check('a lone-CR body parses too', parses(body.replace(/\n/g, '\r')), [
    '.github/**',
    'scripts/check-file-ownership.mjs',
  ]);

  check(
    'a CRLF "none" is an empty declaration',
    parses(crlf('## Ownership\nOwns globs: none')),
    [],
  );
}
