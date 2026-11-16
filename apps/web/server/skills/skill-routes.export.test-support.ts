import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GET as detailRoute } from '../../app/api/skills/[name]/route';
import { POST as importRoute } from '../../app/api/skills/route';
import { nameContext, postJson, req, WORKSPACE_A } from './skill-routes.test-support';

let sourceDir: string;

let exportedDir: string;

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('GET /api/skills/:name?export=true', () => {
  it('404s a skill nobody imported', checks404sSkillNobodyImported);
});

describe('round-trip import -> export is byte-identical (the wave plan acceptance criterion)', () => {
  beforeEach(async () => {
    sourceDir = await mkdtemp(path.join(os.tmpdir(), 'w2-cp-04-source-'));
    exportedDir = await mkdtemp(path.join(os.tmpdir(), 'w2-cp-04-exported-'));
  });

  afterEach(async () => {
    await rm(sourceDir, { recursive: true, force: true });
    await rm(exportedDir, { recursive: true, force: true });
  });

  it(
    'reproduces every byte, including a trailing newline, a missing one, and embedded CRLFs',
    reproducesEveryByteIncludingTrailingNewlineMissingOne,
  );

  it(
    'exporting twice in a row produces identical bytes both times (the guard is a filter, not a rewriter, one level up)',
    exportingTwiceRowProducesIdenticalBytesBothTimes,
  );
});

async function checks404sSkillNobodyImported() {
  const response = await detailRoute(
    req('GET', '/api/skills/nope?export=true', { workspace: WORKSPACE_A }),
    nameContext('nope'),
  );
  expect(response.status).toBe(404);
}

async function exportingTwiceRowProducesIdenticalBytesBothTimes() {
  const bytes = Buffer.from('content with a trailing newline\n', 'utf8');
  await importRoute(
    postJson(WORKSPACE_A, {
      name: 'stable-export',
      files: [{ path: 'SKILL.md', contentBase64: bytes.toString('base64') }],
    }),
  );
  const first = await detailRoute(
    req('GET', '/api/skills/stable-export?export=true', { workspace: WORKSPACE_A }),
    nameContext('stable-export'),
  );
  const second = await detailRoute(
    req('GET', '/api/skills/stable-export?export=true', { workspace: WORKSPACE_A }),
    nameContext('stable-export'),
  );
  expect(await first.json()).toEqual(await second.json());
}

async function reproducesEveryByteIncludingTrailingNewlineMissingOne() {
  const files = await writeRoundTripFixture(sourceDir);

  // Sanity check on the fixture itself, so a failure below is about the round trip and not
  // about this test having built a fixture that does not actually exercise the two shapes the
  // acceptance criterion names.
  expect(files['SKILL.md']?.subarray(-1).toString('utf8')).toBe('\n');
  expect(files['scripts/run.sh']?.subarray(-1).toString('utf8')).not.toBe('\n');

  // Import: read every file off disk, base64-encode its raw bytes, POST the manifest.
  const importBody = {
    name: 'round-trip-demo',
    files: Object.entries(files).map(([filePath, bytes]) => ({
      path: filePath,
      contentBase64: bytes.toString('base64'),
    })),
  };
  const imported = await importRoute(postJson(WORKSPACE_A, importBody));
  expect(imported.status, await imported.clone().text()).toBe(201);

  // Export: GET the tree back through the real route handler.
  const exported = await detailRoute(
    req('GET', '/api/skills/round-trip-demo?export=true', { workspace: WORKSPACE_A }),
    nameContext('round-trip-demo'),
  );
  expect(exported.status).toBe(200);
  const exportedBody = (await exported.json()) as {
    skill: { name: string; files: Array<{ path: string; contentBase64: string }> };
  };
  expect(exportedBody.skill.name).toBe('round-trip-demo');
  expect(exportedBody.skill.files).toHaveLength(Object.keys(files).length);

  // Write the exported tree back out to a second real directory, exactly the shape the source
  // was in, so "hashing every file in both" is about two directories on disk, not two in-memory
  // maps that happen to share a serialiser.
  for (const file of exportedBody.skill.files) {
    const absolute = path.join(exportedDir, ...file.path.split('/'));
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, Buffer.from(file.contentBase64, 'base64'));
  }

  // The proof: for every file in the source tree, the exported tree has a file at the same
  // relative path whose SHA-256 matches, AND whose bytes are `Buffer.equals`-identical — the
  // hash proves it at the granularity the acceptance criterion names, and the direct byte
  // comparison proves there is no hash collision papering over a real difference.
  let filesCompared = 0;
  for (const [relativePath, sourceBytes] of Object.entries(files)) {
    const exportedBytes = await readFile(path.join(exportedDir, ...relativePath.split('/')));
    expect(sha256(exportedBytes), `${relativePath}: SHA-256 mismatch`).toBe(sha256(sourceBytes));
    expect(exportedBytes, `${relativePath}: bytes differ`).toEqual(sourceBytes);
    filesCompared += 1;
  }
  expect(filesCompared).toBe(3); // a vacuous loop would pass every assertion above (ADR-0015)

  // And the reverse direction: no file exists in the exported tree that was not in the source.
  expect(exportedBody.skill.files.map((f) => f.path).sort()).toEqual(Object.keys(files).sort());
}

async function writeRoundTripFixture(sourceDir: string): Promise<Record<string, Buffer>> {
  // Build a real .claude/skills/<name>/ tree on disk — three files, three distinct
  // line-ending shapes, exactly the counter-examples a naive Windows implementation gets wrong.
  const skillRoot = path.join(sourceDir, '.claude', 'skills', 'round-trip-demo');
  await mkdir(path.join(skillRoot, 'scripts'), { recursive: true });

  const files: Record<string, Buffer> = {
    // WITH a trailing newline.
    'SKILL.md': Buffer.from(
      '---\nname: round-trip-demo\ndescription: Proves byte-identical export\n---\n\nBody text.\n',
      'utf8',
    ),
    // WITHOUT a trailing newline.
    'scripts/run.sh': Buffer.from('#!/bin/sh\necho "no trailing newline"', 'utf8'),
    // Embedded CRLFs, which a text-mode read/write anywhere in the pipeline would collapse to LF.
    'notes.txt': Buffer.from('line one\r\nline two\r\nline three, no final EOL', 'utf8'),
  };

  for (const [relativePath, bytes] of Object.entries(files)) {
    const absolute = path.join(skillRoot, ...relativePath.split('/'));
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, bytes); // no `encoding` option — see local-fs-store.ts's header
  }

  return files;
}
