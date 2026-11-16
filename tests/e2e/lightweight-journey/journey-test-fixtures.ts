import { readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, type MockInstance, vi } from 'vitest';
import { LANES, runChapters } from './lanes.mjs';

/** Include the journey's entry point, shared services and chapter implementations. */
export function journeySource(): string {
  const chapters = path.join(import.meta.dirname, 'journey-steps');
  return [
    readFileSync(path.join(import.meta.dirname, 'journey.e2e.mjs'), 'utf8'),
    ...readdirSync(import.meta.dirname)
      .filter((file) => file.startsWith('journey-') && file.endsWith('.mjs'))
      .sort()
      .map((file) => readFileSync(path.join(import.meta.dirname, file), 'utf8')),
    ...readdirSync(chapters)
      .filter((file) => file.endsWith('.mjs'))
      .sort()
      .map((file) => readFileSync(path.join(chapters, file), 'utf8')),
  ].join('\n');
}

export const SUMMARY = path.resolve(
  import.meta.dirname,
  '../../../infra/tests/isolation/summary.mjs',
);

export const ALL_CHAPTERS = [
  'create',
  'eval',
  'deploy',
  'configure',
  'gate',
  'chat-api',
  'hosted-chat',
  'widget',
  'frontend',
  'rollback',
];

function journeyLanes() {
  const [vercelLane, , cloudflareLane] = LANES;
  if (vercelLane === undefined || cloudflareLane === undefined) {
    throw new Error('lanes are missing');
  }
  return { vercelLane, cloudflareLane };
}

export const { vercelLane, cloudflareLane } = journeyLanes();

export const directories: string[] = [];

export let stderr: MockInstance<typeof process.stderr.write>;

beforeEach(() => {
  stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

export function outcomes(lane: (typeof LANES)[number], env: Record<string, string>, steps = {}) {
  const rows: Record<string, { outcome: string; detail: string | undefined }> = {};
  const record = (id: string, outcome: string, detail?: string) => {
    rows[id] = { outcome, detail };
  };
  const ran: string[] = [];
  const stepFor = Object.fromEntries(
    ALL_CHAPTERS.map((id) => [id, () => Promise.resolve().then(() => void ran.push(id))]),
  );
  return runChapters(lane, env, { ...stepFor, ...steps }, record, () => [
    'minted-secret-value',
  ]).then(() => ({ rows, ran }));
}

export const credentials = (lane: (typeof LANES)[number]) =>
  Object.fromEntries(lane.credentials.map((name) => [name, `${name.toLowerCase()}-value`]));
