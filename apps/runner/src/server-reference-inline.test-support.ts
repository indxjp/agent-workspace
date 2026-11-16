import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { runWithInlineBytes, sha256 } from './server-reference-fixture.test-support.js';

export function registerInlineReferencesTests(): void {
  it('[US-STO-06][contract][run] /run refuses a file resource with contentBase64 with 400 and does not echo it', async () => {
    const secret = `payload-${randomUUID()}`;
    const answer = await runWithInlineBytes(
      { at: 'notes.txt', body: secret },
      {
        files: [
          {
            kind: 'file',
            path: 'notes.txt',
            access: 'read',
            size: secret.length,
            sha256: sha256(secret),
            contentBase64: Buffer.from(secret).toString('base64'),
          },
        ],
        skills: [],
      },
    );
    expect(answer.status).toBe(400);
    expect(JSON.parse(answer.text)).toMatchObject({ error: 'invalid_run_request' });
    expect(answer.text).not.toContain(Buffer.from(secret).toString('base64'));
    expect(answer.text).not.toContain(secret);
    expect(answer.started).toBe(0);
  });

  it('[US-STO-06][contract][run] /run refuses a skill file with contentBase64 with 400 and does not echo it', async () => {
    const secret = `payload-${randomUUID()}`;
    const answer = await runWithInlineBytes(
      { at: '.aw-inbox/skills/support/SKILL.md', body: secret },
      {
        files: [],
        skills: [
          {
            name: 'support',
            files: [
              {
                path: 'SKILL.md',
                size: secret.length,
                sha256: sha256(secret),
                contentBase64: Buffer.from(secret).toString('base64'),
              },
            ],
          },
        ],
      },
    );
    expect(answer.status).toBe(400);
    expect(JSON.parse(answer.text)).toMatchObject({ error: 'invalid_run_request' });
    expect(answer.text).not.toContain(Buffer.from(secret).toString('base64'));
    expect(answer.text).not.toContain(secret);
    expect(answer.started).toBe(0);
  });
}
