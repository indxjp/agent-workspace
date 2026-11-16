import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { readDocx } from '@agent-workspace/skills-office/office-reader/scripts/ooxml.mjs';
import {
  contractPath,
  DRAFTS,
  NDA,
  SERVICE_AGREEMENT,
  SUPPLY_AGREEMENT,
  type Draft,
} from './data/drafts.ts';
import {
  check,
  DETECTORS,
  splitClauses,
  type DocxParagraph,
  type PlaybookRule,
  type SplitDocument,
} from './skills/contract-playbook/scripts/clauses.mjs';
import {
  DATA,
  PLAYBOOK,
  node,
  paragraphsInSandbox,
  checkInSandbox,
  pairs,
} from './contract-review.fixture.test-support.ts';
export function definePlaybookCases(): void {
  it('clauses.mjs splits each Word draft, as office-reader reads it, into 第N条 clauses', () => {
    const split = (draft: Draft): SplitDocument =>
      JSON.parse(
        node(
          'contract-playbook/scripts/clauses.mjs',
          ['split', '-'],
          JSON.stringify(readDocx(readFileSync(path.join(DATA, contractPath(draft))))),
        ),
      ) as SplitDocument;

    const service = split(SERVICE_AGREEMENT);
    // The agent's own call has no pipe: it passes the file it saved with `Write`.
    expect(
      JSON.parse(
        node('contract-playbook/scripts/clauses.mjs', [
          'split',
          paragraphsInSandbox(contractPath(SERVICE_AGREEMENT)),
        ]),
      ),
    ).toStrictEqual(service);
    expect(service.title).toBe('業務委託契約書');
    expect(service.preamble[0]).toContain('株式会社ミナトシステムズ（以下「甲」という。）');
    expect(service.clauses.map((clause) => clause.label)).toStrictEqual(
      Array.from({ length: 10 }, (_, index) => `第${String(index + 1)}条`),
    );
    expect(service.clauses[5]).toMatchObject({ heading: '損害賠償' });
    // The signature line after the last clause is not part of 第10条.
    expect(service.clauses[9]?.text).not.toContain('記名押印');

    // Full-width numbers typed as body text, and a sentence that cites 「第２条及び第３条」.
    const nda = split(NDA);
    expect(nda.clauses.map((clause) => clause.label)).toStrictEqual(
      Array.from({ length: 8 }, (_, index) => `第${String(index + 1)}条`),
    );
    expect(nda.clauses[5]?.text).toContain('第２条及び第３条に定める義務は');

    // Kanji numbers, and a heading with its first sentence on the same line.
    const supply = split(SUPPLY_AGREEMENT);
    expect(supply.clauses.at(-1)).toMatchObject({ label: '第11条', heading: '準拠法及び管轄' });
    expect(supply.clauses[0]).toMatchObject({ label: '第1条', heading: '目的' });
    expect(supply.clauses[0]?.text).toMatch(/^本契約は、甲乙間の本製品/u);

    expect(() =>
      node('contract-playbook/scripts/clauses.mjs', ['split', '-'], '{"rows":[]}'),
    ).toThrow(/office-reader docx JSON/u);
  });

  it('clauses.mjs opens no Word file: a .docx argument is refused by name', () => {
    for (const command of ['split', 'check']) {
      expect(() =>
        node('contract-playbook/scripts/clauses.mjs', [command, contractPath(NDA)]),
      ).toThrow(/is a Word file: read it with the office-reader skill/u);
    }
  });

  it('the check finds every planted issue in the three drafts, each citing its playbook rule', () => {
    for (const draft of DRAFTS) {
      const result = checkInSandbox(contractPath(draft));
      expect(pairs(result).sort(), draft.file).toStrictEqual([...draft.planted].sort());
    }
    const service = checkInSandbox(contractPath(SERVICE_AGREEMENT));
    expect(service.findings.filter((finding) => finding.mustFlag).map((f) => f.rule)).toStrictEqual(
      ['PB-01', 'PB-03', 'PB-04', 'PB-05', 'PB-06'],
    );
    const liability = service.findings.find((finding) => finding.rule === 'PB-01');
    expect(liability?.reason).toContain('「逸失利益」');
    expect(liability?.standard).toContain('対価の総額を上限とする');
    const law = checkInSandbox(contractPath(NDA)).findings.find((f) => f.rule === 'PB-02');
    expect(law?.reason).toContain('「米国ニューヨーク州法」');
    expect(law?.reason).toContain('裁判所');
  });

  it('the playbook standard clauses pass every detector, and a missing 反社 clause is an absence', () => {
    // The playbook and the detectors name the same rules, with the same must-flags.
    expect([...PLAYBOOK.keys()]).toStrictEqual(DETECTORS.map((detector) => detector.rule));
    for (const detector of DETECTORS) {
      expect(PLAYBOOK.get(detector.rule)?.mustFlag, detector.rule).toBe(detector.mustFlag);
      expect(PLAYBOOK.get(detector.rule)?.standard, detector.rule).not.toBe('');
    }

    // A contract written entirely in the company's standard clauses raises nothing.
    const contractOf = (rules: readonly PlaybookRule[]): DocxParagraph[] => [
      { style: 'Title', text: '標準契約書' },
      ...rules.flatMap((rule, index) => [
        { style: 'Heading2', text: `第${String(index + 1)}条（${rule.title}）` },
        { style: null, text: rule.standard },
      ]),
    ];
    const rules = [...PLAYBOOK.values()];
    const standard = contractOf(rules);
    expect(splitClauses(standard).clauses).toHaveLength(rules.length);
    expect(check(standard).findings).toStrictEqual([]);

    // Leave out only the 反社 clause: the check reports its absence, with no clause to point at.
    const absent = check(contractOf(rules.filter((rule) => rule.id !== 'PB-06'))).findings;
    expect(absent).toMatchObject([
      { rule: 'PB-06', clause: null, kind: 'absent', mustFlag: true, severity: '高' },
    ]);
  });
}
