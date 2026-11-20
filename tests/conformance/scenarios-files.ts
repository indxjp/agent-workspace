/** A.12 scenarios 3 and 9: hydrating/collecting files and per-session file isolation. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { fail, pass, type A12RunOutcome } from './support.js';
import { createSandbox, runAgentAction, type A12ScenarioContext } from './scenario-types.js';
import type {
  A12AgentOutcome,
  A12FileTransferProbe,
  RuntimeDriver,
  RuntimeHandle,
} from './types.js';

type ReadPathResult = NonNullable<A12AgentOutcome['readPath']>;

/** A driver that moves files through `putFiles`/`getFiles` rather than a mounted workspace. */
type FileTransferDriver<TRequest, TEvent> = RuntimeDriver<TRequest, TEvent> &
  Required<Pick<RuntimeDriver<TRequest, TEvent>, 'putFiles' | 'getFiles'>>;

function usesFileTransfer<TRequest, TEvent>(
  driver: RuntimeDriver<TRequest, TEvent>,
): driver is FileTransferDriver<TRequest, TEvent> {
  return typeof driver.putFiles === 'function' && typeof driver.getFiles === 'function';
}

// --- 3. hydrate files in, collect files out --------------------------------------------------

type HydrateFiles = {
  readonly relPath: string;
  readonly content: string;
  readonly outRelPath: string;
  readonly outContent: string;
};

/** How one branch words its failure when the sandbox cannot read the hydrated file back. */
type HydrateReadMessages = {
  readonly noResult: string;
  readonly mismatch: (readPath: ReadPathResult) => string;
};

/**
 * Ask the sandbox, through `startAgent`, to read the hydrated file back. Returns a `fail` outcome,
 * or `undefined` when the sandbox saw exactly the hydrated content.
 */
async function checkSandboxReadsHydratedFile<TRequest, TEvent>(
  ctx: A12ScenarioContext<TRequest, TEvent>,
  handle: RuntimeHandle,
  files: HydrateFiles,
  messages: HydrateReadMessages,
): Promise<A12RunOutcome | undefined> {
  const readOutcome = await runAgentAction(ctx, handle, {
    kind: 'read-path',
    target: { locus: 'workspace', handle, relativePath: files.relPath },
  });
  if (readOutcome.readPath === undefined) {
    return fail(messages.noResult);
  }
  if (!readOutcome.readPath.succeeded || readOutcome.readPath.content !== files.content) {
    return fail(messages.mismatch(readOutcome.readPath));
  }
  return undefined;
}

/** Have the sandbox itself create the outbound file; `undefined` means it did. */
async function checkSandboxWritesOutboundFile<TRequest, TEvent>(
  ctx: A12ScenarioContext<TRequest, TEvent>,
  handle: RuntimeHandle,
  files: HydrateFiles,
): Promise<A12RunOutcome | undefined> {
  const writeOutcome = await runAgentAction(ctx, handle, {
    kind: 'write-path',
    target: { locus: 'workspace', handle, relativePath: files.outRelPath },
    content: files.outContent,
  });
  if (writeOutcome.writePath === undefined) {
    return fail(
      `the probe reported no result for a write-path action inside the sandbox (${files.outRelPath}) — collection was never attempted`,
    );
  }
  if (!writeOutcome.writePath.succeeded) {
    return fail(`the sandbox could not create ${files.outRelPath} for collection`);
  }
  return undefined;
}

async function hydrateAndCollectViaFileTransfer<TRequest, TEvent>(
  ctx: A12ScenarioContext<TRequest, TEvent>,
  driver: FileTransferDriver<TRequest, TEvent>,
  fileTransfer: A12FileTransferProbe,
  handle: RuntimeHandle,
  files: HydrateFiles,
): Promise<A12RunOutcome> {
  const { relPath, content, outRelPath, outContent } = files;
  await driver.putFiles(handle, fileTransfer.buildArchive(relPath, content));

  // The putFiles/getFiles round trip above proves the DRIVER's own store preserved the bytes —
  // it says nothing about whether the SANDBOX startAgent connects to can see them. ADR-0046's
  // question, asked of this branch: a driver whose `startAgent` can never run anything (round
  // 1's PROBE 4, one branch over) reports this round trip as fine, because the agent is never
  // asked. So it is asked: a `read-path` action, targeted at this handle's own workspace,
  // driven through the same `startAgent` every other scenario uses.
  const unreadable = await checkSandboxReadsHydratedFile(ctx, handle, files, {
    noResult: `the probe reported no result for a read-path action against ${JSON.stringify(relPath)}, just hydrated through putFiles — the sandbox startAgent runs in was never asked whether it could see it`,
    mismatch: (readPath) =>
      `putFiles hydrated ${JSON.stringify(relPath)}, but the sandbox startAgent connects to could not read it back (succeeded=${String(readPath.succeeded)}, content=${JSON.stringify(readPath.content)}) — a putFiles/getFiles round trip through the driver's own store does not prove the agent can see the file`,
  });
  if (unreadable) return unreadable;

  // "Collect out", the same way: the sandbox itself creates a file through `startAgent`, and
  // only THEN does the harness collect it — via `getFiles`, never by re-reading the store
  // `putFiles` wrote to directly, which would prove nothing about whether the write crossed
  // into the sandbox at all.
  const unwritable = await checkSandboxWritesOutboundFile(ctx, handle, files);
  if (unwritable) return unwritable;
  const collected = await fileTransfer.readArchive(await driver.getFiles(handle, [outRelPath]));
  const collectedBack = collected.get(outRelPath);
  if (collectedBack !== outContent) {
    return fail(
      `getFiles returned ${JSON.stringify(collectedBack)} for ${outRelPath} after the sandbox's own write-path action created it, expected ${JSON.stringify(outContent)} — getFiles did not read back what the agent itself wrote`,
    );
  }

  return pass(
    `hydrated ${JSON.stringify(relPath)} via putFiles and had it read back through the driver from inside the sandbox startAgent runs in, and collected ${JSON.stringify(outRelPath)} via getFiles only after that same sandbox created it through a write-path action (putFiles/getFiles branch)`,
  );
}

async function hydrateAndCollectViaMount<TRequest, TEvent>(
  ctx: A12ScenarioContext<TRequest, TEvent>,
  handle: RuntimeHandle,
  files: HydrateFiles,
): Promise<A12RunOutcome> {
  const { relPath, content, outRelPath, outContent } = files;
  // "Hydrate in" — write to the mount from the host side, which is exactly what
  // `persistentFilesystem: true` claims is visible without putFiles/getFiles. But writing and
  // reading it back with `node:fs` in THIS process, again, proves nothing about the sandbox —
  // it is the same boundary-free round trip ADR-0046 forbids. The driver has to be asked, and
  // asked with a WORKSPACE-relative target: this scenario does not know, and must not assume,
  // that a driver's in-sandbox view of its own workspace resolves the same string as
  // `handle.workspacePath` does on the host (a real container's bind mount is a case where it
  // never does) — resolving `relPath` against this `handle` is the probe's job, not this one's.
  const absPath = path.join(handle.workspacePath, relPath);
  await mkdir(path.dirname(absPath), { recursive: true });
  await writeFile(absPath, content, 'utf8');

  const unreadable = await checkSandboxReadsHydratedFile(ctx, handle, files, {
    noResult: `the probe reported no result for a read-path action against the hydrated file (${relPath}) — hydration was never observed from inside the sandbox`,
    mismatch: (readPath) =>
      `the sandbox could not read back the hydrated file at ${relPath} (succeeded=${String(readPath.succeeded)}, content=${JSON.stringify(readPath.content)}) — hydration did not cross into the sandbox`,
  });
  if (unreadable) return unreadable;

  // "Collect out" — the other direction: the sandbox creates a file, and only then does the
  // harness read it from the host side. A driver whose `startAgent` never runs anything for
  // real cannot fake either half, because both now go through it.
  const outAbsPath = path.join(handle.workspacePath, outRelPath);
  const unwritable = await checkSandboxWritesOutboundFile(ctx, handle, files);
  if (unwritable) return unwritable;
  const collectedBack = await readFile(outAbsPath, 'utf8');
  if (collectedBack !== outContent) {
    return fail(
      `collected ${JSON.stringify(collectedBack)} from ${outAbsPath} after the sandbox wrote it, expected ${JSON.stringify(outContent)}`,
    );
  }

  return pass(
    `hydrated ${JSON.stringify(relPath)} into the mounted workspace and had it read back through the driver from inside the sandbox, and collected ${JSON.stringify(outRelPath)} from the host side only after the sandbox itself created it (persistentFilesystem: true, no putFiles/getFiles declared)`,
  );
}

export async function runHydrateAndCollectFiles<TRequest, TEvent>(
  ctx: A12ScenarioContext<TRequest, TEvent>,
): Promise<A12RunOutcome> {
  const { driver, capabilities, probe } = ctx;
  const handle = await createSandbox(driver, 'hydrate-collect', 'files');
  try {
    const files: HydrateFiles = {
      relPath: 'inbound/greeting.txt',
      content: `hello from A.12 — ${randomUUID()}`,
      outRelPath: 'outbound/farewell.txt',
      outContent: `goodbye from A.12 — ${randomUUID()}`,
    };

    if (usesFileTransfer(driver)) {
      if (!probe.fileTransfer) {
        return fail(
          'driver implements putFiles/getFiles but no A12FileTransferProbe was supplied to build/read an archive for it',
        );
      }
      return await hydrateAndCollectViaFileTransfer(ctx, driver, probe.fileTransfer, handle, files);
    }
    if (capabilities.persistentFilesystem) {
      return await hydrateAndCollectViaMount(ctx, handle, files);
    }
    return fail(
      'driver has neither putFiles/getFiles nor persistentFilesystem — §15.3 requires one of the two and this driver declares neither',
    );
  } finally {
    await driver.destroy(handle);
  }
}

// --- 9. concurrent sessions do not see each other's files --------------------------------------

const ISOLATION_FILE = 'mine.txt';

type IsolationSessions = {
  readonly handleA: RuntimeHandle;
  readonly handleB: RuntimeHandle;
  readonly contentA: string;
  readonly contentB: string;
};

type SeedResult = { readonly problems: readonly string[] } | { readonly failure: A12RunOutcome };

/** Each session writes its own file; returns what went wrong, or a `fail` when no branch applies. */
async function seedOwnFiles<TRequest, TEvent>(
  ctx: A12ScenarioContext<TRequest, TEvent>,
  sessions: IsolationSessions,
): Promise<SeedResult> {
  const { driver, capabilities, probe } = ctx;
  const { handleA, handleB, contentA, contentB } = sessions;
  const problems: string[] = [];

  if (usesFileTransfer(driver)) {
    if (!probe.fileTransfer) {
      return {
        failure: fail(
          'driver implements putFiles/getFiles but no A12FileTransferProbe was supplied',
        ),
      };
    }
    await Promise.all([
      driver.putFiles(handleA, probe.fileTransfer.buildArchive(ISOLATION_FILE, contentA)),
      driver.putFiles(handleB, probe.fileTransfer.buildArchive(ISOLATION_FILE, contentB)),
    ]);
    const [seenByA, seenByB] = await Promise.all([
      probe.fileTransfer.readArchive(await driver.getFiles(handleA, [ISOLATION_FILE])),
      probe.fileTransfer.readArchive(await driver.getFiles(handleB, [ISOLATION_FILE])),
    ]);
    if (seenByA.get(ISOLATION_FILE) !== contentA)
      problems.push(
        `session A saw ${JSON.stringify(seenByA.get(ISOLATION_FILE))}, not its own file`,
      );
    if (seenByB.get(ISOLATION_FILE) !== contentB)
      problems.push(
        `session B saw ${JSON.stringify(seenByB.get(ISOLATION_FILE))}, not its own file`,
      );
    return { problems };
  }
  if (!capabilities.persistentFilesystem) {
    return {
      failure: fail(
        'driver has neither putFiles/getFiles nor persistentFilesystem — cannot demonstrate file isolation at all',
      ),
    };
  }
  const pathA = path.join(handleA.workspacePath, ISOLATION_FILE);
  const pathB = path.join(handleB.workspacePath, ISOLATION_FILE);
  await Promise.all([writeFile(pathA, contentA, 'utf8'), writeFile(pathB, contentB, 'utf8')]);
  const [readA, readB] = await Promise.all([readFile(pathA, 'utf8'), readFile(pathB, 'utf8')]);
  if (readA !== contentA)
    problems.push(
      `session A read back ${JSON.stringify(readA)}, not its own ${JSON.stringify(contentA)}`,
    );
  if (readB !== contentB)
    problems.push(
      `session B read back ${JSON.stringify(readB)}, not its own ${JSON.stringify(contentB)}`,
    );
  if (handleA.workspacePath === handleB.workspacePath)
    problems.push('both sessions were given the same workspacePath');
  return { problems };
}

/**
 * The adversarial half: from inside A's own sandbox, try to read a file that exists only in
 * B's workspace — named as a target RELATIVE TO B's own handle, never as a path this scenario
 * pre-resolved itself (ADR-0046/W3-QA-02's path-target repair: on the putFiles/getFiles branch,
 * "B's workspace" is not a host path at all, so a host-absolute guess built from
 * `handleB.workspacePath` would name a location that branch never wrote to and every driver
 * would report `false` for the wrong reason — see this task's ADR, "C2"). A driver whose
 * `isolation` is real (checked by this scenario's `requirement`) is expected to refuse this
 * regardless of which branch it took; a driver that lets it through has not isolated
 * concurrent sessions, which is exactly what this scenario's name asserts against.
 */
async function crossReadByHandleProblems<TRequest, TEvent>(
  ctx: A12ScenarioContext<TRequest, TEvent>,
  sessions: IsolationSessions,
): Promise<readonly string[]> {
  const { handleA, handleB } = sessions;
  const outcome = await runAgentAction(ctx, handleA, {
    kind: 'read-path',
    target: { locus: 'workspace', handle: handleB, relativePath: ISOLATION_FILE },
  });
  // ADR-0015 / ADR-0046 rule 3: an absent answer is `fail`, never a skipped branch. `x?.y` in
  // an `if` silently treats "the probe never reported readPath at all" the same as "readPath
  // reported succeeded: false" — round 1's bug. A probe that does not implement the `read-path`
  // seam must not get a free pass on the adversarial check it never actually ran.
  if (outcome.readPath === undefined) {
    return [
      "session A's read-path probe reported no result at all for session B's mine.txt — the adversarial cross-read check never ran",
    ];
  }
  return outcome.readPath.succeeded
    ? ["session A's own sandbox could read session B's file (mine.txt)"]
    : [];
}

/**
 * The mounted-filesystem branch has a second, distinct boundary to prove: even when a probe
 * correctly rejects a workspace target carrying another handle, A's sandbox must not be able
 * to reach B's host-side mount by absolute path. The transfer branch deliberately does not run
 * this check because its workspace may have no host path at all (C2); the mounted branch does
 * because that host mount is the property persistentFilesystem exposes (ADR-0048).
 */
async function crossReadByHostPathProblems<TRequest, TEvent>(
  ctx: A12ScenarioContext<TRequest, TEvent>,
  sessions: IsolationSessions,
): Promise<readonly string[]> {
  const { handleA, handleB } = sessions;
  const outcome = await runAgentAction(ctx, handleA, {
    kind: 'read-path',
    target: { locus: 'host', absolutePath: path.join(handleB.workspacePath, ISOLATION_FILE) },
  });
  if (outcome.readPath === undefined) {
    return [
      "session A's read-path probe reported no result for session B's host-side mounted file — the mounted-workspace containment check never ran",
    ];
  }
  return outcome.readPath.succeeded
    ? ["session A's own sandbox could read session B's host-side mounted file"]
    : [];
}

export async function runConcurrentSessionsFileIsolation<TRequest, TEvent>(
  ctx: A12ScenarioContext<TRequest, TEvent>,
): Promise<A12RunOutcome> {
  const { driver, capabilities } = ctx;
  const [handleA, handleB] = await Promise.all([
    createSandbox(driver, 'concurrent-a', 'concurrent-a'),
    createSandbox(driver, 'concurrent-b', 'concurrent-b'),
  ]);
  try {
    const sessions: IsolationSessions = {
      handleA,
      handleB,
      contentA: `owned-by-a-${randomUUID()}`,
      contentB: `owned-by-b-${randomUUID()}`,
    };
    const seeded = await seedOwnFiles(ctx, sessions);
    if ('failure' in seeded) {
      return seeded.failure;
    }
    const problems = [...seeded.problems];
    problems.push(...(await crossReadByHandleProblems(ctx, sessions)));
    if (!usesFileTransfer(driver) && capabilities.persistentFilesystem) {
      problems.push(...(await crossReadByHostPathProblems(ctx, sessions)));
    }

    if (problems.length > 0) {
      return fail(problems.join('; '));
    }
    return pass(
      `two concurrent sessions each wrote and read back only their own file, and A's sandbox could not read B's file even when asked for it by B's own handle`,
    );
  } finally {
    await Promise.all([driver.destroy(handleA), driver.destroy(handleB)]);
  }
}
