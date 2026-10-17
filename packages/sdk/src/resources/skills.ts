import {
  SkillExportResponseSchema,
  SkillListResponseSchema,
  SkillResponseSchema,
  type ImportSkillInput,
  type SkillDetail,
  type SkillExport,
  type SkillFile,
  type UpdateSkillPatch,
} from '@indx-workspace/contracts/skills';

import { z } from 'zod';

import { segment, type HttpClient, type RequestOptions } from '../http.js';

const NoContentSchema = z.null();

/** Copy exactly the two fields the route reads, so nothing a caller's object carries leaks. */
function wireFiles(files: readonly SkillFile[]): SkillFile[] {
  return files.map((file) => ({ path: file.path, contentBase64: file.contentBase64 }));
}

/**
 * `/api/skills/**` — spec §5.7. A skill is the Claude Agent SDK's native directory (`SKILL.md`
 * plus supporting files), addressed by its slug name; file bytes travel as base64 inside JSON
 * bodies in both directions. Every response is `{ skill }`-wrapped and unwrapped here.
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
   * Create a skill from a `SKILL.md`, or import a whole directory. `400 invalid_name` for a name
   * outside the slug grammar, `400 missing_skill_md` when no entry is `SKILL.md`,
   * `400 inadmissible_path` for a path outside the server's grammar, `409 skill_already_exists`
   * when the name is taken, `409 colliding_paths` for two paths that differ only by letter case.
   */
  public async import(input: ImportSkillInput, options: RequestOptions = {}): Promise<SkillDetail> {
    const body: ImportSkillInput = { name: input.name, files: wireFiles(input.files) };
    const response = await this.#http.json({
      operation: 'skills.import',
      method: 'POST',
      path: '/api/skills',
      body,
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
