import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseDotEnv } from '../generated-project/project.mjs';
import { bundledStorageUrl, stackEnv } from './tool-sandbox.e2e.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');

const env = parseDotEnv(
  stackEnv({
    adminEmail: 'admin@example.com',
    adminPassword: 'e2e-password',
    webPort: 3000,
    dockerGid: 999,
    storageUrl: bundledStorageUrl(),
  }),
);

describe('the tool-sandbox e2e stack env', () => {
  it('names the bundled store from .env.example as AW_STORAGE_URL', () => {
    const example = parseDotEnv(readFileSync(path.join(ROOT, '.env.example'), 'utf8'));
    expect(example['AW_STORAGE_URL']).toMatch(
      /^s3:\/\/agent-workspace\?endpoint=http:\/\/seaweedfs:8333&/u,
    );
    expect(env['AW_STORAGE_URL']).toBe(example['AW_STORAGE_URL']);
  });

  it('sets every variable compose.yaml requires', () => {
    const compose = readFileSync(path.join(ROOT, 'compose.yaml'), 'utf8');
    const required = new Set(
      Array.from(compose.matchAll(/\$\{([A-Z][A-Z0-9_]*):\?/gu), (match) => match[1] ?? ''),
    );
    expect(required).toContain('AW_STORAGE_URL');
    const missing = [...required].filter((name) => (env[name] ?? '') === '');
    expect(missing).toEqual([]);
  });
});
