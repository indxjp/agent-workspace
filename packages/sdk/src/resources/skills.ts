import {
  SkillExportResponseSchema,
  SkillListResponseSchema,
  SkillResponseSchema,
  SKILL_IMPORT_MULTIPART,
  SKILL_MD_FILENAME,
  SkillRevisionResponseSchema,
  type PublishSkillRevisionRequest,
  type SkillDetail,
  type SkillExport,
  type SkillFile,
  type SkillRevision,
  type UpdateSkillPatch,
} from '@indx-workspace/contracts/skills';

import { z } from 'zod';

import { segment, type HttpClient, type RequestOptions } from '../http.js';

const NoContentSchema = z.null();

/** What one imported file's bytes may be given as. */
export type SkillImportBody = Blob | Uint8Array<ArrayBuffer> | string;

/**
 * One file of an import: its bytes as `body` (sent as they are, a `string` as UTF-8), or, deprecated
 * and removed in the next major release, as `contentBase64`, which is decoded and sent as bytes too.
 */
export type SkillImportFile =
  | { readonly path: string; readonly body: SkillImportBody }
  | {
      readonly path: string;
      /**
       * @deprecated Pass the bytes as `body`; the import is `multipart/form-data` and needs no
       * base64. A `contentBase64` file is removed in the next major release (#1700; removals
       * deferred to the next major release: #1944), and the first one a process sends logs a
       * warning (`ClientOptions.onWarning` takes it instead).
       */
      readonly contentBase64: string;
    };

/** The input of {@link SkillsClient.import}. */
export interface SkillImportInput {
  readonly name: string;
  readonly files: readonly SkillImportFile[];
}

// @story US-STO-08
// The message is a constant: it never carries a path, a name or a byte of the file.
const CONTENT_BASE64_DEPRECATED =
  'agent-workspace: skills.import with `contentBase64` files is deprecated and is removed in the next major release; pass each file as `body` (Blob, Uint8Array or string) instead.';

function fileBlob(file: SkillImportFile, http: HttpClient): Blob {
  if ('body' in file) return file.body instanceof Blob ? file.body : new Blob([file.body]);
  http.warn(CONTENT_BASE64_DEPRECATED);
  const binary = atob(file.contentBase64);
  const bytes = new Uint8Array(binary.length);
  for (let at = 0; at < binary.length; at += 1) bytes[at] = binary.charCodeAt(at);
  return new Blob([bytes]);
}

// @story US-STO-08
/** The multipart body the server streams: `name`, then `SKILL.md`, then every other file. */
function importForm(input: SkillImportInput, http: HttpClient): FormData {
  const form = new FormData();
  form.append(SKILL_IMPORT_MULTIPART.nameField, input.name);
  const ordered = [
    ...input.files.filter((file) => file.path === SKILL_MD_FILENAME),
    ...input.files.filter((file) => file.path !== SKILL_MD_FILENAME),
  ];
  for (const file of ordered) {
    form.append(SKILL_IMPORT_MULTIPART.fileField, fileBlob(file, http), file.path);
  }
  return form;
}

/** Copy exactly the two fields the route reads, so nothing a caller's object carries leaks. */
function wireFiles(files: readonly SkillFile[]): SkillFile[] {
  return files.map((file) => ({ path: file.path, contentBase64: file.contentBase64 }));
}

/**
 * `/api/skills/**` — spec §5.7. A skill is the Claude Agent SDK's native directory (`SKILL.md`
 * plus supporting files), addressed by its slug name; file bytes travel as base64 inside JSON
 * bodies, except an import, which sends them as `multipart/form-data` with no base64. Every response is `{ skill }`-wrapped and unwrapped here.
 */
export class SkillsClient {
  readonly #http: HttpClient;

  public constructor(http: HttpClient) {
    this.#http = http;
  }

  /** Every skill of the caller's workspace, by name, each in full detail. */
  public async list(options: RequestOptions = {}): Promise<readonly SkillDetail[]> {
    const response = await this.#http.json({
      operation: 'skills.list',
      method: 'GET',
      path: '/api/skills',
      expect: [200],
      schema: SkillListResponseSchema,
      signal: options.signal,
    });
    return response.skills;
  }

  /**
   * Create a skill from a `SKILL.md`, or import a whole directory, as `multipart/form-data`: one
   * part per file, its filename the relative path (`SKILL.md` is sent first), so no file is
   * base64-encoded and the import may use the whole 16 MiB request ceiling. The JSON body with
   * `contentBase64` is deprecated: the server still takes it, and answers with a `Deprecation`
   * header. A file given as `contentBase64` here is deprecated too: it is decoded and sent as
   * multipart all the same, logs one warning per process (or hands it to
   * `ClientOptions.onWarning`), and is removed in the next major release. `400 invalid_name` for a name
   * outside the slug grammar, `400 missing_skill_md` when no entry is `SKILL.md`,
   * `400 inadmissible_path` for a path outside the server's grammar, `409 skill_already_exists`
   * when the name is taken, `409 colliding_paths` for two paths that differ only by letter case.
   */
  public async import(input: SkillImportInput, options: RequestOptions = {}): Promise<SkillDetail> {
    const response = await this.#http.json({
      operation: 'skills.import',
      method: 'POST',
      path: '/api/skills',
      rawBody: importForm(input, this.#http),
      expect: [201],
      schema: SkillResponseSchema,
      signal: options.signal,
    });
    return response.skill;
  }

  /** `404 skill_not_found` for a missing skill and for a name outside the slug grammar alike. */
  public async get(name: string, options: RequestOptions = {}): Promise<SkillDetail> {
    const response = await this.#http.json({
      operation: 'skills.get',
      method: 'GET',
      path: `/api/skills/${segment(name)}`,
      expect: [200],
      schema: SkillResponseSchema,
      signal: options.signal,
    });
    return response.skill;
  }

  /** The skill's directory, every file byte for byte; importing it elsewhere reproduces it. */
  public async export(name: string, options: RequestOptions = {}): Promise<SkillExport> {
    const response = await this.#http.json({
      operation: 'skills.export',
      method: 'GET',
      path: `/api/skills/${segment(name)}`,
      query: new URLSearchParams({ export: 'true' }),
      expect: [200],
      schema: SkillExportResponseSchema,
      signal: options.signal,
    });
    return response.skill;
  }

  /**
   * Enable or disable a skill, write or overwrite files, remove files — any combination, at
   * least one (`400 empty_patch`). `400 cannot_remove_skill_md` when `removeFiles` names
   * `SKILL.md`; `409 colliding_paths` when a written path differs only by letter case from one
   * the skill already has.
   */
  public async update(
    name: string,
    patch: UpdateSkillPatch,
    options: RequestOptions = {},
  ): Promise<SkillDetail> {
    const body: UpdateSkillPatch = {
      ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
      ...(patch.files === undefined ? {} : { files: wireFiles(patch.files) }),
      ...(patch.removeFiles === undefined ? {} : { removeFiles: [...patch.removeFiles] }),
    };
    const response = await this.#http.json({
      operation: 'skills.update',
      method: 'PATCH',
      path: `/api/skills/${segment(name)}`,
      body,
      expect: [200],
      schema: SkillResponseSchema,
      signal: options.signal,
    });
    return response.skill;
  }

  /**
   * Replace the skill's current files with `files` and freeze them as the next numbered revision
   * (1, 2, 3 …), which an agent can then pin and which never changes. `files` is a whole directory,
   * as `import` takes, including `SKILL.md`. `404 skill_not_found` for a skill the workspace does
   * not hold; the `400`s `import` answers for a bad directory.
   */
  public async publish(
    name: string,
    input: PublishSkillRevisionRequest,
    options: RequestOptions = {},
  ): Promise<SkillRevision> {
    const body: PublishSkillRevisionRequest = { files: wireFiles(input.files) };
    const response = await this.#http.json({
      operation: 'skills.publish',
      method: 'POST',
      path: `/api/skills/${segment(name)}/revisions`,
      body,
      expect: [201],
      schema: SkillRevisionResponseSchema,
      signal: options.signal,
    });
    return response.revision;
  }

  /**
   * Delete a skill: its catalog row, its files and its record. `409 skill_in_use` while any agent
   * has it assigned — the problem's `details` name each agent as `agent:<id>` (read them with
   * `parseInUseReferrers`), and nothing is deleted. `404 skill_not_found` for a name the workspace
   * does not hold.
   */
  public async remove(name: string, options: RequestOptions = {}): Promise<void> {
    await this.#http.json({
      operation: 'skills.remove',
      method: 'DELETE',
      path: `/api/skills/${segment(name)}`,
      expect: [204],
      schema: NoContentSchema,
      signal: options.signal,
    });
  }
}
