/**
 * Model-written text made safe to show a person who is about to approve something. Two functions,
 * for two surfaces. An approval surface uses {@link revealInvisible} alone: nothing is deleted, so
 * nothing the model wrote can be hidden from the person who is deciding. Streamed output, which is
 * read once and not decided on, uses {@link stripControlSequences}, which a terminal needs.
 */

/**
 * Characters that draw nothing, draw like another character, or reorder what is drawn: every
 * control character but tab and newline, every format character (zero-width, bidirectional, word
 * joiner, tag, interlinear annotation), every space separator but the ASCII space, the line and
 * paragraph separators, the variation selectors, the fillers that render blank and the braille
 * blank.
 */
const INVISIBLE =
  /(?![\t\n ])(?:[\p{Cc}\p{Cf}\p{Zs}\p{Zl}\p{Zp}\u{E0100}-\u{E01EF}]|\u2800|[\uFE00-\uFE0F]|[\u180B-\u180D]|\u034F|\u115F|\u1160|\u17B4|\u17B5|\u3164|\uFFA0)/gu;

/**
 * `text` with every character that cannot be seen written as its code point, `<U+200B>`, so a
 * reviewer sees that it is there and two strings that differ only by one never look equal.
 */
export function revealInvisible(text: string): string {
  return text.replace(INVISIBLE, (char) => {
    const code = char.codePointAt(0) ?? 0;
    return `<U+${code.toString(16).toUpperCase().padStart(4, '0')}>`;
  });
}

/**
 * `text` as inert terminal output: an escape sequence (CSI, OSC and the other `ESC` forms) is
 * dropped with its payload, and so is every other control character but tab and newline, so
 * nothing a model wrote can move the cursor, retitle the window or hide the line being read.
 */
export function stripControlSequences(text: string): string {
  let out = '';
  for (let at = 0; at < text.length; at += 1) {
    const code = text.charCodeAt(at);
    if (code === 0x1b) {
      at = escapeEnd(text, at);
    } else if (code === 0x09 || code === 0x0a || (code >= 0x20 && code !== 0x7f && !isC1(code))) {
      out += text.charAt(at);
    }
  }
  return out;
}

const isC1 = (code: number): boolean => code >= 0x80 && code <= 0x9f;

/** The index of the last character of the escape sequence that starts at `start`. */
function escapeEnd(text: string, start: number): number {
  const kind = text.charAt(start + 1);
  if (kind === '[') {
    // CSI: parameter and intermediate bytes, then one final byte.
    let at = start + 2;
    while (at < text.length && (text.charCodeAt(at) < 0x40 || text.charCodeAt(at) > 0x7e)) at += 1;
    return Math.min(at, text.length - 1);
  }
  if (kind !== '' && ']PX^_'.includes(kind)) {
    // OSC and the other string sequences end at BEL or ESC \; an unterminated one runs to the end.
    const ends = [text.indexOf('\x07', start + 2), text.indexOf('\x1b\\', start + 2) + 1];
    return Math.min(...ends.filter((end) => end > 0), text.length - 1);
  }
  return Math.min(start + 1, text.length - 1);
}
