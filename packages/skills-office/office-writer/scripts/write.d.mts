// Types for the office-writer command (write.mjs), plain JavaScript so it runs with Node alone
// inside a run's sandbox. The tests import it through these declarations.
import type { OfficeModel } from './lib/model.mjs';

/** The bytes of the file a checked model describes. */
export function buildOfficeFile(model: OfficeModel): Buffer;

/**
 * Reads the model, checks it, and writes `output`, creating its folder and never replacing a file.
 *
 * @throws {import('./lib/model.mjs').OfficeWriterRefusal}
 */
export function writeOfficeFile(
  modelFile: string,
  output: string,
): { written: string; bytes: number };

/**
 * Creates `output` (and its folder), never replacing a file; a failed write removes what it created.
 *
 * @throws {import('./lib/model.mjs').OfficeWriterRefusal} `output_exists` or `output_not_writable`.
 */
export function saveNewFile(output: string, bytes: Uint8Array): void;

interface Stream {
  write(text: string): unknown;
}

/** The command: 0 written, 1 refused (JSON on stderr), 2 a wrong number of arguments. */
export function main(
  args: readonly string[],
  io: { readonly stdout: Stream; readonly stderr: Stream },
): number;
