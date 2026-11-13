import { SKILL_IMPORT_MULTIPART } from '../skills.js';
import type { ApiRoute } from './definition.js';
import { created, json, NO_CONTENT, ok, UNDESCRIBED } from './definition.js';
export const skillsRoutes: readonly ApiRoute[] = [
  // §5.7 — skills
  {
    method: 'GET',
    path: '/api/skills',
    operationId: 'skills.list',
    tag: 'skills',
    feature: 'skills',
    summary: 'List skills',
    success: ok(json('SkillListResponseSchema')),
  },

  {
    method: 'POST',
    path: '/api/skills',
    operationId: 'skills.import',
    tag: 'skills',
    feature: 'skills',
    summary: 'Import a skill',
    request: {
      kind: 'multipart',
      parts: [
        {
          name: SKILL_IMPORT_MULTIPART.nameField,
          type: 'text',
          description: 'The skill name; the first part.',
        },
        {
          name: SKILL_IMPORT_MULTIPART.fileField,
          type: 'file',
          repeated: true,
          description:
            "One part per skill file, `SKILL.md` first; each part's filename is the file's relative path.",
        },
      ],
    },
    // The JSON + base64 bridge (`ImportSkillInput`), removed in the next major release (#1700).
    deprecatedRequests: [UNDESCRIBED],
    success: created(json('SkillResponseSchema')),
  },

  {
    method: 'GET',
    path: '/api/skills/:name',
    operationId: 'skills.get',
    tag: 'skills',
    feature: 'skills',
    summary: 'Read one skill, or export it with its files',
    success: ok(json('SkillResponseSchema', 'SkillExportResponseSchema')),
  },

  {
    method: 'PATCH',
    path: '/api/skills/:name',
    operationId: 'skills.update',
    tag: 'skills',
    feature: 'skills',
    summary: 'Update a skill',
    request: UNDESCRIBED,
    success: ok(json('SkillResponseSchema')),
  },

  {
    method: 'POST',
    path: '/api/skills/:name/revisions',
    operationId: 'skills.publish',
    tag: 'skills',
    feature: 'skills',
    summary: 'Publish the skill as the next immutable revision an agent can pin',
    request: json('PublishSkillRevisionRequestSchema'),
    success: created(json('SkillRevisionResponseSchema')),
  },

  {
    method: 'DELETE',
    path: '/api/skills/:name',
    operationId: 'skills.remove',
    tag: 'skills',
    feature: 'skills',
    summary: 'Delete a skill no agent is assigned (`409 skill_in_use` names the referrers)',
    success: NO_CONTENT,
  },
];
