import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { runWithSkillReference, sha256 } from './server-reference-fixture.test-support.js';

import type { ReferenceGates } from './server-reference-fixture.test-support.js';
export function registerSkillReferencesTests(gates: ReferenceGates): void {
  const { verifyGate, inboxRemoval } = gates;
  it('[US-STO-06][contract][run] a skill reference whose sha256 does not match the inbox file answers 422 run_file_checksum_mismatch and never starts the engine', async () => {
    const answer = await runWithSkillReference('what arrived', {
      size: 'what arrived'.length,
      sha256: sha256('what was granted'),
    });
    expect(answer.status).toBe(422);
    expect(JSON.parse(answer.text)).toEqual({
      error: 'run_file_checksum_mismatch',
      message: 'granted file ".aw-inbox/skills/support/SKILL.md" did not arrive intact',
    });
    expect(answer.text).not.toContain(answer.cwd);
    expect(answer.started).toEqual([]);
    expect(answer.inboxLeft).toBe(false);
  });

  it('[US-STO-06][contract][run] a skill reference whose file did not arrive answers 422 run_file_missing and never starts the engine', async () => {
    const answer = await runWithSkillReference(null, { size: 4, sha256: sha256('gone') });
    expect(answer.status).toBe(422);
    expect(JSON.parse(answer.text)).toMatchObject({ error: 'run_file_missing' });
    expect(answer.started).toEqual([]);
  });

  it('[US-STO-06][contract][run] a skill file removed after verification answers 422 run_file_missing without a host path and never starts the engine', async () => {
    verifyGate.after = (cwd) => rm(path.join(cwd, '.aw-inbox', 'skills', 'support', 'SKILL.md'));
    try {
      const answer = await runWithSkillReference('# support', {
        size: '# support'.length,
        sha256: sha256('# support'),
      });
      expect(answer.status).toBe(422);
      expect(JSON.parse(answer.text)).toEqual({
        error: 'run_file_missing',
        message: 'a granted skill file did not arrive intact',
      });
      expect(answer.text).not.toContain(answer.cwd);
      expect(answer.started).toEqual([]);
      expect(answer.inboxLeft).toBe(false);
    } finally {
      verifyGate.after = () => Promise.resolve();
    }
  });

  it('[US-STO-06][contract][run] a skill file changed after verification answers 422 run_file_checksum_mismatch and never starts the engine', async () => {
    // Same size, other bytes: only the bytes the runner reads are hashed again.
    verifyGate.after = (cwd) =>
      writeFile(path.join(cwd, '.aw-inbox', 'skills', 'support', 'SKILL.md'), '# swapped');
    try {
      const answer = await runWithSkillReference('# support', {
        size: '# support'.length,
        sha256: sha256('# support'),
      });
      expect(answer.status).toBe(422);
      expect(JSON.parse(answer.text)).toEqual({
        error: 'run_file_checksum_mismatch',
        message: 'a granted skill file did not arrive intact',
      });
      expect(answer.started).toEqual([]);
      expect(answer.inboxLeft).toBe(false);
    } finally {
      verifyGate.after = () => Promise.resolve();
    }
  });

  it('[US-STO-06][contract][run] a skill inbox that cannot be removed answers 500 without a host path and never starts the engine', async () => {
    inboxRemoval.fail = true;
    try {
      const answer = await runWithSkillReference('# support', {
        size: '# support'.length,
        sha256: sha256('# support'),
      });
      expect(answer.status).toBe(500);
      expect(JSON.parse(answer.text)).toEqual({
        error: 'internal_error',
        message: 'the granted skill files could not be cleared',
      });
      expect(answer.text).not.toContain(answer.cwd);
      expect(answer.started).toEqual([]);
    } finally {
      inboxRemoval.fail = false;
    }
  });

  it('[US-STO-06][contract][run] a matching skill reference starts the engine with the inbox bytes inline and removes the inbox', async () => {
    const answer = await runWithSkillReference('# support', {
      size: '# support'.length,
      sha256: sha256('# support'),
    });
    expect(answer.status).toBe(200);
    expect(answer.started).toEqual([
      [
        {
          name: 'support',
          files: [{ path: 'SKILL.md', contentBase64: Buffer.from('# support').toString('base64') }],
        },
      ],
    ]);
    expect(answer.inboxLeft).toBe(false);
  });
}
