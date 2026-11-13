import { POLICY, SPDX_3_28_0_IDENTIFIERS_USED_BY_THIS_POLICY } from './policy.mjs';

/** @typedef {import('./types.mjs').SpdxNode} SpdxNode */
/** @typedef {import('./types.mjs').SpdxToken} SpdxToken */

const ID_CHAR = /[A-Za-z0-9.-]/;

class SpdxParseError extends Error {}

/** @param {string} source @returns {SpdxToken[]} */
function tokenise(source) {
  const tokens = [];
  let i = 0;
  while (i < source.length) {
    const c = source.charAt(i);
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    if (c === '(' || c === ')' || c === '+') {
      tokens.push({ value: c, offset: i });
      i++;
      continue;
    }
    if (ID_CHAR.test(c)) {
      const start = i;
      while (i < source.length && ID_CHAR.test(source.charAt(i))) i++;
      tokens.push({ value: source.slice(start, i), offset: start });
      continue;
    }
    throw new SpdxParseError(`Unexpected \`${c}\` at offset ${i}`);
  }
  return tokens;
}

// A bare identifier must look like an SPDX id: it starts with a letter or digit. `WITH`,
// `AND` and `OR` are operators, never identifiers, so they are rejected here.
const LICENCE_ID = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;
const OPERATORS = new Set(['AND', 'OR', 'WITH']);

class SpdxParser {
  /** @param {string} source */
  constructor(source) {
    this.tokens = tokenise(source);
    this.pos = 0;
  }
  /** @returns {SpdxToken | undefined} */
  peek() {
    return this.tokens[this.pos];
  }
  endOffset() {
    return this.tokens.at(-1)?.offset ?? 0;
  }
  /** @param {string} what @returns {string} */
  expectIdentifier(what) {
    const token = this.peek();
    if (!token)
      throw new SpdxParseError(`Unexpected end of expression at offset ${this.endOffset()}`);
    if (!LICENCE_ID.test(token.value) || OPERATORS.has(token.value)) {
      throw new SpdxParseError(
        `Unexpected \`${token.value[0]}\` at offset ${token.offset} (${what})`,
      );
    }
    this.pos++;
    return token.value;
  }
  /** @returns {SpdxNode} */
  parseSimple() {
    const token = this.peek();
    if (!token)
      throw new SpdxParseError(`Unexpected end of expression at offset ${this.endOffset()}`);
    if (token.value === '(') {
      this.pos++;
      const inner = this.parseOr();
      const close = this.peek();
      if (!close || close.value !== ')')
        throw new SpdxParseError(`Unexpected end of expression at offset ${this.endOffset()}`);
      this.pos++;
      return inner;
    }
    const id = this.expectIdentifier('licence identifier');
    let orLater = false;
    if (this.peek()?.value === '+') {
      this.pos++;
      orLater = true;
    }
    if (id.startsWith('LicenseRef-') || id.startsWith('DocumentRef-')) return { op: 'ref', id };
    return { op: 'lic', id, orLater };
  }
  /** @returns {SpdxNode} */
  parseWith() {
    const left = this.parseSimple();
    if (this.peek()?.value !== 'WITH') return left;
    this.pos++;
    return {
      op: 'with',
      base: left,
      exception: this.expectIdentifier('licence-exception identifier'),
    };
  }
  /** @returns {SpdxNode} */
  parseAnd() {
    let node = this.parseWith();
    while (this.peek()?.value === 'AND') {
      this.pos++;
      node = { op: 'and', left: node, right: this.parseWith() };
    }
    return node;
  }
  /** @returns {SpdxNode} */
  parseOr() {
    let node = this.parseAnd();
    while (this.peek()?.value === 'OR') {
      this.pos++;
      node = { op: 'or', left: node, right: this.parseAnd() };
    }
    return node;
  }
  /** @returns {SpdxNode} */
  parse() {
    const ast = this.parseOr();
    const trailing = this.peek();
    if (trailing)
      throw new SpdxParseError(
        `Unexpected \`${trailing.value[0]}\` at offset ${trailing.offset} (trailing input)`,
      );
    return ast;
  }
}

/** @param {unknown} source @returns {SpdxNode} */
export function parseSpdx(source) {
  if (typeof source !== 'string' || source.trim() === '')
    throw new SpdxParseError('Unexpected end of expression at offset 0');
  return new SpdxParser(source).parse();
}

/** @type {Readonly<Record<string, string>>} */
export const DEPRECATED_SPDX_WITH_FORMS = {
  'GPL-2.0-with-autoconf-exception': 'GPL-2.0-only WITH Autoconf-exception-2.0',
  'GPL-2.0-with-bison-exception': 'GPL-2.0-only WITH Bison-exception-2.2',
  'GPL-2.0-with-classpath-exception': 'GPL-2.0-only WITH Classpath-exception-2.0',
  'GPL-2.0-with-font-exception': 'GPL-2.0-only WITH Font-exception-2.0',
  'GPL-2.0-with-GCC-exception': 'GPL-2.0-only WITH GCC-exception-2.0',
  'GPL-3.0-with-autoconf-exception': 'GPL-3.0-only WITH Autoconf-exception-3.0',
  'GPL-3.0-with-GCC-exception': 'GPL-3.0-only WITH GCC-exception-3.1',
};

const GNU_WITH_FORM = /^((?:A|L)?GPL)-(\d+\.\d+)-with-(.+)$/i;

const IDENTIFIER_RUN = /[A-Za-z0-9][A-Za-z0-9.+-]*/g;

/** @type {Map<string, string> | null} */
let spdxSpellings = null;

// Every identifier this policy can recognise, keyed by its lower-case form. Built from the
// verified 3.28.0 list, the policy's own lists, the deprecated `WITH` map on both sides, and
// the deprecated bare GNU forms derived from the family identifiers already registered.
/** @returns {Map<string, string>} */
function spdxSpellingRegistry() {
  if (spdxSpellings) return spdxSpellings;
  /** @type {Map<string, string>} */
  const map = new Map();
  /** @param {string} id */
  const register = (id) => {
    const key = id.toLowerCase();
    const seen = map.get(key);
    // Two registered spellings differing only by case would make canonicalisation ambiguous,
    // and SPDX's own case-insensitivity forbids it. Fail loudly rather than silently pick one.
    if (seen !== undefined && seen !== id) {
      throw new Error(`SPDX registry collision: \`${seen}\` and \`${id}\` differ only by case`);
    }
    map.set(key, id);
  };
  /** @param {string} entry @returns {string[]} */
  const identifiersIn = (entry) =>
    (entry.match(IDENTIFIER_RUN) ?? []).filter((t) => !OPERATORS.has(t));

  for (const id of SPDX_3_28_0_IDENTIFIERS_USED_BY_THIS_POLICY) register(id);
  /** @type {(keyof Pick<typeof POLICY, 'allow' | 'allowDev' | 'review' | 'denyFamilies' | 'denyLiteral'>)[]} */
  const identifierLists = ['allow', 'allowDev', 'review', 'denyFamilies', 'denyLiteral'];
  for (const key of identifierLists) {
    for (const entry of POLICY[key] ?? []) for (const id of identifiersIn(entry)) register(id);
  }
  for (const [deprecated, current] of Object.entries(DEPRECATED_SPDX_WITH_FORMS)) {
    register(deprecated);
    for (const id of identifiersIn(current)) register(id);
  }
  // The deprecated bare GNU forms — `GPL-3.0` for `GPL-3.0-only`, and so on. Derived from the
  // family identifiers already registered rather than typed out again, so the two cannot drift.
  for (const id of [...map.values()]) {
    const m = GNU_FAMILY.exec(id);
    if (m) register(`${m[1]}-${m[2]}`);
  }
  spdxSpellings = map;
  return map;
}

const GNU_FAMILY_ANY_CASE = /^((?:A|L)?GPL)-(\d+\.\d+)(?:-(only|or-later))?$/i;

// One token → its registered spelling, or the token untouched if we do not know it.
/** @param {string} token @returns {string} */
function spellCanonically(token) {
  // `IDENTIFIER_RUN` swallows a trailing `+`, which is not part of the identifier. Split it off,
  // canonicalise the identifier, put it back — `GPL-3.0+` must stay `GPL-3.0+` so the tokeniser
  // still reads the `+` as its own token and `salvageDenied` still sees it whole.
  const plus = token.endsWith('+');
  const bare = plus ? token.slice(0, -1) : token;
  const tail = plus ? '+' : '';
  const registered = spdxSpellingRegistry().get(bare.toLowerCase());
  if (registered) return registered + tail;
  const m = GNU_FAMILY_ANY_CASE.exec(bare);
  if (m) return `${m[1]?.toUpperCase()}-${m[2]}${m[3] ? `-${m[3].toLowerCase()}` : ''}${tail}`;
  return token;
}

/**
 * @overload
 * @param {string} source
 * @returns {string}
 */
/**
 * @template T
 * @overload
 * @param {T} source
 * @returns {T | string}
 */
/** @param {unknown} source @returns {unknown} */
export function canonicaliseSpdx(source) {
  if (typeof source !== 'string') return source;
  return source.replace(IDENTIFIER_RUN, (token) => {
    if (OPERATORS.has(token)) return token;
    const spelt = spellCanonically(token);
    const known = DEPRECATED_SPDX_WITH_FORMS[spelt];
    if (known) return known;
    const m = GNU_WITH_FORM.exec(spelt);
    return m ? `${m[1]?.toUpperCase()}-${m[2]}-only WITH ${m[3]}` : spelt;
  });
}

const GNU_FAMILY = /^((?:A|L)?GPL)-(\d+\.\d+)(?:-(only|or-later))?$/;

/** @param {string} id @param {boolean} [orLater] @returns {string} */
export function canonicalLicence(id, orLater = false) {
  const m = GNU_FAMILY.exec(id);
  if (!m) return id;
  const [, family, version, suffix] = m;
  const later = orLater || suffix === 'or-later';
  return `${family}-${version}-${later ? 'or-later' : 'only'}`;
}

/** @param {SpdxNode} node @returns {string | null} */
function canonicalString(node) {
  switch (node.op) {
    case 'lic':
      return canonicalLicence(node.id, node.orLater);
    case 'ref':
      return node.id;
    case 'with': {
      const base = canonicalString(node.base);
      return `${base} WITH ${node.exception}`;
    }
    default:
      return null; // AND / OR have no single canonical identifier.
  }
}

// ── Evaluation ──────────────────────────────────────────────────────────────────────────

/** @param {readonly string[]} identifiers @returns {Set<string>} */
export function canonicalSet(identifiers) {
  return new Set(identifiers.map((id) => canonicalLicence(id)));
}

// Does this expression permit us to comply with something on `allowed`?
//   OR  — we choose one side, so either side satisfying is enough.
//   AND — we must comply with both, so both sides must satisfy.
/** @param {SpdxNode} node @param {ReadonlySet<string>} allowedSet @returns {boolean} */
export function expressionSatisfies(node, allowedSet) {
  switch (node.op) {
    case 'or':
      return (
        expressionSatisfies(node.left, allowedSet) || expressionSatisfies(node.right, allowedSet)
      );
    case 'and':
      return (
        expressionSatisfies(node.left, allowedSet) && expressionSatisfies(node.right, allowedSet)
      );
    default: {
      const canonical = canonicalString(node);
      return canonical !== null && allowedSet.has(canonical);
    }
  }
}

/** @param {SpdxNode} node @param {ReadonlySet<string>} deniedSet @returns {boolean} */
export function expressionDenied(node, deniedSet) {
  switch (node.op) {
    case 'or':
      return expressionDenied(node.left, deniedSet) && expressionDenied(node.right, deniedSet);
    case 'and':
      return expressionDenied(node.left, deniedSet) || expressionDenied(node.right, deniedSet);
    case 'with':
      return expressionDenied(node.base, deniedSet);
    case 'ref':
      return false; // A LicenseRef cannot be matched to a family. It falls through to REVIEW.
    default:
      return deniedSet.has(canonicalLicence(node.id, node.orLater));
  }
}

/**
 * @param {string} raw
 * @param {ReadonlySet<string>} deniedSet
 * @param {ReadonlySet<string>} denyLiteralSet
 * @returns {string | null}
 */
export function salvageDenied(raw, deniedSet, denyLiteralSet) {
  const tokens = raw.match(IDENTIFIER_RUN) ?? [];
  for (const token of tokens) {
    if (denyLiteralSet.has(token)) return token;
    const bare = token.endsWith('+') ? token.slice(0, -1) : token;
    if (deniedSet.has(canonicalLicence(bare, token.endsWith('+')))) return token;
  }
  return null;
}
