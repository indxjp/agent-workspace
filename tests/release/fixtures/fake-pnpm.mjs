// A stand-in for pnpm in tests/release/npx-shim.test.ts: prints its arguments and the environment
// variables the shim decides, then exits 7.
import process from 'node:process';

const names = ['PATH', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CONFIG_HOME'];
process.stdout.write(
  JSON.stringify({
    argv: process.argv.slice(2),
    env: Object.fromEntries(names.map((name) => [name, process.env[name] ?? null])),
  }),
);
process.exit(7);
