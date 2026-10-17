import { readFile, readdir } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

type Step = {
  title: string;
  surface: string;
  target: string;
  success: string;
  timing: string;
  confusion: string;
};

function fencedSteps(source: string): string[] {
  const section = source.slice(source.search(/^# 55\.\s/mu));
  const block = /```text\s*\r?\n([\s\S]*?)```/u.exec(section)?.[1];
  if (!block) throw new Error('spec §55 workflow fence is missing');
  return block
    .trim()
    .split(/\r?\n/u)
    .map((line) => line.replace(/^\d+\.\s*/u, '').trim());
}

function scriptSteps(source: string): Step[] {
  return [
    ...source.matchAll(
      /^## \d+\. (.+)\r?\n\r?\nSurface: `([^`]+)` · Target: `([^`]+)`\s{2}\r?\nSuccess: (.+)\s{2}\r?\nTiming: (.+)\s{2}\r?\nConfusion: `([^`]+)`/gmu,
    ),
  ].map((match) => ({
    title: match[1]!,
    surface: match[2]!,
    target: match[3]!,
    success: match[4]!,
    timing: match[5]!,
    confusion: match[6]!,
  }));
}

async function shippedRoutes(): Promise<Set<string>> {
  const directory = new URL('../screen-declarations/', import.meta.url);
  const files = (await readdir(directory)).filter((file) => file.endsWith('.ts'));
  const routes = new Set<string>();
  for (const file of files) {
    const source = await readFile(new URL(file, directory), 'utf8');
    for (const match of source.matchAll(/status:\s*'shipped'[\s\S]{0,180}?route:\s*'([^']+)'/gu)) {
      routes.add(match[1]!);
    }
  }
  return routes;
}

describe('Wave 8 §55 walk-through instrument', () => {
  it('derives exactly the ten spec titles in order and carries every observable field', async () => {
    const [spec, script] = await Promise.all([
      readFile(new URL('../../docs/spec.md', import.meta.url), 'utf8'),
      readFile(new URL('../../docs/walkthrough/script.md', import.meta.url), 'utf8'),
    ]);
    const steps = scriptSteps(script);
    expect(steps.map((step) => step.title)).toEqual(fencedSteps(spec));
    expect(steps).toHaveLength(10);
    for (const [index, step] of steps.entries()) {
      expect(['screen', 'terminal', 'browser']).toContain(step.surface);
      expect(step.success).not.toBe('');
      expect(step.timing).toMatch(/Start .+ Stop/u);
      expect(step.confusion).toBe(`C${String(index + 1).padStart(2, '0')}`);
    }
  });

  it('allows exactly the first two steps to be non-screen and validates every shipped target', async () => {
    const script = await readFile(
      new URL('../../docs/walkthrough/script.md', import.meta.url),
      'utf8',
    );
    const steps = scriptSteps(script);
    expect(steps.filter((step) => step.surface !== 'screen').map((step) => step.surface)).toEqual([
      'terminal',
      'browser',
    ]);
    const routes = await shippedRoutes();
    const missing = steps
      .filter((step) => step.surface === 'screen' && !routes.has(step.target))
      .map((step) => step.target);
    // Wave 2c has not landed; keeping this exact list makes the inherited blocker visible and
    // turns any additional missing surface into a regression instead of silently passing it.
    expect(missing).toEqual([]);
  });

  it('contains no source-facing command or repository vocabulary in participant prose', async () => {
    const script = await readFile(
      new URL('../../docs/walkthrough/script.md', import.meta.url),
      'utf8',
    );
    const participantText = script
      .split(/\r?\n/u)
      .filter((line) => !/^(Surface|Success|Timing|Confusion):/u.test(line))
      .join('\n');
    for (const denied of ['pnpm', 'docker', 'git', '.ts', 'apps/', 'packages/']) {
      expect(participantText.toLowerCase()).not.toContain(denied);
    }
  });

  it('states that no human performance has occurred and D-13 governs it', async () => {
    const readme = await readFile(
      new URL('../../docs/walkthrough/README.md', import.meta.url),
      'utf8',
    );
    const firstParagraph = readme.split(/\r?\n\r?\n/u)[1] ?? '';
    expect(firstParagraph).toContain('has not been performed');
    expect(firstParagraph).toContain('D-13');
  });
});
