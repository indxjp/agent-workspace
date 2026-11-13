/* global console */
import path from 'node:path';
import process from 'node:process';
import { snapshotTree, filesContaining } from './harness-files.mjs';

export function runHarnessCli() {
  const [command, ...dirs] = process.argv.slice(2);
  const secret = process.env['JOURNEY_SECRET'] ?? '';
  if (command === 'snapshot' && dirs.length === 1 && dirs[0] !== undefined) {
    console.log(JSON.stringify(snapshotTree(path.resolve(dirs[0]))));
  } else if (command === 'find' && dirs.length > 0 && secret !== '') {
    const found = dirs.flatMap((dir) =>
      filesContaining(path.resolve(dir), secret).map((file) => `${dir}/${file}`),
    );
    console.log(JSON.stringify(found));
  } else {
    console.error(
      'usage: node harness.mjs snapshot <dir> | JOURNEY_SECRET=… node harness.mjs find <dir>…',
    );
    process.exitCode = 2;
  }
}
