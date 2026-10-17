import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PlatformCompileResult } from '../port.js';
import { mapped } from '../paths.js';
import { expectGoldenBundle, expectGoldenFiles, loadGoldenProject } from './golden.js';
import { SAMPLE_PORTABLE_PROJECT } from './sample.js';

type Emitted = Extract<PlatformCompileResult, { ok: true }>['files'];

function result(files: Emitted): PlatformCompileResult {
  return { ok: true, files, report: [mapped('toolEndpoint', 'kept')] };
}

let dir = '';
let previous: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'golden-'));
  previous = process.env['UPDATE_GOLDEN'];
  delete process.env['UPDATE_GOLDEN'];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (previous === undefined) delete process.env['UPDATE_GOLDEN'];
  else process.env['UPDATE_GOLDEN'] = previous;
});

function update(run: () => void): void {
  process.env['UPDATE_GOLDEN'] = '1';
  try {
    run();
  } finally {
    delete process.env['UPDATE_GOLDEN'];
  }
}

describe('expectGoldenFiles', () => {
  const files = [
    { path: 'agent.json', content: '{}\n' },
    { path: 'nested/skill.md', content: 'hi\n' },
  ];

  it('writes the golden on update, then matches it', () => {
    update(() => {
      expectGoldenFiles(result(files), dir);
    });
    expect(readFileSync(join(dir, 'expected/nested/skill.md'), 'utf8')).toBe('hi\n');
    expect(readFileSync(join(dir, 'report.json'), 'utf8')).toContain('"toolEndpoint"');
    expect(() => {
      expectGoldenFiles(result(files), dir);
    }).not.toThrow();
  });

  it('names an extra, a missing and a changed file', () => {
    update(() => {
      expectGoldenFiles(result(files), dir);
    });
    const run = (next: typeof files): void => {
      expectGoldenFiles(result(next), dir);
    };
    expect(() => {
      run([...files, { path: 'extra.txt', content: 'x' }]);
    }).toThrow(/missing from the golden: expected\/extra\.txt/u);
    expect(() => {
      run(files.slice(0, 1));
    }).toThrow(/not emitted but in the golden: expected\/nested\/skill\.md/u);
    expect(() => {
      run([files[0] ?? { path: 'x', content: '' }, { path: 'nested/skill.md', content: 'bye\n' }]);
    }).toThrow(/changed: expected\/nested\/skill\.md/u);
  });

  it('compares bytes exactly and prunes stale files on update', () => {
    update(() => {
      expectGoldenFiles(result([{ path: 'a.bin', content: new Uint8Array([1, 2, 3]) }]), dir);
    });
    expect(() => {
      expectGoldenFiles(result([{ path: 'a.bin', content: new Uint8Array([1, 2, 4]) }]), dir);
    }).toThrow(/changed: expected\/a\.bin/u);
    update(() => {
      expectGoldenFiles(result([{ path: 'b.txt', content: 'b' }]), dir);
    });
    expect(existsSync(join(dir, 'expected/a.bin'))).toBe(false);
  });

  it('fails when the golden does not exist yet, and on a refusal', () => {
    expect(() => {
      expectGoldenFiles(result(files), join(dir, 'absent'));
    }).toThrow(/missing from the golden/u);
    expect(() => {
      expectGoldenFiles(
        { ok: false, refusal: { code: 'platform_agent_not_found', message: 'm', details: [] } },
        dir,
      );
    }).toThrow(/cannot compare a refusal/u);
  });
});

describe('expectGoldenBundle', () => {
  const files = [
    { path: 'src/b.ts', content: 'export const b = 1;\n' },
    { path: 'a.json', content: '{}' },
  ];

  it('writes one file in path order, then matches it', () => {
    const golden = join(dir, 'nested', 'case.golden.txt');
    update(() => {
      expectGoldenBundle(result(files), golden);
    });
    const text = readFileSync(golden, 'utf8');
    expect(text.indexOf('=== a.json ===')).toBeLessThan(text.indexOf('=== src/b.ts ==='));
    expect(text.indexOf('=== src/b.ts ===')).toBeLessThan(text.indexOf('=== report.json ==='));
    expect(text).toContain('=== a.json ===\n{}\n\\ No newline at end of file\n=== src/b.ts ===');
    expect(() => {
      expectGoldenBundle(result(files), golden);
    }).not.toThrow();
  });

  it('names the section that differs', () => {
    const golden = join(dir, 'case.golden.txt');
    update(() => {
      expectGoldenBundle(result(files), golden);
    });
    expect(() => {
      expectGoldenBundle(result([files[0] ?? { path: 'x', content: '' }]), golden);
    }).toThrow(/not emitted but in the golden: a\.json/u);
    expect(() => {
      expectGoldenBundle(result([...files, { path: 'z.txt', content: 'z' }]), golden);
    }).toThrow(/missing from the golden: z\.txt/u);
    expect(() => {
      expectGoldenBundle(
        result([
          { path: 'src/b.ts', content: 'changed\n' },
          { path: 'a.json', content: '{}' },
        ]),
        golden,
      );
    }).toThrow(/changed: src\/b\.ts/u);
    expect(() => {
      expectGoldenBundle(
        result([
          { path: 'src/b.ts', content: 'export const b = 1;' },
          { path: 'a.json', content: '{}' },
        ]),
        golden,
      );
    }).toThrow(/changed: src\/b\.ts/u);
  });

  it('renders binary content as hex and fails without a golden', () => {
    const golden = join(dir, 'bin.golden.txt');
    update(() => {
      expectGoldenBundle(result([{ path: 'a.bin', content: new Uint8Array([0, 255]) }]), golden);
    });
    expect(readFileSync(golden, 'utf8')).toContain('(hex) 00ff');
    expect(() => {
      expectGoldenBundle(result(files), join(dir, 'absent.golden.txt'));
    }).toThrow(/the golden file does not exist/u);
  });
});

describe('loadGoldenProject', () => {
  it('parses input.json (never project.json, which Nx reads) with the portable schema', () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'project.json'), '{"root":"x"}');
    expect(() => loadGoldenProject(dir)).toThrow(/input\.json/u);
    writeFileSync(join(dir, 'input.json'), JSON.stringify(SAMPLE_PORTABLE_PROJECT));
    expect(loadGoldenProject(dir).root).toBe('support-triage');
    writeFileSync(join(dir, 'input.json'), '{"root":"x"}');
    expect(() => loadGoldenProject(dir)).toThrow();
  });
});
