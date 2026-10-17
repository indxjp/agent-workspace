import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const ranges = [
  ['20.6', /^## 20\.6\.1/mu, /^# 21\./mu],
  ['23', /^# 23\./mu, /^# 24\./mu],
  ['24', /^# 24\./mu, /^# 25\./mu],
  ['25', /^# 25\./mu, /^# 26\./mu],
  ['26', /^# 26\./mu, /^# 27\./mu],
] as const;

function markdownRows(document: string): string[][] {
  return document
    .split(/\r?\n/u)
    .filter((line) => line.startsWith('|') && line.endsWith('|'))
    .map((line) =>
      line
        .slice(1, -1)
        .split('|')
        .map((cell) => cell.trim()),
    )
    .filter((cells) => !cells.every((cell) => /^-+$/u.test(cell)));
}

function ruleLines(spec: string): { section: string; line: string }[] {
  const rules: { section: string; line: string }[] = [];
  for (const [section, startPattern, endPattern] of ranges) {
    const start = spec.search(startPattern);
    expect(start, `${section} start`).toBeGreaterThanOrEqual(0);
    const tail = spec.slice(start);
    const end = tail.search(endPattern);
    expect(end, `${section} end`).toBeGreaterThan(0);
    let fenced = false;
    for (const raw of tail.slice(0, end).split(/\r?\n/u)) {
      const line = raw.trim();
      if (line.startsWith('```')) {
        fenced = !fenced;
        continue;
      }
      if (fenced || !line || line.startsWith('#') || line === '---' || line.startsWith('|')) {
        continue;
      }
      rules.push({ section, line });
    }
  }
  return rules;
}

describe('Wave 8 security-review evidence', () => {
  it('pins and partitions every rule line of §20.6 and §23–§26', async () => {
    const [spec, review] = await Promise.all([
      readFile(new URL('../../docs/spec.md', import.meta.url), 'utf8'),
      readFile(new URL('../../docs/release/security-review-0.1.0.md', import.meta.url), 'utf8'),
    ]);
    const rules = ruleLines(spec);
    expect(rules).toHaveLength(58);
    const digest = createHash('sha256')
      .update(rules.map(({ section, line }) => `${section}\0${line}`).join('\n'))
      .digest('hex');
    expect(review).toContain(`sha256:${digest}`);

    const rows = markdownRows(review)
      .filter((cells) => /^§(?:20\.6|23|24|25|26)$/u.test(cells[0] ?? ''))
      .map((cells) => ({ section: cells[0]?.slice(1), bucket: cells[1] }));
    for (const section of ranges.map(([id]) => id)) {
      expect(
        rows.filter((row) => row.section === section),
        section,
      ).toHaveLength(1);
    }
    for (const rule of rules) {
      expect(
        rows.filter((row) => row.section === rule.section),
        `${rule.section}: ${rule.line}`,
      ).toHaveLength(1);
    }
  });

  it('gives every finding a command and a pasted output block', async () => {
    const review = await readFile(
      new URL('../../docs/release/security-review-0.1.0.md', import.meta.url),
      'utf8',
    );
    const rows = markdownRows(review)
      .filter((cells) => /^SEC-\d+$/u.test(cells[0] ?? ''))
      .map((cells) => [cells[0], cells[3], cells[4]] as const);
    expect(rows).toHaveLength(6);
    for (const [id, command, output] of rows) {
      const heading = `### ${command} / ${output}`;
      const start = review.indexOf(heading);
      expect(start).toBeGreaterThanOrEqual(0);
      const next = review.indexOf('\n### ', start + heading.length);
      const evidence = review.slice(start, next < 0 ? undefined : next);
      expect(evidence).toMatch(/```text[\s\S]+?```/u);
      expect(id).toMatch(/^SEC-/u);
    }
  });

  it('keeps the release blocked while any residual risk is unsigned', async () => {
    const review = await readFile(
      new URL('../../docs/release/security-review-0.1.0.md', import.meta.url),
      'utf8',
    );
    const riskRows = markdownRows(review).filter(
      (cells) =>
        /^RISK-\d+$/u.test(cells[0] ?? '') &&
        /^(?:Low|Medium|High|Critical)$/u.test(cells[1] ?? '') &&
        (cells.at(-1) ?? '') === '',
    );
    expect(riskRows.length).toBeGreaterThan(0);
    expect(review).toContain('Acceptance status: **not accepted**');
    expect(review).toContain('Release blocked until\nsigned');
  });

  it('proves rather than assumes the D-06 runnable-link default-deny control', async () => {
    const review = await readFile(
      new URL('../../docs/release/security-review-0.1.0.md', import.meta.url),
      'utf8',
    );
    expect(review).toContain('apps/web/app/p/[token]/messages/route.ts');
    expect(review).toContain('apps/web/server/shares/runnable/feature.ts');
    expect(review).toContain('fail closed by default');
    expect(review).toContain('the release-boundary research note');
  });
});
