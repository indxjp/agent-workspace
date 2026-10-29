import { describe, expect, it, vi } from 'vitest';

import { ApiProblemError, ContractViolationError, TransportError } from '../errors.js';
import { HttpClient } from '../http.js';
import { fetchDouble, jsonResponse as json, type RecordedRequest } from '../testing.js';
import { SkillsClient } from './skills.js';

const SKILL_MD = '---\nname: demo\ndescription: A demo skill\n---\n\nDo it.\n';
const SKILL_MD_BASE64 = 'LS0tCm5hbWU6IGRlbW8KZGVzY3JpcHRpb246IEEgZGVtbyBza2lsbAotLS0KCkRvIGl0Lgo=';

const skill = {
  id: '88888888-8888-4888-8888-888888888888',
  name: 'demo',
  enabled: true,
  description: 'A demo skill',
  fileCount: 1,
  createdAt: '2026-09-21T10:00:00.000Z',
  updatedAt: '2026-09-21T10:00:00.000Z',
  source: SKILL_MD,
  instructions: 'Do it.\n',
  allowedTools: null,
  files: [{ path: 'SKILL.md', sizeBytes: SKILL_MD.length }],
};

function client(route: (request: RecordedRequest) => Response | Promise<Response>): {
  readonly skills: SkillsClient;
  readonly calls: RecordedRequest[];
} {
  const api = fetchDouble(route);
  const http = new HttpClient({
    baseUrl: 'https://aw.example.com',
    auth: { kind: 'api-key', apiKey: 'ak_live_k' },
    fetch: api.fetch,
  });
  return { skills: new SkillsClient(http), calls: api.calls };
}

describe('SkillsClient.list', () => {
  it('reads the list envelope and unwraps it', async () => {
    const { skills, calls } = client(() => json(200, { skills: [skill] }));
    expect(await skills.list()).toEqual([skill]);
    const [call] = calls;
    expect(call?.method).toBe('GET');
    expect(call?.url.href).toBe('https://aw.example.com/api/skills');
    expect(call?.headers.get('authorization')).toBe('Bearer ak_live_k');
    expect(call?.headers.get('accept')).toBe('application/json');
  });

  it('surfaces the unwired-runtime problem by code', async () => {
    const { skills } = client(() =>
      json(503, { error: { code: 'skills_runtime_not_configured', message: 'No store.' } }),
    );
    const failure = await skills.list().catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ApiProblemError);
    expect((failure as ApiProblemError).status).toBe(503);
    expect((failure as ApiProblemError).code).toBe('skills_runtime_not_configured');
  });

  it('refuses a list whose items are only summaries as a contract violation', async () => {
    const { skills } = client(() =>
      json(200, {
        skills: [
          {
            name: 'demo',
            enabled: true,
            description: null,
            fileCount: 1,
            createdAt: skill.createdAt,
            updatedAt: skill.updatedAt,
          },
        ],
      }),
    );
    const failure = await skills.list().catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ContractViolationError);
    expect((failure as ContractViolationError).issues.join('\n')).toContain('files');
  });
});

describe('SkillsClient.import', () => {
  // @story US-STO-08
  it('posts multipart: a name part, SKILL.md first, one file part per file with its path as filename', async () => {
    const { skills, calls } = client(() => json(201, { skill }));
    const imported = await skills.import({
      name: 'demo',
      files: [
        { path: 'data/table.csv', body: new Blob(['a,b\n']) },
        { path: 'SKILL.md', body: SKILL_MD },
        { path: 'raw.bin', body: new Uint8Array([0, 255, 7]) },
      ],
    });
    expect(imported).toEqual(skill);
    const [call] = calls;
    expect(call?.method).toBe('POST');
    expect(call?.url.href).toBe('https://aw.example.com/api/skills');
    // No content-type of its own: fetch writes `multipart/form-data` with the boundary.
    expect(call?.headers.get('content-type')).toBeNull();
    expect(call?.headers.get('authorization')).toBe('Bearer ak_live_k');
    const form = call?.init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect([...(form?.keys() ?? [])]).toEqual(['name', 'file', 'file', 'file']);
    expect(form?.get('name')).toBe('demo');
    const files = form?.getAll('file') as File[];
    expect(files.map((file) => file.name)).toEqual(['SKILL.md', 'data/table.csv', 'raw.bin']);
    expect(await files[0]?.text()).toBe(SKILL_MD);
    expect(await files[1]?.text()).toBe('a,b\n');
    expect([...new Uint8Array((await files[2]?.arrayBuffer()) ?? new ArrayBuffer(0))]).toEqual([
      0, 255, 7,
    ]);
  });

  it('still takes contentBase64 and sends its bytes, not the base64 text', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { skills, calls } = client(() => json(201, { skill }));
      await skills.import({
        name: 'demo',
        files: [{ path: 'SKILL.md', contentBase64: SKILL_MD_BASE64 }],
      });
      const form = calls[0]?.init.body as FormData;
      expect(await (form?.get('file') as File).text()).toBe(SKILL_MD);
    } finally {
      warn.mockRestore();
    }
  });

  // @story US-STO-08
  it('[US-STO-08][unit][sdk] a contentBase64 import file warns once, names body, and leaks no value', async () => {
    vi.resetModules();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const fresh = await import('./skills.js');
      // The once-per-process memory lives beside the client, so it is fresh too.
      const { HttpClient: FreshHttpClient } = await import('../http.js');
      const marker = `m${String(Date.now())}`;
      const filePath = `scripts/${marker}.sh`;
      const contentBase64 = btoa(`secret-${marker}`);
      const api = fetchDouble(() => json(201, { skill }));
      const skills = new fresh.SkillsClient(
        new FreshHttpClient({
          baseUrl: 'https://aw.example.com',
          auth: { kind: 'api-key', apiKey: 'ak_live_k' },
          fetch: api.fetch,
        }),
      );
      const input = {
        name: `name-${marker}`,
        files: [
          { path: 'SKILL.md', contentBase64: SKILL_MD_BASE64 },
          { path: filePath, contentBase64 },
        ],
      };
      await skills.import(input);
      await skills.import(input);
      expect(api.calls).toHaveLength(2);
      expect(warn).toHaveBeenCalledTimes(1);
      const message = String(warn.mock.calls[0]?.[0]);
      expect(message).toContain('`body`');
      expect(message).toContain('next major');
      for (const leaked of [marker, filePath, contentBase64, SKILL_MD_BASE64, 'secret']) {
        expect(message).not.toContain(leaked);
      }
    } finally {
      warn.mockRestore();
    }
  });

  // @story US-STO-08
  it('[US-STO-08][unit][sdk] onWarning takes the deprecation warning instead of the console', async () => {
    vi.resetModules();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const fresh = await import('./skills.js');
      const received: string[] = [];
      const api = fetchDouble(() => json(201, { skill }));
      const skills = new fresh.SkillsClient(
        new HttpClient({
          baseUrl: 'https://aw.example.com',
          auth: { kind: 'api-key', apiKey: 'ak_live_k' },
          fetch: api.fetch,
          onWarning: (message) => received.push(message),
        }),
      );
      const input = { name: 'demo', files: [{ path: 'SKILL.md', contentBase64: SKILL_MD_BASE64 }] };
      await skills.import(input);
      await skills.import(input);
      expect(warn).not.toHaveBeenCalled();
      // A handler sees every deprecated call; only the console default is limited to one line.
      expect(received).toHaveLength(2);
      expect(received[0]).toContain('next major');
      // A handler that does nothing silences it.
      const silent = new fresh.SkillsClient(
        new HttpClient({
          baseUrl: 'https://aw.example.com',
          auth: { kind: 'api-key', apiKey: 'ak_live_k' },
          fetch: api.fetch,
          onWarning: () => undefined,
        }),
      );
      await silent.import(input);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  // @story US-STO-08
  it('[US-STO-08][unit][sdk] a body-only import sends multipart and does not warn', async () => {
    vi.resetModules();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const fresh = await import('./skills.js');
      const api = fetchDouble(() => json(201, { skill }));
      const skills = new fresh.SkillsClient(
        new HttpClient({
          baseUrl: 'https://aw.example.com',
          auth: { kind: 'api-key', apiKey: 'ak_live_k' },
          fetch: api.fetch,
        }),
      );
      await skills.import({ name: 'demo', files: [{ path: 'SKILL.md', body: SKILL_MD }] });
      expect(api.calls[0]?.init.body).toBeInstanceOf(FormData);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('surfaces each documented refusal by status and code', async () => {
    const refusals: readonly (readonly [number, string])[] = [
      [400, 'invalid_name'],
      [400, 'missing_skill_md'],
      [400, 'inadmissible_path'],
      [400, 'malformed_content'],
      [409, 'skill_already_exists'],
      [409, 'colliding_paths'],
      [413, 'request_body_too_large'],
    ];
    for (const [status, code] of refusals) {
      const { skills } = client(() => json(status, { error: { code, message: 'No.' } }));
      const failure = await skills
        .import({ name: 'demo', files: [{ path: 'SKILL.md', body: '' }] })
        .catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(ApiProblemError);
      expect((failure as ApiProblemError).status).toBe(status);
      expect((failure as ApiProblemError).code).toBe(code);
    }
  });

  it('refuses a bare 201 and one with an unknown field as contract violations', async () => {
    const bare = client(() => json(201, skill));
    const unwrapped = await bare.skills
      .import({ name: 'demo', files: [{ path: 'SKILL.md', body: '' }] })
      .catch((e: unknown) => e);
    expect(unwrapped).toBeInstanceOf(ContractViolationError);
    expect((unwrapped as ContractViolationError).status).toBe(201);

    const drifted = client(() => json(201, { skill: { ...skill, assignedAgents: [] } }));
    const drift = await drifted.skills
      .import({ name: 'demo', files: [{ path: 'SKILL.md', body: '' }] })
      .catch((e: unknown) => e);
    expect(drift).toBeInstanceOf(ContractViolationError);
    expect((drift as ContractViolationError).issues.join('\n')).toContain('assignedAgents');
  });

  it('reports a pre-aborted signal as an aborted transport failure', async () => {
    const controller = new AbortController();
    controller.abort();
    const { skills, calls } = client((request) => {
      expect(request.init.signal?.aborted).toBe(true);
      return Promise.reject(new DOMException('aborted', 'AbortError'));
    });
    const failure = await skills
      .import(
        { name: 'demo', files: [{ path: 'SKILL.md', body: '' }] },
        { signal: controller.signal },
      )
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(TransportError);
    expect((failure as TransportError).aborted).toBe(true);
    expect(calls).toHaveLength(1);
  });
});

describe('SkillsClient.get', () => {
  it('reads the wrapped 200 from the percent-encoded name', async () => {
    const { skills, calls } = client(() => json(200, { skill }));
    expect(await skills.get('demo')).toEqual(skill);
    const [call] = calls;
    expect(call?.method).toBe('GET');
    expect(call?.url.href).toBe('https://aw.example.com/api/skills/demo');
    expect(call?.url.search).toBe('');
  });

  it('sends a name with unusual characters as one encoded segment, and reads the 404 it earns', async () => {
    const { skills, calls } = client(() =>
      json(404, { error: { code: 'skill_not_found', message: 'No skill has that name.' } }),
    );
    const failure = await skills.get('Not A Slug/../x?y=1#z').catch((e: unknown) => e);
    expect(calls[0]?.url.pathname).toBe('/api/skills/Not%20A%20Slug%2F..%2Fx%3Fy%3D1%23z');
    expect(calls[0]?.url.search).toBe('');
    expect(calls[0]?.url.hash).toBe('');
    expect(failure).toBeInstanceOf(ApiProblemError);
    expect((failure as ApiProblemError).status).toBe(404);
    expect((failure as ApiProblemError).code).toBe('skill_not_found');
  });

  it('refuses a body that is not JSON as a contract violation', async () => {
    const { skills } = client(
      () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    );
    const failure = await skills.get('demo').catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ContractViolationError);
  });

  it('reports a pre-aborted signal as an aborted transport failure', async () => {
    const controller = new AbortController();
    controller.abort();
    const { skills } = client(() => Promise.reject(new DOMException('aborted', 'AbortError')));
    const failure = await skills
      .get('demo', { signal: controller.signal })
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(TransportError);
    expect((failure as TransportError).aborted).toBe(true);
  });
});

describe('SkillsClient.export', () => {
  const exported = {
    name: 'demo',
    files: [
      { path: 'SKILL.md', contentBase64: SKILL_MD_BASE64 },
      { path: 'scripts/empty.sh', contentBase64: '' },
    ],
  };

  it('asks for ?export=true on the resource path and unwraps { skill }', async () => {
    const { skills, calls } = client(() => json(200, { skill: exported }));
    expect(await skills.export('demo')).toEqual(exported);
    const [call] = calls;
    expect(call?.method).toBe('GET');
    expect(call?.url.pathname).toBe('/api/skills/demo');
    expect(call?.url.search).toBe('?export=true');
  });

  it('encodes the name and surfaces the not-found and inconsistency problems by code', async () => {
    const missing = client(() =>
      json(404, { error: { code: 'skill_not_found', message: 'No skill named "a b".' } }),
    );
    const absent = await missing.skills.export('a b').catch((e: unknown) => e);
    expect(missing.calls[0]?.url.pathname).toBe('/api/skills/a%20b');
    expect((absent as ApiProblemError).code).toBe('skill_not_found');

    const racing = client(() =>
      json(500, { error: { code: 'store_inconsistent', message: 'x was listed but gone.' } }),
    );
    const raced = await racing.skills.export('demo').catch((e: unknown) => e);
    expect(raced).toBeInstanceOf(ApiProblemError);
    expect((raced as ApiProblemError).status).toBe(500);
    expect((raced as ApiProblemError).code).toBe('store_inconsistent');
  });

  it('refuses a detail body and a non-base64 file as contract violations', async () => {
    const detail = client(() => json(200, { skill }));
    const wrongShape = await detail.skills.export('demo').catch((e: unknown) => e);
    expect(wrongShape).toBeInstanceOf(ContractViolationError);

    const malformed = client(() =>
      json(200, { skill: { name: 'demo', files: [{ path: 'SKILL.md', contentBase64: '%%%' }] } }),
    );
    const bad = await malformed.skills.export('demo').catch((e: unknown) => e);
    expect(bad).toBeInstanceOf(ContractViolationError);
    expect((bad as ContractViolationError).issues.join('\n')).toContain('contentBase64');
  });

  it('reports a pre-aborted signal as an aborted transport failure', async () => {
    const controller = new AbortController();
    controller.abort();
    const { skills } = client(() => Promise.reject(new DOMException('aborted', 'AbortError')));
    const failure = await skills
      .export('demo', { signal: controller.signal })
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(TransportError);
    expect((failure as TransportError).aborted).toBe(true);
  });
});

describe('SkillsClient.update', () => {
  it('patches only the fields given, as the route spells them, and reads the wrapped 200', async () => {
    const disabled = { ...skill, enabled: false, updatedAt: '2026-09-21T11:00:00.000Z' };
    const { skills, calls } = client(() => json(200, { skill: disabled }));
    expect(await skills.update('demo', { enabled: false })).toEqual(disabled);
    const [call] = calls;
    expect(call?.method).toBe('PATCH');
    expect(call?.url.href).toBe('https://aw.example.com/api/skills/demo');
    expect(call?.json).toEqual({ enabled: false });
  });

  it('sends files and removeFiles together and encodes the name', async () => {
    const { skills, calls } = client(() => json(200, { skill }));
    await skills.update('my-skill', {
      files: [{ path: 'scripts/run.sh', contentBase64: 'IyEvYmluL3NoCg==' }],
      removeFiles: ['old.txt'],
    });
    expect(calls[0]?.url.pathname).toBe('/api/skills/my-skill');
    expect(calls[0]?.json).toEqual({
      files: [{ path: 'scripts/run.sh', contentBase64: 'IyEvYmluL3NoCg==' }],
      removeFiles: ['old.txt'],
    });
  });

  it('surfaces each documented refusal by status and code', async () => {
    const refusals: readonly (readonly [number, string])[] = [
      [400, 'empty_patch'],
      [400, 'cannot_remove_skill_md'],
      [400, 'inadmissible_path'],
      [400, 'malformed_body'],
      [404, 'skill_not_found'],
      [409, 'colliding_paths'],
      [409, 'skill_md_removal_rejected'],
    ];
    for (const [status, code] of refusals) {
      const { skills } = client(() => json(status, { error: { code, message: 'No.' } }));
      const failure = await skills.update('demo', { enabled: true }).catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(ApiProblemError);
      expect((failure as ApiProblemError).status).toBe(status);
      expect((failure as ApiProblemError).code).toBe(code);
    }
  });

  it('refuses a 200 whose skill lacks a required field as a contract violation', async () => {
    const withoutInstructions = Object.fromEntries(
      Object.entries(skill).filter(([key]) => key !== 'instructions'),
    );
    const { skills } = client(() => json(200, { skill: withoutInstructions }));
    const failure = await skills.update('demo', { enabled: true }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ContractViolationError);
    expect((failure as ContractViolationError).issues.join('\n')).toContain('instructions');
  });

  it('reports a pre-aborted signal as an aborted transport failure', async () => {
    const controller = new AbortController();
    controller.abort();
    const { skills } = client(() => Promise.reject(new DOMException('aborted', 'AbortError')));
    const failure = await skills
      .update('demo', { enabled: true }, { signal: controller.signal })
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(TransportError);
    expect((failure as TransportError).aborted).toBe(true);
  });
});

describe('SkillsClient.publish', () => {
  const revision = { number: 2, fileCount: 1, publishedAt: '2026-09-22T10:00:00.000Z' };

  it('posts exactly { files[{ path, contentBase64 }] } to the revisions path and reads the 201', async () => {
    const { skills, calls } = client(() => json(201, { revision }));
    const skillMd = { path: 'SKILL.md', contentBase64: SKILL_MD_BASE64, sizeBytes: 3 };
    expect(await skills.publish('demo', { files: [skillMd] })).toEqual(revision);
    const [call] = calls;
    expect(call?.method).toBe('POST');
    expect(call?.url.href).toBe('https://aw.example.com/api/skills/demo/revisions');
    expect(call?.json).toEqual({ files: [{ path: 'SKILL.md', contentBase64: SKILL_MD_BASE64 }] });
  });

  it('surfaces 404 skill_not_found and a refused directory by status and code', async () => {
    for (const [status, code] of [
      [404, 'skill_not_found'],
      [400, 'missing_skill_md'],
    ] as const) {
      const { skills } = client(() => json(status, { error: { code, message: 'No.' } }));
      const failure = await skills.publish('demo', { files: [] }).catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(ApiProblemError);
      expect((failure as ApiProblemError).status).toBe(status);
      expect((failure as ApiProblemError).code).toBe(code);
    }
  });

  it('reads the revisions a skill lists, newest first', async () => {
    const listed = [revision, { ...revision, number: 1 }];
    const { skills } = client(() => json(200, { skill: { ...skill, revisions: listed } }));
    expect((await skills.get('demo')).revisions).toEqual(listed);
  });

  it('refuses a revision with a number below 1 as a contract violation', async () => {
    const { skills } = client(() => json(201, { revision: { ...revision, number: 0 } }));
    const failure = await skills.publish('demo', { files: [] }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ContractViolationError);
  });
});

describe('SkillsClient.remove', () => {
  it('deletes by the percent-encoded name and resolves on the 204', async () => {
    const { skills, calls } = client(() => new Response(null, { status: 204 }));
    await expect(skills.remove('demo')).resolves.toBeUndefined();
    expect(calls[0]?.method).toBe('DELETE');
    expect(calls[0]?.url.pathname).toBe('/api/skills/demo');
  });

  it('surfaces skill_in_use with the assigned agents in details', async () => {
    const agentId = '77777777-7777-4777-8777-777777777777';
    const { skills } = client(() =>
      json(409, {
        error: { code: 'skill_in_use', message: 'Assigned.', details: [`agent:${agentId}`] },
      }),
    );
    const failure = await skills.remove('demo').catch((e: unknown) => e);
    expect((failure as ApiProblemError).code).toBe('skill_in_use');
    expect((failure as ApiProblemError).details).toEqual([`agent:${agentId}`]);
  });
});
