// actionlint only knows GitHub's hosted runner labels, so `.github/actionlint.yaml` lists every other
// label a workflow's `runs-on` names. A label missing there makes actionlint report each job that
// uses it as an unknown runner (#1835).
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '..');
const WORKFLOWS = path.join(ROOT, '.github/workflows');
const HOSTED = /^(?:ubuntu|windows|macos)-(?:latest|\d+(?:\.\d+)?)(?:-arm)?$/u;

const indent = (line: string): number => line.length - line.trimStart().length;

/** A block-list's `- item` values, read from the lines after its key. */
function blockList(lines: readonly string[]): string[] {
  const items: string[] = [];
  for (const next of lines) {
    const item = /^\s*-\s+(.+)$/u.exec(next)?.[1];
    if (item === undefined) break;
    items.push(item.replace(/^["']|["']$/gu, ''));
  }
  return items;
}

/** The values a job's matrix gives `key`: each `key:` line in the job, inline or as a block list. */
function matrixValues(job: readonly string[], key: string): string[] {
  const pattern = new RegExp(`^\\s*(?:-\\s+)?${key}:\\s*(.*)$`, 'u');
  return job.flatMap((line, index) => {
    const value = pattern.exec(line)?.[1]?.trim();
    if (value === undefined) return [];
    if (value === '') return [`[${blockList(job.slice(index + 1)).join(',')}]`];
    return [value.replace(/^["']|["']$/gu, '')];
  });
}

/**
 * Each `runs-on` value: an inline one as written, a bare `runs-on:` as the `[a, b]` list its
 * block-list `- label` lines spell, and `${{ matrix.<key> }}` as each value the job's matrix gives
 * that key.
 */
function runsOnValues(workflow: string): string[] {
  const lines = workflow.split('\n');
  return lines.flatMap((line, index) => {
    const value = /^\s*runs-on:\s*(.*)$/u.exec(line)?.[1]?.trim();
    if (value === undefined) return [];
    if (value === '') return [`[${blockList(lines.slice(index + 1)).join(',')}]`];
    const key = /^\$\{\{\s*matrix\.([A-Za-z0-9_-]+)\s*\}\}$/u.exec(value)?.[1];
    if (key === undefined) return [value];
    // The job is every line around runs-on indented at least as deep as it.
    const depth = indent(line);
    const inJob = (other: string) => other.trim() === '' || indent(other) >= depth;
    let start = index;
    while (start > 0 && inJob(lines[start - 1] ?? '')) start -= 1;
    let end = index + 1;
    while (end < lines.length && inJob(lines[end] ?? '')) end += 1;
    return matrixValues(lines.slice(start, end), key);
  });
}

/** The literal runner labels in a workflow's `runs-on` values, the hosted ones left out. */
function customLabels(workflow: string): string[] {
  const labels = new Set<string>();
  for (const value of runsOnValues(workflow)) {
    const literals = value.startsWith('[')
      ? value.replace(/[[\]]/gu, '').split(',')
      : value.startsWith('${{')
        ? Array.from(value.matchAll(/["']([a-z0-9][a-z0-9.-]*)["']/gu), (match) => match[1] ?? '')
        : [value];
    for (const label of literals.map((literal) => literal.trim())) {
      if (label !== '' && label !== 'self-hosted' && !HOSTED.test(label) && !label.includes('$')) {
        labels.add(label);
      }
    }
  }
  return [...labels].sort();
}

function configuredLabels(): string[] {
  const config = readFileSync(path.join(ROOT, '.github/actionlint.yaml'), 'utf8');
  return Array.from(config.matchAll(/^ {4}- ([a-z0-9][a-z0-9.-]*)$/gmu), (match) => match[1] ?? '');
}

describe('actionlint config', () => {
  it('reads labels from every runs-on form', () => {
    expect(
      customLabels(
        [
          'runs-on: [self-hosted, ms-a2]',
          `runs-on: \${{ github.repository_owner == 'INDXDev' && fromJSON('["self-hosted","pool-b"]') || 'ubuntu-latest' }}`,
          `runs-on: \${{ github.repository_owner == 'INDXDev' && 'vendor-4vcpu' || 'windows-latest' }}`,
          'runs-on: ${{ matrix.os }}',
          'runs-on: ubuntu-24.04',
          '    runs-on:',
          '      - self-hosted',
          "      - 'pool-c'",
          '    steps:',
          '      - run: echo',
        ].join('\n'),
      ),
    ).toEqual(['ms-a2', 'pool-b', 'pool-c', 'vendor-4vcpu']);
    expect(
      customLabels(
        [
          'jobs:',
          '  claims:',
          '    runs-on: ${{ matrix.os }}',
          '    strategy:',
          '      matrix:',
          '        include:',
          '          - lane: ubuntu',
          '            os: [self-hosted, ms-a2]',
          "          - os: 'vendor-6vcpu-macos'",
          '            machine: host',
          '          - os: ubuntu-24.04',
          '        arch:',
          '          - pool-x',
          '  other:',
          '    runs-on: ubuntu-latest',
          '    strategy:',
          '      matrix:',
          '        os: [pool-not-this-job]',
        ].join('\n'),
      ),
    ).toEqual(['ms-a2', 'vendor-6vcpu-macos']);
  });

  it('lists every self-hosted and vendor label the workflows use', () => {
    const used = new Set(
      readdirSync(WORKFLOWS)
        .filter((file) => /\.ya?ml$/u.test(file))
        .flatMap((file) => customLabels(readFileSync(path.join(WORKFLOWS, file), 'utf8'))),
    );
    expect(used).toContain('ms-a2');
    const configured = configuredLabels();
    expect([...used].filter((label) => !configured.includes(label))).toEqual([]);
  });
});
