import { describe, expect, it } from 'vitest';

import { ProjectResourceSchema } from '../../contracts/projects';
import { toProjectResource } from './resource';

describe('project HTTP resource', () => {
  it('serializes repository dates into the shared browser contract', () => {
    const resource = toProjectResource(
      {
        id: 'project-one',
        workspaceId: 'workspace-one',
        name: 'Project',
        instructions: null,
        defaultAgentId: null,
        defaultModelConnectionId: null,
        defaultModel: null,
        visibility: 'private',
        createdBy: 'user-one',
        ownerPrincipalId: '77777777-7777-4777-8777-777777777777',
        archivedAt: null,
        createdAt: new Date('2026-09-12T01:02:03.000Z'),
        updatedAt: new Date('2026-09-12T04:05:06.000Z'),
      },
      ['file-one'],
      ['connector-one'],
    );

    expect(ProjectResourceSchema.parse(resource)).toEqual(resource);
    expect(resource.createdAt).toBe('2026-09-12T01:02:03.000Z');
    expect(resource.archivedAt).toBeNull();
  });

  // issue #183: the archived state is the one field that changes the meaning of the whole
  // resource, so an archived row must serialise it rather than report the same shape as an
  // active one — the concrete failure a `?? null` written as `?? undefined` would produce.
  it('serializes the archived timestamp of an archived project', () => {
    const resource = toProjectResource(
      {
        id: 'project-two',
        workspaceId: 'workspace-one',
        name: 'Retired',
        instructions: null,
        defaultAgentId: null,
        defaultModelConnectionId: null,
        defaultModel: null,
        visibility: 'private',
        createdBy: 'user-one',
        ownerPrincipalId: '77777777-7777-4777-8777-777777777777',
        archivedAt: new Date('2026-09-13T07:08:09.000Z'),
        createdAt: new Date('2026-09-12T01:02:03.000Z'),
        updatedAt: new Date('2026-09-13T07:08:09.000Z'),
      },
      [],
      [],
    );

    expect(resource.archivedAt).toBe('2026-09-13T07:08:09.000Z');
    expect(ProjectResourceSchema.parse(resource)).toEqual(resource);
  });
});
