import { beforeAll, describe, vi } from 'vitest';
import { installedEngines } from './engines.js';
import { registerAdmissionTests } from './server-admission.test-support.js';
import { registerEventVocabularyTests } from './server-events.test-support.js';
import { registerFileFailuresTests } from './server-file-failures.test-support.js';
import { registerInterruptsTests } from './server-interrupts.test-support.js';
import { registerFileReferencesTests } from './server-reference-files.test-support.js';
import { registerInlineReferencesTests } from './server-reference-inline.test-support.js';
import { registerSkillReferencesTests } from './server-reference-skills.test-support.js';
import { registerRunFailuresTests } from './server-run-failures.test-support.js';
import { registerTerminalFramesTests } from './server-terminal.test-support.js';
import { registerTraceForwardingTests } from './server-tracing.test-support.js';
import { registerFileTransfersTests } from './server-transfers.test-support.js';
// The real verifier, held at a gate a test can close, so "interrupted while hashing" is not a race;
// `after` runs once it has answered, so "changed after verification" is not a race either.
const verifyGate = vi.hoisted(
  (): { hold: Promise<void>; after: (cwd: string) => Promise<void> } => ({
    hold: Promise.resolve(),
    after: () => Promise.resolve(),
  }),
);

vi.mock('./verify-files.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./verify-files.js')>();
  return {
    ...actual,
    verifyReferencedFiles: async (
      ...args: Parameters<typeof actual.verifyReferencedFiles>
    ): ReturnType<typeof actual.verifyReferencedFiles> => {
      await verifyGate.hold;
      const verification = await actual.verifyReferencedFiles(...args);
      await verifyGate.after(args[0]);
      return verification;
    },
  };
});

// Set to make the skill inbox removal throw, as a filesystem fault would, naming the host path.
const inboxRemoval = vi.hoisted((): { fail: boolean } => ({ fail: false }));

vi.mock('./resources.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./resources.js')>();
  return {
    ...actual,
    removeSkillInbox: (...args: Parameters<typeof actual.removeSkillInbox>): void => {
      if (inboxRemoval.fail) throw new Error(`EACCES: permission denied, rmdir '${args[0]}'`);
      actual.removeSkillInbox(...args);
    },
  };
});
// `/healthz` lists the installed engines, so the first request imports every adapter package (four
// agent SDKs, seconds on a loaded CI runner). That import is paid once here, outside any test's own
// budget; the adapters are cached for the rest of the file.
beforeAll(async () => {
  await installedEngines();
}, 60_000);
registerTerminalFramesTests();
registerEventVocabularyTests();
registerInterruptsTests();
registerAdmissionTests();
registerFileTransfersTests();
registerFileFailuresTests();
registerRunFailuresTests();
registerTraceForwardingTests();
describe('granted file references at /run', () => {
  const gates = { verifyGate, inboxRemoval };
  registerInlineReferencesTests();
  registerSkillReferencesTests(gates);
  registerFileReferencesTests(gates);
});
