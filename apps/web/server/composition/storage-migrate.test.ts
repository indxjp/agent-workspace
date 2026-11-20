import { createInMemoryStorageMigrationRuns } from '@agent-workspace/core/db';
import { vi, describe, expect, it } from 'vitest';
import {
  injected,
  installSkillsWithAdopt,
  recordingLock,
  useS3Root,
  useStorageTestHooks,
  type Lock,
} from './storage.test-support';

vi.mock('@agent-workspace/core/storage', async (original) => ({
  ...(await original<typeof import('@agent-workspace/core/storage')>()),
  openObjectStore: (...args: Parameters<typeof injected.open>) => injected.open(...args),
  openRootObjectStore: (...args: Parameters<typeof injected.openRoot>) =>
    injected.openRoot(...args),
}));

const logs = useStorageTestHooks();

describe('AW_STORAGE_MIGRATE composition', () => {
  // @story US-STO-13
  it.each(['', 'adopt', 'copy', 'copy-dry-run', 'finalize'])(
    '[US-STO-13][unit][cli] AW_STORAGE_MIGRATE=%s runs the skills adopt at start-up under its lock',
    async (mode) => {
      useS3Root();
      vi.stubEnv('AW_STORAGE_MIGRATE', mode);
      const { lock, locked } = recordingLock();
      const workspaceIds = vi.fn(() => Promise.resolve([]));

      await installSkillsWithAdopt(lock, workspaceIds);

      await vi.waitFor(() =>
        expect(logs.info()).toHaveBeenCalledWith(
          '[storage] adopted legacy skills',
          expect.anything(),
        ),
      );
      expect(locked).toEqual(['storage-migrate-skills']);
      expect(workspaceIds).toHaveBeenCalledTimes(1);
    },
  );

  // @story US-STO-13
  it.each(['off'])(
    '[US-STO-13][unit][cli] AW_STORAGE_MIGRATE=%s does not run the skills adopt',
    async (mode) => {
      useS3Root();
      vi.stubEnv('AW_STORAGE_MIGRATE', mode);
      const { lock, locked } = recordingLock();

      const skills = await installSkillsWithAdopt(lock);
      await vi.dynamicImportSettled();

      expect(skills.kind).toBe('serving');
      expect(locked).toEqual([]);
      expect(logs.info()).not.toHaveBeenCalledWith(
        '[storage] adopted legacy skills',
        expect.anything(),
      );
    },
  );
});

describe('AW_STORAGE_MIGRATE with two servers', () => {
  // @story US-STO-13
  it('[US-STO-13][unit][cli] two servers starting together run the skills adopt once', async () => {
    useS3Root();
    vi.stubEnv('AW_STORAGE_MIGRATE', 'adopt');
    // One lock shared by both servers: it tries once and never waits, like the advisory lock.
    let held = false;
    const lock: Lock = async (_name, work) => {
      if (held) return { acquired: false };
      held = true;
      try {
        return { acquired: true, value: await work() };
      } finally {
        held = false;
      }
    };
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => (release = resolve));
    const workspaceIds = vi.fn(async () => {
      await released;
      return [];
    });

    await installSkillsWithAdopt(lock, workspaceIds);
    await vi.waitFor(() => expect(workspaceIds).toHaveBeenCalledTimes(1));
    await installSkillsWithAdopt(lock, workspaceIds);
    await vi.waitFor(() =>
      expect(logs.info()).toHaveBeenCalledWith(
        'skills adopt skipped: another server is running it',
      ),
    );
    release();

    await vi.waitFor(() =>
      expect(logs.info()).toHaveBeenCalledWith(
        '[storage] adopted legacy skills',
        expect.anything(),
      ),
    );
    expect(workspaceIds).toHaveBeenCalledTimes(1);
  });
});

describe('AW_STORAGE_MIGRATE after an earlier skills pass', () => {
  // #1925 item 6: once a pass has left no old skill form, walking every skill on every start-up
  // costs O(skills + revisions) object-store calls and finds nothing.
  const skillsRun = {
    stage: 'skills' as const,
    rowsChecked: 3,
    legacyRows: 0,
    mismatches: 0,
    clean: true,
    orphans: 0,
    proofVersion: 2,
  };

  // @story US-STO-13
  it('[US-STO-13][unit][cli] a start-up after a clean skills pass skips the walk', async () => {
    useS3Root();
    vi.stubEnv('AW_STORAGE_MIGRATE', '');
    const { lock, locked } = recordingLock();
    const workspaceIds = vi.fn(() => Promise.resolve([]));
    const runs = createInMemoryStorageMigrationRuns();
    await runs.record(skillsRun);

    await installSkillsWithAdopt(lock, workspaceIds, runs);

    await vi.waitFor(() =>
      expect(logs.info()).toHaveBeenCalledWith(
        'skills adopt skipped: the latest pass left no old skill forms',
      ),
    );
    expect(locked).toEqual(['storage-migrate-skills']);
    expect(workspaceIds).not.toHaveBeenCalled();
  });

  // @story US-STO-13
  it.each([
    ['left old objects', { legacyRows: 1 }],
    ['failed a workspace', { clean: false, mismatches: 1 }],
    ['predates the proof', { proofVersion: 1 }],
  ])(
    '[US-STO-13][unit][cli] a start-up after a skills pass that %s walks again',
    async (_case, latest) => {
      useS3Root();
      vi.stubEnv('AW_STORAGE_MIGRATE', '');
      const { lock } = recordingLock();
      const workspaceIds = vi.fn(() => Promise.resolve([]));
      const runs = createInMemoryStorageMigrationRuns();
      await runs.record({ ...skillsRun, ...latest });

      await installSkillsWithAdopt(lock, workspaceIds, runs);

      await vi.waitFor(() =>
        expect(logs.info()).toHaveBeenCalledWith(
          '[storage] adopted legacy skills',
          expect.anything(),
        ),
      );
      expect(workspaceIds).toHaveBeenCalledTimes(1);
    },
  );
});
