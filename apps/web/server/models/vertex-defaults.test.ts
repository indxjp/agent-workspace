import { describe, expect, it, vi } from 'vitest';

import { log } from '../telemetry/logger';
import { readVertexDefaults, vertexConfigWithDefaults } from './vertex-defaults';

describe('readVertexDefaults', () => {
  it('reads a valid project and location', () => {
    expect(
      readVertexDefaults({ AW_VERTEX_PROJECT_ID: 'my-project-123', AW_VERTEX_LOCATION: 'eu' }),
    ).toEqual({ projectId: 'my-project-123', location: 'eu' });
    expect(readVertexDefaults({})).toEqual({});
  });

  it('treats invalid values as absent and never logs them', () => {
    const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    expect(
      readVertexDefaults({ AW_VERTEX_PROJECT_ID: 'Bad Project!', AW_VERTEX_LOCATION: 'moon-base' }),
    ).toEqual({});
    const logged = JSON.stringify(error.mock.calls);
    expect(error).toHaveBeenCalledTimes(2);
    expect(logged).not.toContain('Bad Project');
    expect(logged).not.toContain('moon-base');
    error.mockRestore();
  });
});

describe('vertexConfigWithDefaults', () => {
  it('fills what is omitted and keeps what the caller sent', () => {
    expect(vertexConfigWithDefaults({}, { projectId: 'p-default-1', location: 'us' })).toEqual({
      projectId: 'p-default-1',
      location: 'us',
    });
    expect(vertexConfigWithDefaults({}, {})).toEqual({ location: 'global' });
    expect(
      vertexConfigWithDefaults({ projectId: 'mine-12345', location: 'eu' }, { projectId: 'x' }),
    ).toEqual({ projectId: 'mine-12345', location: 'eu' });
  });
});
