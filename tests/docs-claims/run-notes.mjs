import process from 'node:process';

export function claimRunNotes(options) {
  /** @type {string[]} */
  const notes = [
    `Packages from ${options.registry ?? 'this checkout, in a throwaway Verdaccio'}; model: ${options.live ? 'live' : 'fake'}; machine: ${options.machine === 'host' ? `this computer (${process.platform}), shell ${options.shell}` : 'the journey container'}. Compile rows share one \`tsc\` run, so their duration is its share.`,
    'Run claims execute with `NPM_CONFIG_PREFIX=$HOME/.npm-global` and its `bin` on `PATH`, so a global `npm install` needs no `sudo`; on a default Node install it may fail with EACCES.',
  ];
  if (options.live && options.apiKey === '') {
    notes.push(
      "`ANTHROPIC_API_KEY` is not set: every row from a page's first `npm run dev` on is `skipped`, and a skipped row fails the run; it is never a pass.",
    );
  }
  return notes;
}
