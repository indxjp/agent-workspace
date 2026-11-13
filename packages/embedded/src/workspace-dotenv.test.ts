import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadWorkspaceTestServices } from './workspace-services.test-support.js';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const { loadDotEnv } = await loadWorkspaceTestServices();

let directory = '';

beforeEach(() => {
  // The startWorkspace suite stubs process.loadEnvFile; this one needs the real one.
  vi.restoreAllMocks();
  directory = mkdtempSync(path.join(tmpdir(), 'embedded-dotenv-'));
});

afterEach(() => {
  delete process.env['AW_DOTENV_PROBE'];
  rmSync(directory, { recursive: true, force: true });
});

it('does nothing when the directory has no .env', () => {
  expect(() => {
    loadDotEnv(path.join(directory, '.env'));
  }).not.toThrow();
  expect(process.env['AW_DOTENV_PROBE']).toBeUndefined();
});

it('loads a .env that exists', () => {
  writeFileSync(path.join(directory, '.env'), 'AW_DOTENV_PROBE=loaded\n');
  loadDotEnv(path.join(directory, '.env'));
  expect(process.env['AW_DOTENV_PROBE']).toBe('loaded');
});

it('throws any failure other than a missing file', () => {
  mkdirSync(path.join(directory, '.env'));
  expect(() => {
    loadDotEnv(path.join(directory, '.env'));
  }).toThrow();
});
