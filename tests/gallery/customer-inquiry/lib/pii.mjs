// Personal-data masking for everything the CRM server returns, and the check the chat backend runs
// on every answer before it leaves.
//
// Agent Workspace does not redact tool results or answers, so this is the use case's own code.
// Two layers: the values the CRM holds for the customer (their phone, e-mail, address) are masked
// wherever they appear verbatim, and patterns catch the ones written into free text in another
// form (a new address typed into a chat, a phone number in full-width digits).

const DIGIT = '[0-9０-９]';
const DASH = '[-－‐−ー]';
const SEP = '[\\s\\-－‐−ー(（)）]?';
const NOT_BREAK = '[^\\s、。，．,「」『』（）()\\[\\]〔〕]';

const PATTERNS = [
  { kind: 'email', label: '［メール］', regex: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu },
  {
    kind: 'postal',
    label: '［郵便番号］',
    regex: new RegExp(`〒\\s?${DIGIT}{3}${DASH}${DIGIT}{4}`, 'gu'),
  },
  {
    // A prefecture, then everything up to a break, when it holds a number; a building after a
    // space is part of it when it ends in 号室 or a number.
    kind: 'address',
    label: '［住所］',
    regex: new RegExp(
      `(?:北海道|東京都|京都府|大阪府|[\\u4E00-\\u9FFF]{2,3}県)${NOT_BREAK}*${DIGIT}${NOT_BREAK}*(?:\\s${NOT_BREAK}*(?:号室|${DIGIT}))?`,
      'gu',
    ),
  },
  {
    // A city or ward with a block number (2-14-8) and no prefecture before it.
    kind: 'address',
    label: '［住所］',
    regex: new RegExp(
      `[\\u4E00-\\u9FFF\\u3040-\\u30FF]{1,8}[市区]${NOT_BREAK}*?${DIGIT}+(?:${DASH}${DIGIT}+){1,2}`,
      'gu',
    ),
  },
  {
    // Japanese numbers start with 0: 090-1234-5678, 03-1234-5678, 0312345678, ０９０…, +81 90 ….
    kind: 'phone',
    label: '［電話番号］',
    regex: new RegExp(
      `(?<!${DIGIT})(?:(?:\\+81[\\s-]?)${DIGIT}{1,4}|[0０]${DIGIT}{1,4})${SEP}${DIGIT}{1,4}${SEP}${DIGIT}{3,4}(?!${DIGIT})`,
      'gu',
    ),
  },
];

const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/**
 * Replace personal data in `text` with a label such as ［電話番号］. `known` are values to mask
 * verbatim wherever they appear (the customer's own phone, address and e-mail); `allow` are
 * public values to leave alone (the company's own free-dial number).
 */
export function maskPii(text, { known = [], allow = [] } = {}) {
  if (typeof text !== 'string' || text === '') return text;
  let masked = text;
  for (const pattern of PATTERNS) {
    masked = masked.replace(pattern.regex, (match) =>
      allow.includes(match) ? match : pattern.label,
    );
  }
  for (const value of known) {
    if (typeof value === 'string' && value.trim() !== '') {
      masked = masked.replace(new RegExp(escape(value), 'gu'), '［個人情報］');
    }
  }
  return masked;
}

/** Mask every string inside `value` (objects and arrays included), returning a new value. */
export function maskDeep(value, options) {
  if (typeof value === 'string') return maskPii(value, options);
  if (Array.isArray(value)) return value.map((item) => maskDeep(item, options));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, maskDeep(item, options)]),
    );
  }
  return value;
}

/** Every piece of personal data the patterns find in `text`, minus `allow`: `[{ kind, match }]`. */
export function findPii(text, { allow = [] } = {}) {
  const found = [];
  for (const pattern of PATTERNS) {
    for (const match of text.matchAll(pattern.regex)) {
      if (!allow.includes(match[0])) found.push({ kind: pattern.kind, match: match[0] });
    }
  }
  return found;
}
