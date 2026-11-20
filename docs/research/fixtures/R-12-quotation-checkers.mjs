// The checkers of R-12-quotation-check.mjs, keyed by the region id they answer for.

import { basename } from 'node:path';
import {
  afterLabel,
  asvsRequirements,
  citation,
  citedSpan,
  comparable,
  declarationBody,
  excerptOf,
  fenceContent,
  flattenMarkdownLinks,
  identical,
  markdownSectionBody,
  nistSectionBody,
  prefixOf,
  verbatimWithin,
  wholeFenceOf,
  wholeParagraphOf,
  withoutFenceDelimiters,
} from './R-12-quotation-text.mjs';

export const CHECKERS = {
  'nist-3.1.2.2': {
    arg: '--nist',
    describe: 'NIST SP 800-63B-4 §3.1.2.2, whole section body',
    check(sourceText) {
      return (regionText) =>
        identical(nistSectionBody(sourceText, 'lookupver'), regionText, 'the #lookupver body');
    },
  },
  'nist-3.1.2-definition': {
    arg: '--nist',
    describe: 'NIST SP 800-63B-4 §3.1.2, the authenticator definition',
    check(sourceText) {
      return (regionText) =>
        excerptOf(
          nistSectionBody(sourceText, 'lookupsecrets'),
          regionText,
          'the #lookupsecrets body',
        );
    },
  },
  'asvs-v6.5': {
    arg: '--asvs',
    describe: 'OWASP ASVS 5.0 §V6.5, every requirement row',
    check(sourceText) {
      return (regionText) => {
        const note = comparable(regionText);
        const rows = asvsRequirements(sourceText, /^##\s+V6\.5\s/u);
        const missing = [];
        const present = [];
        for (const row of rows) {
          // Classifier, not a filter: every derived row lands in exactly one of these two lists,
          // and a non-empty `missing` is the failure.
          if (note.includes(comparable(row.text))) present.push(row.id);
          else missing.push(row.id);
        }
        // Every requirement id the region prints, in any form the region prints them, must be an id
        // the source has. The id pattern is the shape of an ASVS requirement number, not a list of
        // the ids this file knows; a number the source does not have is `notInSource`. It is read
        // from the region AS WRITTEN and not from `note`: reading it from the comparison form would
        // make this test blind to whatever that form removes, which is how round 5's fabricated
        // `6.5.9` row reached `notInSource: []`.
        const quotedIds = [...regionText.matchAll(/(\d+\.\d+\.\d+)/gu)].map((m) => m[1]);
        const known = new Set(rows.map((r) => r.id));
        const fabricated = [...new Set(quotedIds)].filter((id) => !known.has(id));
        if (missing.length > 0 || fabricated.length > 0) {
          return { ok: false, detail: { missingFromNote: missing, notInSource: fabricated } };
        }
        // The converse direction, and the one the two assertions above do not reach. They say the
        // region carries every row and prints no unknown id; neither says the region carries
        // nothing else, so a normative sentence appended to a real row — written without a
        // requirement number, so no id test sees it, and after the row's text, so the row is still
        // contained — satisfies both. The region is therefore compared for identity against the
        // whole derived table, id and text, in the source's order: neither side may carry a
        // character the other does not.
        const wholeTable = rows.map((row) => `**${row.id}** ${row.text}`).join('\n\n');
        const bothWays = identical(wholeTable, regionText, 'the whole V6.5 requirement table');
        if (!bothWays.ok) return bothWays;
        return {
          ok: true,
          detail: `rows in source: ${rows.length}; ${bothWays.detail}, in the source's order: ${present.join(' ')}`,
        };
      };
    },
  },
  'asvs-v6.5-preamble': {
    arg: '--asvs',
    describe: 'OWASP ASVS 5.0 §V6.5, the scoping preamble (an excerpt, elision declared)',
    check(sourceText) {
      const body = flattenMarkdownLinks(markdownSectionBody(sourceText, /^##\s+V6\.5\s/u));
      return (regionText) => excerptOf(body, regionText, 'the V6.5 section body');
    },
  },
  'spec-21': {
    arg: '--spec',
    describe: 'docs/spec.md § "21. Users and RBAC", whole section body',
    check(sourceText) {
      return (regionText) =>
        identical(markdownSectionBody(sourceText, /^#\s+21\.\s/u), regionText, "§21's body");
    },
  },
  'spec-20-body': {
    arg: '--spec',
    describe: 'docs/spec.md §20, the line span the note cites, whole',
    check(sourceText) {
      return (regionText, intro) => {
        const cite = citation(
          intro,
          /`docs\/spec\.md` lines (\d+)[–-](\d+)/gu,
          '`docs/spec.md` lines N–M',
        );
        const span = citedSpan(sourceText, Number(cite[1]), Number(cite[2]));
        // The note collapses §20's six-line `Store:` fence onto one line and joins the fields with
        // an interpunct, and says so. Removing that interpunct from the note's side restores
        // exactly the line breaks it replaced, which comparison form has already removed from the
        // source's side; the fence delimiters the note dropped with them come off the SOURCE's side,
        // which can only make this comparison fail. Nothing else is removed from either side, and
        // nothing at all is removed from the note's.
        return identical(
          withoutFenceDelimiters(span),
          regionText.split('·').join(''),
          `docs/spec.md ${cite[1]}-${cite[2]}, its fence delimiters aside`,
        );
      };
    },
  },
  'spec-22-closing': {
    arg: '--spec',
    describe: 'docs/spec.md §22, the two closing lines the note cites',
    check(sourceText) {
      return (regionText, intro) => {
        const cite = citation(
          intro,
          /`docs\/spec\.md` (\d+) and (\d+)/gu,
          '`docs/spec.md` N and M',
        );
        const span = citedSpan(sourceText, Number(cite[1]), Number(cite[2]));
        return identical(span, regionText, `docs/spec.md ${cite[1]}-${cite[2]}`);
      };
    },
  },
  'spec-47-criterion': {
    arg: '--spec',
    describe: 'docs/spec.md §47, the completion criterion, whole',
    check(sourceText) {
      const criterion = afterLabel(
        markdownSectionBody(sourceText, /^#\s+47\.\s/u),
        /^Completion criteria:\s*$/u,
      );
      return (regionText) => identical(criterion, regionText, "§47's completion criterion");
    },
  },
  'plan-426-must-answer': {
    arg: '--plan',
    describe: 'the development plan, the R-12 card line the note cites',
    check(sourceText) {
      return (regionText, intro) => {
        const cite = citation(
          intro,
          /`docs\/DEVELOPMENT_PLAN\.md:(\d+)`/gu,
          '`docs/DEVELOPMENT_PLAN.md:N`',
        );
        const line = Number(cite[1]);
        return prefixOf(
          citedSpan(sourceText, line, line),
          regionText,
          `DEVELOPMENT_PLAN.md:${line}`,
        );
      };
    },
  },
  'r01-no-probe-resumed': {
    arg: '--r01',
    describe: 'the R-01 research note, the two lines the region attributes',
    check(sourceText, sourcePath) {
      return (regionText) => {
        // Every attribution the region prints — `<file>:<line>` followed by a quoted span, in
        // straight quotes or in typographic ones — is checked against that file at that line. That
        // loop runs in one direction: it says each attributed span is in its source. The guard
        // below runs in the other, and is what makes this a classification rather than a search:
        // once the attributed entries and the block-quote markers are removed, what is left of the
        // region must be whitespace and nothing else. So a span that names no line cannot sit in
        // the region unchecked — not quoted in a style this regex does not read, not with no quote
        // marks at all, and not written in characters some narrower test would let through: round 4
        // required a straight double quote and missed a typographic one, and the letters-and-digits
        // test that replaced it let a leftover of punctuation, symbols or emoji through.
        const attribution = /`([A-Za-z0-9._-]+\.md):(\d+)`\s*—\s*(?:"([\s\S]*?)"|“([\s\S]*?)”)/gu;
        const found = [...regionText.matchAll(attribution)];
        if (found.length === 0)
          return { ok: false, detail: 'the region attributes no line of any file' };
        const leftover = regionText
          .replace(attribution, ' ')
          .split('\n')
          .map((line) => line.replace(/^\s*(?:>\s?)+/u, ''))
          .join('\n');
        if (leftover.trim() !== '') {
          return {
            ok: false,
            detail: {
              unattributedTextInRegion: leftover.replace(/\s+/gu, ' ').trim().slice(0, 160),
            },
          };
        }
        const checked = [];
        for (const [, file, lineNumber, straight, typographic] of found) {
          if (file !== basename(sourcePath)) {
            return {
              ok: false,
              detail: { attributesFile: file, butSourceSuppliedIs: basename(sourcePath) },
            };
          }
          const line = Number(lineNumber);
          const quoted = straight ?? typographic;
          const verdict = verbatimWithin(
            citedSpan(sourceText, line, line),
            quoted,
            `${file}:${line}`,
          );
          if (!verdict.ok)
            return { ok: false, detail: { at: `${file}:${line}`, ...verdict.detail } };
          checked.push(`${file}:${line}`);
        }
        return {
          ok: true,
          detail:
            `${checked.length} attributed span(s), each contiguous within its cited line, and nothing ` +
            `but whitespace beside them in the region: ${checked.join(', ')}`,
        };
      };
    },
  },
  'rfc6265bis-host-prefix': {
    arg: '--rfc',
    describe: 'draft-ietf-httpbis-rfc6265bis-22 §4.1.3.2, the `__Host-` paragraph, whole',
    check(sourceText) {
      return (regionText) => wholeParagraphOf(sourceText, regionText, 'the draft');
    },
  },
  'owasp-samesite': {
    arg: '--owasp',
    describe: 'OWASP Session Management Cheat Sheet, the SameSite paragraph, whole',
    check(sourceText) {
      return (regionText) => wholeParagraphOf(sourceText, regionText, 'the cheat sheet');
    },
  },
  'spec-22-ui-form': {
    arg: '--spec',
    describe: 'docs/spec.md §22, the user-visible key block, whole',
    check(sourceText) {
      const body = markdownSectionBody(sourceText, /^#\s+22\.\s/u);
      return (regionText) => wholeFenceOf(body, fenceContent(regionText, 'spec-22-ui-form'), '§22');
    },
  },
  'spec-22-field-list': {
    arg: '--spec',
    describe: 'docs/spec.md §22, the field list, whole',
    check(sourceText) {
      const body = markdownSectionBody(sourceText, /^#\s+22\.\s/u);
      return (regionText) =>
        wholeFenceOf(body, fenceContent(regionText, 'spec-22-field-list'), '§22');
    },
  },
  'sdk-cli-guard': {
    arg: '--exe',
    // A Windows executable is not UTF-8; latin1 maps every byte to one character, so the ASCII
    // fragment the note quotes survives the read and no byte is replaced.
    encoding: 'latin1',
    describe: 'claude.exe, the `--session-id` guard as extracted',
    check(sourceText) {
      // The note re-indents the extracted function across lines and says so; comparison form has
      // already removed every space from both sides, so this is the extraction character for
      // character apart from case. It is containment because the note quotes a fragment of a
      // binary and claims no boundary for it.
      return (regionText) =>
        verbatimWithin(
          sourceText,
          fenceContent(regionText, 'sdk-cli-guard'),
          'the shipped CLI binary',
        );
    },
  },
  'sdk-flag-emitter': {
    arg: '--mjs',
    describe: 'sdk.mjs, the one `--session-id` emission site',
    check(sourceText) {
      return (regionText) => {
        const quoted = fenceContent(regionText, 'sdk-flag-emitter');
        const within = verbatimWithin(sourceText, quoted, 'the shipped bundle');
        if (!within.ok) return within;
        // The note's claim is not only that this line is there but that it is the only place the
        // flag is emitted, so the occurrence count is part of what is checked. More than one, and
        // the sentence beside the block is false.
        const sites = sourceText.split('--session-id').length - 1;
        if (sites !== 1) {
          return { ok: false, detail: { sessionIdOccurrencesInBundle: sites, noteClaims: 1 } };
        }
        return {
          ok: true,
          detail: `${within.detail}; one \`--session-id\` occurrence in the bundle`,
        };
      };
    },
  },
  'sdk-sessionkey': {
    arg: '--dts',
    describe: 'sdk.d.ts `export declare type SessionKey`, whole declaration',
    check(sourceText) {
      return (regionText) =>
        identical(
          declarationBody(sourceText, 'export declare type SessionKey = {'),
          fenceContent(regionText, 'sdk-sessionkey'),
          'the shipped declaration',
        );
    },
  },
};

// --- the derived sets -------------------------------------------------------------------------
