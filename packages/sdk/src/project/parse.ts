import { EvalCaseFileSchema, type EvalCaseFile } from '@indx-workspace/contracts/evaluations';
import { readProjectDocument, type ProjectRead } from '@indx-workspace/contracts/project-file';

import { readProjectFileText, schemaRefusal } from './reader.js';

/**
 * Reads `agent-workspace.yaml`'s text into a project: a v2 `Project` document as written, or a v1
 * `Deployment` profile lifted into the project shape (`lifted: true`). The result and the project
 * it holds are both frozen.
 *
 * @throws {ProjectFileError} for a construct the reader refuses, or at the first field the
 * contract's schema refuses — with that field's dotted `path`, and its line and column. An
 * unknown key is located at the key itself, not at the mapping that holds it.
 */
export function parseProjectFile(text: string): ProjectRead {
  const reading = readProjectFileText(text);
  const result = readProjectDocument(reading.value);
  if (result.success) return Object.freeze(result.data);
  throw schemaRefusal(reading, result.error, 'is not a valid project file');
}

/**
 * Reads an `evals/<agent>.yaml` file (issue #618) with the project file's reader rules, then the
 * contract's `EvalCaseFileSchema`: 1 to 200 cases with unique names, each expecting some of
 * `contains`, `notContains`, `tool` (with optional `toolInput`), `output` (with the case's
 * `outputSchema`), `judge` and `awaitsApproval`. `label` is the file the refusals name.
 *
 * @throws {ProjectFileError} as {@link parseProjectFile} does, its message beginning `<label> `.
 */
export function readEvalCaseFile(text: string, label: string): EvalCaseFile {
  const reading = readProjectFileText(text, label);
  const result = EvalCaseFileSchema.safeParse(reading.value);
  if (result.success) return result.data;
  throw schemaRefusal(reading, result.error, 'is not a valid evaluation case file', label);
}
