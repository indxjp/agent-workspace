#!/usr/bin/env node
/**
 * `agent-workspace-embedded`, the package's `./launch` export (`dist/bin.js`). It is the only file
 * that may be `argv[1]`: `dist/launch.js` inlines modules that compare their own `import.meta.url`
 * with `argv[1]`, and running this wrapper keeps every one of those guards false (ADR-0109).
 *
 * Importing it has no side effect: `./launch.js` loads only when this file is the entry point.
 * It takes no arguments, and a failed start exits non-zero (`runBin`).
 */
import { isMainModule, runBin } from './main-module.js';

if (isMainModule(process.argv[1], import.meta.url)) {
  await runBin({
    args: process.argv.slice(2),
    writeError: (chunk) => void process.stderr.write(chunk),
    exit: (code) => process.exit(code),
    start: async () => {
      const { runLocalRuntime } = await import('./launch.js');
      return runLocalRuntime();
    },
  });
}
