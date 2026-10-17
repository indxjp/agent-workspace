/**
 * The text form of `agent-workspace.yaml`, under the names the CLI's profile code has always used.
 *
 * The reader and the writer live in `@indx-workspace/sdk/project`, so `agent-workspace` and `aw`
 * read one file one way (`docs/adr/0103-…`); the refusals they make are the ones
 * `docs/adr/0089-…` records. This module only re-exports them.
 */
export {
  readProjectFileText as readProfileDocumentText,
  writeProjectFileText as serializeProfileDocument,
  ProjectFileError as ProfileDocumentError,
  type ProjectFilePosition as ProfileDocumentPosition,
  type ProjectFileMapping as ProfileDocument,
} from '@indx-workspace/sdk/project';
