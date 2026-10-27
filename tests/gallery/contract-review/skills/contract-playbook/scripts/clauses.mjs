#!/usr/bin/env node
/* global process */ // The root ESLint config declares no environment globals.
// contract-playbook: split a Japanese contract into 第N条 clauses and run the playbook's
// deterministic detectors over it. Node alone, no packages, so it runs inside a run's sandbox.
//
//   node clauses.mjs split <paragraphs.json | ->                    → { title, preamble, clauses }
//   node clauses.mjs check <paragraphs.json | -> [--playbook <dir>] → { title, clauses, findings }
//   node clauses.mjs redline <paragraphs.json> --playbook <dir>
//                                       → the draft plus 【修正案】, printed to stdout only
//
// This script opens no Word file: the input is what the built-in office-reader skill prints for a
// .docx (`{ paragraphs: [{ style, text }] }`), saved to a file, and `redline` prints the same shape,
// which office-reader's `ooxml.mjs write` turns back into a .docx:
//
//   node scripts/clauses.mjs check drafts/契約書.json --playbook playbook
//
// The detectors are deliberately simple: regular expressions and keywords over each clause, each
// explained beside its code. They are not the review. They are the floor under it: a finding with
// `mustFlag: true` is one the reviewing agent must put in its risk table, and the backend checks
// that it did. A detector may over-report (the agent then explains why the risk is low); it must
// not miss a clause written the way the fixtures write it.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// ---------- clauses ----------

const KANJI_DIGITS = { 〇: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/** 「十二」→ 12, 「二十一」→ 21, 「8」→ 8. Numbers up to 999, as clause numbers are. */
export function clauseNumber(written) {
  if (/^\d+$/u.test(written)) return Number(written);
  let total = 0;
  let current = 0;
  for (const char of written) {
    if (char === '百') {
      total += (current || 1) * 100;
      current = 0;
    } else if (char === '十') {
      total += (current || 1) * 10;
      current = 0;
    } else if (char in KANJI_DIGITS) {
      current = KANJI_DIGITS[char];
    } else {
      return Number.NaN;
    }
  }
  return total + current;
}

/**
 * Text for matching: NFKC folds full-width digits and brackets (「第８条（目的）」→「第8条(目的)」),
 * so every pattern below is written once, with ASCII digits and parentheses.
 */
export const normalize = (text) => text.normalize('NFKC').replace(/\s+/gu, ' ').trim();

// 「第N条」, an optional 「（見出し）」 (which may hold one more pair, 「（知的財産権（IP））」), then the end or a space before the clause's first sentence.
// The space matters: 「第2条及び第3条に定める義務は…」 is a sentence that cites clauses, not a heading.
const HEADING =
  /^第\s*([0-9〇一二三四五六七八九十百]+)\s*条\s*(?:\(((?:[^()]|\([^()]*\))*)\))?(?:\s+(.*))?$/u;
/** The signature block after the last clause: it is not part of that clause. */
const TAIL = /^(本契約の(成立|締結)を証するため|以上$|\(以下余白\))/u;

/**
 * Split office-reader paragraphs into the title, the preamble and the clauses. A clause starts at
 * a paragraph that begins 「第N条」, whatever its style (drafts often type headings as body text),
 * and runs to the next one. A heading's own trailing text (「第1条（目的） 本契約は…」) is the
 * clause's first sentence.
 */
export function splitClauses(paragraphs) {
  const texts = paragraphs.map((paragraph) => paragraph.text.trim()).filter((text) => text !== '');
  const clauses = [];
  const preamble = [];
  let title = '';
  let ended = false;
  for (const text of texts) {
    const heading = HEADING.exec(normalize(text));
    if (heading !== null) {
      const number = clauseNumber(heading[1]);
      clauses.push({
        number,
        label: `第${String(number)}条`,
        heading: heading[2]?.trim() ?? '',
        paragraphs: heading[3] === undefined || heading[3] === '' ? [] : [heading[3]],
      });
      ended = false;
      continue;
    }
    const current = clauses.at(-1);
    if (current === undefined) {
      if (title === '') title = text;
      else preamble.push(text);
    } else if (ended || TAIL.test(normalize(text))) {
      ended = true;
    } else {
      current.paragraphs.push(text);
    }
  }
  return {
    title,
    preamble,
    clauses: clauses.map(({ paragraphs: body, ...clause }) => ({
      ...clause,
      text: body.join('\n'),
    })),
  };
}

// ---------- detectors ----------

/** A clause's sentences, normalized, with the heading in front so a rule can read both. */
function sentences(clause) {
  // Split at 。 outside brackets: 「（…を含む。）」 is part of the sentence around it.
  const found = [];
  let depth = 0;
  let current = '';
  for (const char of normalize(clause.text)) {
    current += char;
    if (char === '(' || char === '「') depth += 1;
    else if ((char === ')' || char === '」') && depth > 0) depth -= 1;
    else if (char === '。' && depth === 0) {
      found.push(current.trim());
      current = '';
    }
  }
  if (current.trim() !== '') found.push(current.trim());
  return found;
}

const excerpt = (sentence) => (sentence.length > 140 ? `${sentence.slice(0, 139)}…` : sentence);

/**
 * Each detector reads one clause (`each`) or the whole contract (`whole`) and returns findings
 * without a rule id; the id, severity and must-flag come from the detector itself.
 */
export const DETECTORS = [
  {
    rule: 'PB-01',
    topic: '損害賠償の上限',
    severity: '高',
    mustFlag: true,
    // A sentence that imposes liability (賠償 …, but not 「賠償する責任を負わない」, which is an
    // exemption) in a clause that nowhere caps it (上限・限度・を超えない). 「一切の損害」「逸失利益」
    // 「弁護士費用」 widen the scope and are named in the reason.
    explain: '賠償を定める文があり、同じ条に上限（上限・限度・を超えない）の定めがない。',
    each(clause) {
      const imposing = sentences(clause).filter(
        (sentence) =>
          /賠償/u.test(sentence) && !/(責任を負わない|請求することができない|免責)/u.test(sentence),
      );
      if (imposing.length === 0 || /反社会的勢力|暴力団/u.test(clause.text)) return [];
      if (/上限|限度|を超えない|を超えるものではない/u.test(normalize(clause.text))) return [];
      const widened = normalize(clause.text).match(/一切の損害|逸失利益|弁護士費用|間接損害/gu);
      return [
        {
          evidence: excerpt(imposing[0]),
          reason:
            widened === null
              ? '賠償額の上限の定めがない。'
              : `賠償額の上限の定めがなく、賠償範囲を「${[...new Set(widened)].join('」「')}」まで広げている。`,
        },
      ];
    },
  },
  {
    rule: 'PB-02',
    topic: '準拠法・管轄',
    severity: '高',
    mustFlag: true,
    // A governing-law sentence (〜法に準拠) that does not name Japanese law, or a forum abroad
    // (a foreign court or arbitration seat). Japanese law is 日本法・日本国法・日本国の法令.
    explain: '準拠法の文が日本法を指定していない、または外国の裁判所・仲裁を指定している。',
    each(clause) {
      const found = [];
      for (const sentence of sentences(clause)) {
        const law = /([^\s、。「」()]{1,20}?法(?:令)?)に(?:準拠|従って解釈)/u.exec(sentence);
        if (law !== null && !/日本(?:国)?(?:の)?法/u.test(law[1])) {
          found.push({
            evidence: excerpt(sentence),
            reason: `準拠法が日本法ではない（「${law[1]}」）。`,
          });
          continue;
        }
        const forum =
          /((?:シンガポール|ニューヨーク|ロンドン|香港|カリフォルニア|デラウェア|米国|英国|中国|中華人民共和国)[^、。]*?(?:裁判所|仲裁(?:機関|廷)?))/u.exec(
            sentence,
          );
        if (forum !== null) {
          found.push({
            evidence: excerpt(sentence),
            reason: `紛争解決地が国外である（「${forum[1]}」）。`,
          });
        }
      }
      return found;
    },
    // No governing-law clause at all is worth a note, but it is not a must-flag: Japanese courts
    // then decide the law under 法の適用に関する通則法.
    whole(clauses) {
      if (clauses.some((clause) => /準拠/u.test(normalize(clause.text)))) return [];
      return [
        {
          clause: null,
          kind: 'absent',
          severity: '中',
          mustFlag: false,
          evidence: '',
          reason: '準拠法の定めがない。',
        },
      ];
    },
  },
  {
    rule: 'PB-03',
    topic: '一方的な解除権',
    severity: '高',
    mustFlag: true,
    // A termination sentence with an at-will trigger (いつでも・理由の如何を問わず・自己の都合) whose
    // subject is one party only (甲は / 乙は), not both (甲及び乙・各当事者・いずれの当事者).
    explain: '「いつでも」「理由の如何を問わず」等で解除・解約できる主体が一方の当事者だけである。',
    each(clause) {
      return sentences(clause)
        .filter(
          (sentence) =>
            /(解除|解約)/u.test(sentence) &&
            /(いつでも|理由の如何を問わず|理由を問わず|何らの理由なく|自己の都合により|任意に)/u.test(
              sentence,
            ) &&
            !/(甲及び乙|甲又は乙|甲または乙|乙及び甲|各当事者|いずれの当事者|両当事者)/u.test(
              sentence,
            ),
        )
        .flatMap((sentence) => {
          const party = /(甲|乙)は/u.exec(sentence)?.[1];
          return party === undefined
            ? []
            : [
                {
                  evidence: excerpt(sentence),
                  reason: `${party}だけが理由を問わず解除できる（相手方に同じ権利がない）。`,
                },
              ];
        });
    },
  },
  {
    rule: 'PB-04',
    topic: '知的財産権（バックグラウンドIP）',
    severity: '高',
    mustFlag: true,
    // An assignment sentence (知的財産権・著作権・特許 + 譲渡・帰属・移転) that reaches IP held before
    // or outside the contract (従前・既存・締結前・保有する一切). Exclusions in parentheses
    // (「（…を除く。）」) are removed first, so the standard clause, which names background IP only
    // to exclude it, does not fire.
    explain:
      '譲渡・帰属の文が、契約前から保有する知的財産権（従前・既存・締結前）まで対象にしている。',
    each(clause) {
      return sentences(clause)
        .map((sentence) => ({
          sentence,
          stripped: sentence.replace(/\([^()]*を除く。?\)/gu, ''),
        }))
        .filter(
          ({ stripped }) =>
            /(知的財産権|著作権|特許権|ノウハウ)/u.test(stripped) &&
            /(譲渡|帰属|移転)/u.test(stripped) &&
            /(従前|既存|締結前|保有する一切|保有するすべて|バックグラウンド)/u.test(stripped),
        )
        .map(({ sentence }) => ({
          evidence: excerpt(sentence),
          reason:
            '契約前から保有する知的財産権（バックグラウンドIP）まで譲渡・帰属の対象にしている。',
        }));
    },
  },
  {
    rule: 'PB-05',
    topic: '自動更新と更新拒絶の通知',
    severity: '中',
    mustFlag: true,
    // A renewal sentence (自動更新・自動的に更新・同一条件で…更新) in a clause with no notice window
    // (「N か月前までに … 申出・通知・申入れ」).
    explain:
      '自動更新の定めがあり、同じ条に「○か月前までの通知（申出）」による更新拒絶の定めがない。',
    each(clause) {
      const text = normalize(clause.text);
      const renewal = sentences(clause).find((sentence) =>
        /自動(?:的に)?(?:更新|延長)|同一条件で[^。]*?(?:更新|延長)/u.test(sentence),
      );
      if (renewal === undefined) return [];
      if (
        /(\d+|[一二三四五六])\s*(か月|ヶ月|カ月|箇月|日)前までに[^。]*?(申出|申し出|通知|申入れ|申し入れ)/u.test(
          text,
        )
      )
        return [];
      return [
        {
          evidence: excerpt(renewal),
          reason: '自動更新されるが、期間満了前の通知で更新を拒絶する定めがない。',
        },
      ];
    },
  },
  {
    rule: 'PB-06',
    topic: '反社会的勢力の排除',
    severity: '高',
    mustFlag: true,
    // An absence, not a clause: no clause anywhere mentions 反社会的勢力 or 暴力団.
    explain: 'どの条にも「反社会的勢力」「暴力団」の語がない（条項の欠落）。',
    whole(clauses) {
      const present = clauses.some((clause) =>
        /反社会的勢力|暴力団/u.test(`${clause.heading} ${normalize(clause.text)}`),
      );
      return present
        ? []
        : [
            {
              clause: null,
              kind: 'absent',
              evidence: '',
              reason: '反社会的勢力の排除条項がない。',
            },
          ];
    },
  },
  {
    rule: 'PB-07',
    topic: '秘密保持義務の存続期間',
    severity: '中',
    mustFlag: false,
    // A confidentiality sentence (秘密・機密・義務) whose duty lasts forever (永久・無期限・期間の定めなく).
    explain: '秘密保持義務が「永久」「無期限」に存続する。',
    each(clause) {
      return sentences(clause)
        .filter(
          (sentence) =>
            /(秘密|機密|義務)/u.test(sentence) &&
            /(永久|無期限|期間の定めなく|期限の定めなく)/u.test(sentence),
        )
        .map((sentence) => ({
          evidence: excerpt(sentence),
          reason: '秘密保持義務が期限なく存続する。',
        }));
    },
  },
  {
    rule: 'PB-08',
    topic: '支払期日',
    severity: '中',
    mustFlag: false,
    // A payment sentence (支払・支払う) due later than 60 days: 「翌々月」, or 「N 日以内／後」 with
    // N over 60.
    explain: '支払期日が「翌々月」払い、または60日を超える日数である。',
    each(clause) {
      return sentences(clause)
        .filter((sentence) => /支払/u.test(sentence))
        .flatMap((sentence) => {
          if (/翌々月/u.test(sentence))
            return [{ evidence: excerpt(sentence), reason: '翌々月払いで、60日を超えうる。' }];
          const days = /(\d+)\s*日(?:以内|後|を経過)/u.exec(sentence);
          if (days !== null && Number(days[1]) > 60)
            return [
              {
                evidence: excerpt(sentence),
                reason: `支払期日が${days[1]}日で、60日を超える。`,
              },
            ];
          return [];
        });
    },
  },
  {
    rule: 'PB-09',
    topic: '再委託',
    severity: '低',
    mustFlag: false,
    // A subcontracting permission (再委託 … できる) that needs no consent, or says so outright
    // (「承諾を得ることなく」「承諾なく」).
    explain: '承諾なく再委託できる。',
    each(clause) {
      return sentences(clause)
        .filter(
          (sentence) =>
            /再委託/u.test(sentence) &&
            /できる/u.test(sentence) &&
            (!/(承諾|同意)/u.test(sentence) ||
              /(承諾|同意)(?:を得ること)?(?:なく|なしに)/u.test(sentence)),
        )
        .map((sentence) => ({
          evidence: excerpt(sentence),
          reason: '相手方が当社の承諾なく第三者に再委託できる。',
        }));
    },
  },
];

// ---------- playbook ----------

/**
 * Read `<dir>/*.md` playbook rules: front matter (id, title, severity, mustFlag) and the text under
 * 「## 標準条項」. The check attaches each rule's standard clause to its findings, so the agent's
 * 修正文案 starts from the company's wording.
 */
export function loadPlaybook(dir) {
  const rules = new Map();
  for (const name of readdirSync(dir)
    .filter((file) => file.endsWith('.md'))
    .sort()) {
    const markdown = readFileSync(path.join(dir, name), 'utf8');
    const front = /^---\n([\s\S]*?)\n---\n/u.exec(markdown);
    const meta = Object.fromEntries(
      (front?.[1] ?? '').split('\n').map((line) => {
        const at = line.indexOf(':');
        return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
      }),
    );
    const section = (heading) =>
      new RegExp(`## ${heading}\\n+([\\s\\S]*?)(?:\\n## |$)`, 'u')
        .exec(markdown)?.[1]
        ?.replace(/\n/gu, '')
        .trim() ?? '';
    if (typeof meta.id !== 'string' || !/^PB-\d{2}$/u.test(meta.id))
      throw new Error(`${name}: front matter needs an id like PB-01`);
    rules.set(meta.id, {
      id: meta.id,
      title: meta.title ?? '',
      severity: meta.severity ?? '',
      mustFlag: meta.mustFlag === 'true',
      criteria: section('審査基準'),
      standard: section('標準条項'),
      file: name,
    });
  }
  return rules;
}

// ---------- check ----------

/**
 * Run every detector over `paragraphs` (office-reader output). Each finding carries the rule id,
 * the clause (「第8条」, or `null` for an absence), the sentence that fired, and why. With a
 * playbook, it also carries the rule's title and 標準条項.
 */
export function check(paragraphs, playbook = null) {
  const document = splitClauses(paragraphs);
  const findings = [];
  for (const detector of DETECTORS) {
    const base = {
      rule: detector.rule,
      topic: detector.topic,
      severity: detector.severity,
      mustFlag: detector.mustFlag,
    };
    for (const clause of document.clauses) {
      for (const hit of detector.each?.(clause) ?? []) {
        findings.push({
          ...base,
          clause: clause.label,
          heading: clause.heading,
          kind: 'present',
          ...hit,
        });
      }
    }
    for (const hit of detector.whole?.(document.clauses) ?? []) {
      findings.push({ ...base, heading: '', ...hit });
    }
  }
  // One finding per rule and clause: a second sentence that fires the same rule in the same
  // clause adds its reason, not a second row.
  const merged = [];
  for (const finding of findings) {
    const same = merged.find(
      (seen) => seen.rule === finding.rule && seen.clause === finding.clause,
    );
    if (same === undefined) merged.push(finding);
    else if (!same.reason.includes(finding.reason)) same.reason = `${same.reason}${finding.reason}`;
  }
  return {
    title: document.title,
    clauses: document.clauses.map(({ label, heading }) => ({ label, heading })),
    findings: merged.map((finding) => {
      const rule = playbook?.get(finding.rule);
      return rule === undefined
        ? finding
        : { ...finding, topic: rule.title, standard: rule.standard };
    }),
  };
}

// ---------- redline ----------

/**
 * The draft's paragraphs followed by a 【修正案】 block: one paragraph per finding the playbook says
 * must be raised (or rates 高), holding the playbook's standard clause. The agent tailors the
 * parties and amounts in its table; this file is the draft with the standard wording attached.
 */
export function redline(paragraphs, result) {
  const proposals = result.findings.filter(
    (finding) => finding.standard !== undefined && (finding.mustFlag || finding.severity === '高'),
  );
  if (proposals.length === 0) return paragraphs;
  return [
    ...paragraphs,
    { style: null, text: '【修正案】' },
    ...proposals.map((finding) => ({
      style: null,
      text: `【修正案 ${finding.rule}】${finding.clause ?? '欠落'} ${finding.standard}`,
    })),
  ];
}

// ---------- command line ----------

function readParagraphs(source) {
  if (source?.endsWith('.docx'))
    throw new Error(
      `${source} is a Word file: read it with the office-reader skill (ooxml.mjs docx) and pass the JSON it prints`,
    );
  const text = readFileSync(source === undefined || source === '-' ? 0 : source, 'utf8');
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed?.paragraphs))
    throw new Error('input must be office-reader docx JSON: { "paragraphs": [...] }');
  return parsed.paragraphs;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  const command = args[0];
  const at = args.indexOf('--playbook');
  const playbookDir = at === -1 ? undefined : args[at + 1];
  const rest = args.slice(1);
  const source = rest.find(
    (arg, index) => arg !== '--playbook' && rest[index - 1] !== '--playbook',
  );
  try {
    if (command === 'split') {
      process.stdout.write(`${JSON.stringify(splitClauses(readParagraphs(source)), null, 2)}\n`);
    } else if (command === 'check') {
      const playbook = playbookDir === undefined ? null : loadPlaybook(playbookDir);
      process.stdout.write(`${JSON.stringify(check(readParagraphs(source), playbook), null, 2)}\n`);
    } else if (command === 'redline') {
      if (source === undefined || playbookDir === undefined)
        throw new Error('usage: clauses.mjs redline <paragraphs.json> --playbook <dir>');
      const paragraphs = readParagraphs(source);
      const proposed = redline(paragraphs, check(paragraphs, loadPlaybook(playbookDir)));
      // Printed only: the redline reaches disk through the agent's gated Write, never from here.
      process.stdout.write(`${JSON.stringify({ paragraphs: proposed }, null, 2)}\n`);
    } else {
      process.stderr.write(
        'usage: clauses.mjs split <paragraphs.json|-> | check <paragraphs.json|-> [--playbook <dir>] | redline <paragraphs.json> --playbook <dir>\n',
      );
      process.exitCode = 2;
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
