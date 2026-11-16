export function blockCommentEnd(text: string, start: number, unterminatedMessage: string): number {
  let depth = 1;
  let cursor = start + 2;
  while (cursor < text.length && depth > 0) {
    if (text.startsWith('/*', cursor)) {
      depth += 1;
      cursor += 2;
    } else if (text.startsWith('*/', cursor)) {
      depth -= 1;
      cursor += 2;
    } else cursor += 1;
  }
  if (depth > 0) throw new Error(unterminatedMessage);
  return cursor;
}
export function quotedTokenEnd(text: string, start: number, unterminated: () => Error): number {
  const quote = text[start];
  if (quote !== "'" && quote !== '"') throw new Error('quoted token must start at a quote');
  let cursor = start + 1;
  for (;;) {
    const close = text.indexOf(quote, cursor);
    if (close === -1) throw unterminated();
    if (text[close + 1] !== quote) return close + 1;
    cursor = close + 2;
  }
}
export function dollarQuotedEnd(
  text: string,
  start: number,
  unterminated: (marker: string) => Error,
): number | null {
  const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/u.exec(text.slice(start));
  if (tag === null) return null;
  const marker = tag[0];
  const close = text.indexOf(marker, start + marker.length);
  if (close === -1) throw unterminated(marker);
  return close + marker.length;
}
