/**
 * The own-bucket tutorial (`docs/sdk/site/guides/storage-connections.mdx`) run step for step, the
 * last done-when of the storage design, §06 Phase 5: connect a bucket or folder, grant it to an
 * agent, run, and read both the files the run was given and the file it wrote back (§05).
 *
 * Every CLI line comes from {@link TUTORIAL}, and the guide's code blocks must hold each one, in
 * this order, so a guide that drifts from the tested steps fails here. The CLI runs against the
 * real `/api/storage-connections/**`, `/api/agents` (push), promote and run-start handlers
 * in-process, with the production connection opener and write-back. The runner is a double: there
 * is no sandbox and no model, so a cloud lane proves the real bucket end to end through the
 * product's connection code.
 *
 * The connection gets a least-privilege credential (no delete); the objects are seeded and cleaned
 * up through a separate admin store that may delete.
 *
 * The `file` lane runs in normal CI, where the admin and the connection are the same user. A live
 * lane is registered only when the live job sets `STORAGE_LIVE_LANE` (`live-e2e.yml`,
 * `suite=storage`), and a lane without its variables fails naming the first one missing; nothing is
 * skipped. The live `file` lane gives the two their own identities: the operator (root, through
 * `sudo`) owns the folder, and the connection, the server's own user, cannot delete what it owns.
 */
// @story US-STO-12
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { type ObjectStore } from '@agent-workspace/core/storage';
import { parseStorageUrl } from '@indx-workspace/contracts/storage-url';

import { clearApplicationContext } from '../application-context';

import { TUTORIAL, guideCode, guideStorageUrls, queryNames } from './byo-bucket.guide.test-support';
import { createBucketLanes, type Lane } from './byo-bucket.lanes.test-support';
import { runBucketTutorialSteps } from './byo-bucket.steps.test-support';
const { fileLane, liveLanes, egress, tempDirs, savedEnv, folderLeastPrivilege, prefixlessFolder } =
  createBucketLanes(process.env);
const liveLane = process.env['STORAGE_LIVE_LANE'];
if (liveLane !== undefined && !Object.hasOwn(liveLanes, liveLane)) {
  throw new Error(`STORAGE_LIVE_LANE must be one of ${Object.keys(liveLanes).join(', ')}`);
}

afterEach(() => {
  clearApplicationContext();
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  savedEnv.clear();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The tutorial from the guide's first line to the file written back, on one lane. */
async function tutorial(prepare: Lane): Promise<void> {
  // The credential file lives under the runner's own temporary directory when there is one.
  const work = realpathSync(
    mkdtempSync(path.join(process.env['RUNNER_TEMP'] ?? tmpdir(), 'aw-byo-')),
  );
  tempDirs.push(work);
  const lane = await prepare(work);
  // The lane's URL has the shape the guide gives its kind.
  const kind = parseStorageUrl(lane.url);
  if (!kind.ok) throw new Error('the lane URL does not parse');
  const guideUrl = guideStorageUrls(guideCode()).find(
    (url) => parseStorageUrl(url).ok && url.startsWith(`${kind.location.kind}://`),
  );
  expect(queryNames(lane.url)).toEqual(queryNames(guideUrl ?? ''));
  const { admin } = lane;
  const written = ['reports/q3.csv', 'reports/old.csv', 'reports/summary.md'];
  let failure: { readonly error: unknown } | undefined;
  try {
    await runBucketTutorialSteps(work, lane, egress);
  } catch (error) {
    failure = { error };
  }
  const cleanup = await Promise.allSettled(written.map((key) => admin.delete(key)));
  const cleanupErrors = cleanup.flatMap((result) =>
    result.status === 'rejected' ? [result.reason as unknown] : [],
  );
  if (failure !== undefined && cleanupErrors.length > 0) {
    // Both are reported, the tutorial's own error first.
    throw new AggregateError(
      [failure.error, ...cleanupErrors],
      `the tutorial failed (${String(failure.error)}), and so did its cleanup`,
    );
  }
  if (failure !== undefined) throw failure.error;
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'the cleanup failed');
}

/** `admin` that cannot delete, and reads no `summary.md`, so both the tutorial and its cleanup fail. */
function sabotaged(admin: ObjectStore): ObjectStore {
  return new Proxy(admin, {
    get(target, name) {
      if (name === 'delete') return () => Promise.reject(new Error('cleanup refused'));
      if (name === 'read') {
        return (key: string) =>
          key === 'reports/summary.md' ? Promise.resolve(null) : target.read(key);
      }
      const member: unknown = Reflect.get(target, name);
      return typeof member === 'function'
        ? (member as (...args: unknown[]) => unknown).bind(target)
        : member;
    },
  });
}

describe('the own-bucket tutorial', () => {
  // @story US-STO-12
  it('[US-STO-12][api][cli] the guide gives the tested steps in order', () => {
    const code = guideCode();
    let at = -1;
    for (const line of Object.values(TUTORIAL)) {
      const next = code.indexOf(line, at + 1);
      expect(
        next,
        `the guide's code blocks lack the step, or give it too early: ${line}`,
      ).toBeGreaterThan(at);
      at = next;
    }
  });

  // @story US-STO-12
  it('[US-STO-12][api][cli] every storage URL the guide gives parses, one per kind', () => {
    const urls = guideStorageUrls(guideCode());
    const kinds = urls.map((url) => {
      const parsed = parseStorageUrl(url);
      expect(parsed, url).toMatchObject({ ok: true });
      return parsed.ok ? parsed.location.kind : url;
    });
    expect(kinds.sort()).toEqual(['azblob', 'file', 'gcs', 's3']);
    // The lanes copy the guide's query names, so a dropped `?region=` would otherwise pass unseen.
    const names = (scheme: string): string[] =>
      queryNames(urls.find((url) => url.startsWith(`${scheme}://`)) ?? '');
    expect(names('s3'), 'the guide gives the s3 URL its region').toContain('region');
    expect(names('gcs'), 'the guide gives the gcs URL its project').toContain('project');
  });

  if (liveLane === undefined) {
    // @story US-STO-12
    it('[US-STO-12][api][cli] the tutorial works on a local folder', () => tutorial(fileLane));

    // @story US-STO-12
    it('[US-STO-12][api][cli] a cleanup failure is reported without hiding the tutorial failure', async () => {
      const outcome = await tutorial(async (work) => {
        const lane = await fileLane(work);
        return { ...lane, admin: sabotaged(lane.admin) };
      }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(outcome).toBeInstanceOf(AggregateError);
      const errors: unknown[] = (outcome as AggregateError).errors;
      const [own, ...cleanup] = errors;
      expect(String(own)).toContain('# Q3');
      expect(cleanup.map(String)).toEqual(Array(3).fill('Error: cleanup refused'));
    });
  }

  const live = liveLane === undefined ? undefined : liveLanes[liveLane];
  if (liveLane === 's3' && live !== undefined) {
    // @story US-STO-12
    it('[US-STO-12][api][cli] the tutorial works on S3', () => tutorial(live), 120_000);
    // @story US-STO-12
    it(
      '[US-STO-12][api][cli] a key limited to one folder opens a prefix-less S3 URL, as the guide gives it',
      prefixlessFolder,
      120_000,
    );
  }
  if (liveLane === 'file' && live !== undefined) {
    // @story US-STO-12
    it('[US-STO-12][api][cli] the tutorial works on a folder the operator owns', () =>
      tutorial(live));
    // @story US-STO-12
    it('[US-STO-12][api][cli] the connection cannot delete or replace a file the operator owns', () =>
      folderLeastPrivilege(live));
  }
  if (liveLane === 'gcs' && live !== undefined) {
    // @story US-STO-12
    it('[US-STO-12][api][cli] the tutorial works on GCS', () => tutorial(live), 120_000);
  }
  if (liveLane === 'azblob' && live !== undefined) {
    // @story US-STO-12
    it('[US-STO-12][api][cli] the tutorial works on Azure Blob', () => tutorial(live), 120_000);
  }
});
