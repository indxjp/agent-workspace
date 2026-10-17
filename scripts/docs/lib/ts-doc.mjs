/**
 * TSDoc extraction: the prose comment attached to a declaration, with `{@link X}` rendered as
 * `` `X` `` per the site's style guide (a link target the reference pages do not all resolve to
 * an anchor, so it is kept as inline code rather than a possibly-dead link).
 */
import ts from 'typescript';

import { mdxProse } from './mdx.mjs';

/** @param {string | ts.NodeArray<ts.JSDocComment> | undefined} comment */
function commentText(comment) {
  if (comment === undefined) return '';
  if (typeof comment === 'string') return comment;
  return comment
    .map((part) => {
      if (ts.isJSDocLinkLike(part)) {
        const name = part.name?.getText() ?? '';
        const label = part.text.trim();
        return `\`${name === '' ? label : name}\``;
      }
      return part.text;
    })
    .join('');
}

/**
 * The declaration's own TSDoc prose (no `@tag` blocks), trimmed. Empty string when the
 * declaration carries none.
 * @param {ts.Node} node
 */
export function tsDocOf(node) {
  const docs = ts.getJSDocCommentsAndTags(node).filter(ts.isJSDoc);
  return docs
    .map((doc) => commentText(doc.comment))
    .join('\n\n')
    .trim();
}

/**
 * `tsDocOf`, MDX-escaped for direct use as page prose (not a table cell — see `mdxTableCell`).
 * @param {ts.Node} node
 */
export function mdxDoc(node) {
  return mdxProse(tsDocOf(node));
}
