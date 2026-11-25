#!/usr/bin/env node
// Write a .docx, .pptx or .xlsx from an office-writer model, with Node alone.
//
//   node write.mjs <model.json> <out.docx|out.pptx|out.xlsx>   → { "written": "<out>", "bytes": n }
//
// The model's `format` must match the output's extension. The output's folder is created, and an
// output that already exists is refused, so an approved call never replaces a file the approver did
// not see (ADR-0167 D5). A refusal exits 1 with `{ "error", "message", "issues"? }` on stderr; a
// wrong number of arguments exits 2.
import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, extname } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { writeDocx } from './lib/docx.mjs';
import {
  OFFICE_FORMATS,
  OFFICE_WRITER_LIMITS,
  OfficeWriterRefusal,
  parseModel,
} from './lib/model.mjs';
import { writePptx } from './lib/pptx.mjs';
import { writeXlsx } from './lib/xlsx.mjs';

const WRITERS = { docx: writeDocx, pptx: writePptx, xlsx: writeXlsx };

/** The bytes of the file a checked model describes. */
export function buildOfficeFile(model) {
  return WRITERS[model.format](model);
}

/** The model file's text, its size checked on the descriptor it is then read from. */
function modelText(file) {
  const unreadable = () => new OfficeWriterRefusal('unreadable_model', `${file} is not a file`);
  let fd;
  try {
    fd = openSync(file, 'r');
  } catch {
    throw unreadable();
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw unreadable();
    if (stat.size > OFFICE_WRITER_LIMITS.modelBytes)
      throw new OfficeWriterRefusal(
        'model_too_large',
        `${file} is ${stat.size} bytes; at most ${OFFICE_WRITER_LIMITS.modelBytes} are read`,
      );
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}

function readModel(file) {
  const text = modelText(file);
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new OfficeWriterRefusal('invalid_json', `${file} is not JSON: ${error.message}`);
  }
  return parseModel(value);
}

/**
 * Creates the output's folder and the file, never replacing one that exists. A write that fails
 * after the file was created removes it, so no truncated file is left behind.
 *
 * @throws {OfficeWriterRefusal} `output_exists` or `output_not_writable`.
 */
export function saveNewFile(output, bytes) {
  const unwritable = (error) =>
    new OfficeWriterRefusal(
      'output_not_writable',
      `${output} could not be written (${error.code})`,
    );
  try {
    mkdirSync(dirname(output), { recursive: true });
  } catch (error) {
    throw unwritable(error);
  }
  let fd;
  try {
    fd = openSync(output, 'wx');
  } catch (error) {
    throw error.code === 'EEXIST'
      ? new OfficeWriterRefusal('output_exists', `${output} exists; write to a new name`)
      : unwritable(error);
  }
  let failure;
  try {
    writeFileSync(fd, bytes);
  } catch (error) {
    failure = error;
  } finally {
    closeSync(fd);
  }
  if (failure !== undefined) {
    unlinkSync(output);
    throw unwritable(failure);
  }
}

/**
 * Reads, checks and writes. Nothing is written unless the whole model is valid.
 *
 * @throws {OfficeWriterRefusal}
 */
export function writeOfficeFile(modelFile, output) {
  const extension = extname(output).slice(1);
  if (!OFFICE_FORMATS.includes(extension))
    throw new OfficeWriterRefusal(
      'extension_mismatch',
      `${output} must end in .docx, .pptx or .xlsx`,
    );
  const model = readModel(modelFile);
  if (model.format !== extension)
    throw new OfficeWriterRefusal(
      'extension_mismatch',
      `the model is a ${model.format}, but ${output} ends in .${extension}`,
    );
  const bytes = buildOfficeFile(model);
  saveNewFile(output, bytes);
  return { written: output, bytes: bytes.length };
}

const USAGE = 'usage: node write.mjs <model.json> <out.docx|out.pptx|out.xlsx>\n';

/** The command: its exit code, with the result on `io.stdout` and a refusal on `io.stderr`. */
export function main(args, io) {
  if (args.length !== 2) {
    io.stderr.write(USAGE);
    return 2;
  }
  try {
    io.stdout.write(`${JSON.stringify(writeOfficeFile(args[0], args[1]))}\n`);
    return 0;
  } catch (error) {
    if (!(error instanceof OfficeWriterRefusal)) throw error;
    io.stderr.write(`${JSON.stringify(error)}\n`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(String(process.argv[1])).href)
  process.exitCode = main(process.argv.slice(2), process);
