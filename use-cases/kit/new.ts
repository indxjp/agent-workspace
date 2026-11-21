/**
 * `pnpm use-cases:new <archetype> <slug>`: start a use case as an unedited copy of its archetype's
 * template (`./generate.ts`). Then add the catalog entry and change only what the entry needs.
 */
import console from 'node:console';
import path from 'node:path';
import process from 'node:process';

import { generateUseCase } from './generate.ts';

const [archetype = '', slug = ''] = process.argv.slice(2);
const useCasesDir = path.resolve(import.meta.dirname, '..');
try {
  const files = await generateUseCase({ useCasesDir, archetype, slug });
  console.log(`use-cases/${slug}: ${String(files.length)} files from its template`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error('usage: pnpm use-cases:new <QA|RV|TR|RP|AN|DR|AC> <slug>');
  process.exitCode = 1;
}
