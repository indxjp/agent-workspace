import { describe, expect, it, vi } from 'vitest';
import { runCreateCommand } from './create.js';
import { captureStdout } from './create-test-fixtures.test-support.js';
import { targetIn, recorder } from './create-finish-fixtures.test-support.js';

export function describeCreateFinishNonterminal(): void {
  describe('create finishes the job (UX-D, #760)', () => {
    describe('without a terminal, and --yes', () => {
      it('never installs or starts without a flag', async () => {
        const target = await targetIn('closed');
        const output = captureStdout();
        vi.spyOn(process.stderr, 'write').mockReturnValue(true);
        const { calls, run } = recorder();
        vi.stubEnv('ANTHROPIC_API_KEY', 'set');

        await runCreateCommand([target], {
          terminal: { isTty: false, prompt: vi.fn() },
          run,
          platform: 'linux',
        });

        expect(calls).toEqual([]);
        expect(output()).toContain(`Next steps:\n  cd ${target}\n  npm install\n  npm run dev\n`);
      });

      it('--install alone installs and does not start; --start does both', async () => {
        captureStdout();
        vi.spyOn(process.stderr, 'write').mockReturnValue(true);
        const terminal = { isTty: false, prompt: vi.fn() };
        const one = recorder();
        await runCreateCommand([await targetIn('i'), '--install'], { terminal, run: one.run });
        expect(one.calls.map((call) => call.args)).toEqual([['install']]);
        const two = recorder();
        await runCreateCommand([await targetIn('s'), '--start'], { terminal, run: two.run });
        expect(two.calls.map((call) => call.args)).toEqual([['install'], ['run', 'dev']]);
      });

      it('a non-zero exit from the started dev run becomes the exit code', async () => {
        captureStdout();
        const { run } = recorder([0, 1]);
        const before = process.exitCode;
        try {
          await runCreateCommand([await targetIn('devfail'), '--yes', '--start'], { run });
          expect(process.exitCode).toBe(1);
        } finally {
          process.exitCode = before;
        }
      });

      it('--yes installs and does not start, on a terminal or not, asking nothing', async () => {
        const target = await targetIn('yes');
        const output = captureStdout();
        const { calls, run } = recorder();
        const prompt = vi.fn<(question: string) => Promise<string>>();
        vi.stubEnv('ANTHROPIC_API_KEY', 'set');

        await runCreateCommand([target, '--yes'], {
          terminal: { isTty: true, prompt },
          run,
          platform: 'linux',
        });

        expect(prompt).not.toHaveBeenCalled();
        expect(calls.map((call) => call.args)).toEqual([['install']]);
        expect(output()).toContain(`Next steps:\n  cd ${target}\n  npm run dev\n`);
      });

      it('--yes --start installs and starts; --yes --no-install installs nothing', async () => {
        captureStdout();
        const started = recorder();
        await runCreateCommand([await targetIn('ys'), '--yes', '--start'], { run: started.run });
        expect(started.calls.map((call) => call.args)).toEqual([['install'], ['run', 'dev']]);
        const skipped = recorder();
        await runCreateCommand([await targetIn('yn'), '--yes', '--no-install'], {
          run: skipped.run,
        });
        expect(skipped.calls).toEqual([]);
      });
    });
  });
}
