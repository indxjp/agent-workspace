import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deployFakeProvider } from './fake-provider.mjs';
import './journey-test-fixtures.js';

describe('the fake provider Worker (issue #831)', () => {
  describe('deploys through wrangler error 10007 (the Worker is not visible yet)', () => {
    const workerName = 'awlj-42-cc-provider';
    const retry = { delaysMs: [1, 1, 1], sleep: () => Promise.resolve() };
    const uploaded = `Uploaded ${workerName}\nhttps://${workerName}.acme.workers.dev`;
    const failure = (code: number) =>
      new Error(
        `npx wrangler exited 1, not 0\n✘ [ERROR] This Worker does not exist. [code: ${String(code)}]`,
      );

    beforeEach(() => {
      vi.stubGlobal('fetch', () => Promise.resolve(new Response('{}', { status: 200 })));
    });
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    /** A `run` whose `deploy` calls fail with `code` for the first `failures` times. */
    function wrangler(failures: number, code: number) {
      const commands: string[] = [];
      let deploys = 0;
      const run = (_command: string, args: readonly string[]) => {
        commands.push(args.includes('deploy') ? 'deploy' : 'secret');
        if (args.includes('deploy') && (deploys += 1) <= failures) throw failure(code);
        return uploaded;
      };
      return { run, commands };
    }

    it('runs the deploy again after a 10007 and then puts the secret', async () => {
      const { run, commands } = wrangler(2, 10007);
      const url = await deployFakeProvider({ workerName, key: 'k', run, retry });
      expect(url).toBe(`https://${workerName}.acme.workers.dev`);
      expect(commands).toEqual(['deploy', 'deploy', 'deploy', 'secret']);
    });

    it('stops at the attempt cap with the wrangler error', async () => {
      const { run, commands } = wrangler(Infinity, 10007);
      await expect(deployFakeProvider({ workerName, key: 'k', run, retry })).rejects.toThrow(
        '[code: 10007]',
      );
      expect(commands).toHaveLength(1 + retry.delaysMs.length);
    });

    it('does not retry another error code', async () => {
      const { run, commands } = wrangler(Infinity, 10000);
      await expect(deployFakeProvider({ workerName, key: 'k', run, retry })).rejects.toThrow(
        '[code: 10000]',
      );
      expect(commands).toEqual(['deploy']);
    });
  });
});
