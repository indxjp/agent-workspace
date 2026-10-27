import process from 'node:process';

/**
 * How to run the pnpm that started this process. `npm_execpath` is a JavaScript entry point for
 * the npm-installed or corepack pnpm, but a native executable for `@pnpm/exe`, which `node`
 * cannot load as a script.
 *
 * @param {string} execPath the `npm_execpath` value
 * @param {string[]} args pnpm arguments
 * @returns {{ command: string; args: string[] }}
 */
export function pnpmCommand(execPath, args) {
  return /\.(?:[cm]?js)$/iu.test(execPath)
    ? { command: process.execPath, args: [execPath, ...args] }
    : { command: execPath, args };
}
