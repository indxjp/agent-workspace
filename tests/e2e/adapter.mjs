/* global fetch, process */

import { Buffer } from 'node:buffer';
import { TextDecoder } from 'node:util';

export const loginPath = 'bootstrap-administrator';

const base = (process.env['E2E_BASE_URL'] ?? 'http://127.0.0.1:3000').replace(/\/$/u, '');
const state = {
  marker: Date.now().toString(36),
  cookie: '',
  agentId: '',
  modelConnectionId: '',
  runtimeProfileId: '',
  fileId: '',
  skillId: '',
  skillName: '',
  connectorId: '',
  runId: '',
  sessionId: '',
  stream: '',
  streamChunks: 0,
};

/**
 * @param {boolean} ok
 * @param {string} detail
 * @param {Record<string, unknown>} [extra]
 */
function observation(ok, detail, extra = {}) {
  return { asserted: true, ok, detail, ...extra };
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function record(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  /** @type {Record<string, unknown>} */
  const result = {};
  for (const [key, entry] of Object.entries(value)) result[key] = entry;
  return result;
}

/**
 * @param {Response} response
 * @returns {Promise<Record<string, unknown>>}
 */
async function responseBody(response) {
  const text = await response.text();
  if (text.length === 0) return {};
  try {
    return record(JSON.parse(text));
  } catch {
    return { text };
  }
}

/**
 * @param {string} pathname
 * @param {RequestInit} [init]
 * @param {boolean} [authenticated]
 */
async function request(pathname, init = {}, authenticated = true) {
  const headers = new globalThis.Headers(init.headers);
  headers.set('accept', 'application/json');
  if (authenticated && state.cookie) headers.set('cookie', state.cookie);
  return fetch(`${base}${pathname}`, { ...init, headers, redirect: 'manual' });
}

/**
 * @param {unknown} body
 * @param {string} name
 * @returns {unknown[]}
 */
function collection(body, name) {
  const value = record(body)[name];
  return Array.isArray(value) ? value : [];
}

/**
 * @param {unknown} body
 * @param {string} connectionId
 */
export function includesDiscoveredModelConnection(body, connectionId) {
  return collection(body, 'models').some(
    (model) => String(record(model)['connectionId'] ?? '') === connectionId,
  );
}

/** @param {string} text */
export function streamHasSuccessfulToolExecution(text) {
  return (
    /"type":"tool_use"/u.test(text) &&
    /"type":"tool_result"/u.test(text) &&
    !/"subtype":"permission_denied"/u.test(text)
  );
}

/** @param {string} runId */
async function streamRun(runId) {
  const response = await request(`/api/runs/${encodeURIComponent(runId)}/events`, {
    headers: { accept: 'text/event-stream' },
  });
  if (!response.ok || response.body === null) return { response, text: '', chunks: 0 };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let chunks = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks += 1;
    text += decoder.decode(value, { stream: true });
  }
  return { response, text: text + decoder.decode(), chunks };
}

export async function ready() {
  try {
    return (await fetch(`${base}/setup`, { redirect: 'manual' })).ok;
  } catch {
    return false;
  }
}

export const runners = {
  async 'create user'() {
    const providerApiKey = process.env['E2E_PROVIDER_API_KEY'];
    const adminEmail = process.env['E2E_ADMIN_EMAIL'] ?? process.env['BOOTSTRAP_ADMIN'];
    const adminPassword =
      process.env['E2E_ADMIN_PASSWORD'] ?? process.env['BOOTSTRAP_ADMIN_PASSWORD'];
    if (!providerApiKey || !adminEmail || !adminPassword) {
      const missing = [
        !providerApiKey ? 'E2E_PROVIDER_API_KEY' : '',
        !adminEmail ? 'E2E_ADMIN_EMAIL or BOOTSTRAP_ADMIN' : '',
        !adminPassword ? 'E2E_ADMIN_PASSWORD or BOOTSTRAP_ADMIN_PASSWORD' : '',
      ].filter(Boolean);
      return observation(false, `clean setup is missing: ${missing.join(', ')}`);
    }
    const response = await request(
      '/api/setup',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: base },
        body: JSON.stringify({
          provider: process.env['E2E_PROVIDER'] ?? 'anthropic',
          providerApiKey,
          runtime: process.env['E2E_RUNTIME'] ?? 'local',
          adminEmail,
          adminPassword,
          agentName: `E2E bootstrap ${state.marker}`,
          agentInstructions: 'Use selected workspace resources and report observable results.',
        }),
      },
      false,
    );
    const body = await responseBody(response);
    if (!response.ok)
      return observation(
        false,
        `setup returned ${response.status}: ${String(record(body['error'])['code'] ?? 'unknown')} (${String(record(body['error'])['message'] ?? '')})`,
      );
    state.cookie = (response.headers.get('set-cookie') ?? '').split(';', 1)[0] ?? '';
    state.agentId = String(body['agentId'] ?? '');
    state.modelConnectionId = String(body['modelConnectionId'] ?? '');
    state.runtimeProfileId = String(body['runtimeProfileId'] ?? '');
    const agentsResponse = await request('/api/agents');
    const agentsBody = await responseBody(agentsResponse);
    const general = collection(agentsBody, 'agents')
      .map(record)
      .find((candidate) => candidate['name'] === 'General');
    const generalRuntimeConfigured =
      String(general?.['runtimeProfileId'] ?? '') === state.runtimeProfileId;
    const ok =
      Boolean(state.cookie && state.agentId && state.modelConnectionId && state.runtimeProfileId) &&
      agentsResponse.ok &&
      generalRuntimeConfigured;
    return observation(
      ok,
      ok
        ? 'setup created an administrator, signed session, and configured General runtime'
        : `setup omitted persisted ids, cookie, or General runtime (agents=${agentsResponse.status})`,
    );
  },

  async 'add model'() {
    const response = await request('/api/models');
    const body = await responseBody(response);
    const found = includesDiscoveredModelConnection(body, state.modelConnectionId);
    return observation(
      response.ok && found,
      `model list=${response.status}; persisted=${String(found)}`,
    );
  },

  async 'create agent'() {
    const response = await request('/api/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({
        name: `E2E resource agent ${state.marker}`,
        instructions: 'Read the assigned E2E file, use the assigned E2E skill and call echo.',
        modelConnectionId: state.modelConnectionId,
        model: process.env['E2E_MODEL'] ?? 'claude-sonnet-4-5',
        runtimeProfileId: state.runtimeProfileId,
        permissions: {
          readFiles: true,
          writeFiles: true,
          runCommands: false,
          unrestrictedNetwork: true,
        },
      }),
    });
    const body = await responseBody(response);
    const id = String(body['id'] ?? '');
    if (response.ok && id) state.agentId = id;
    return observation(response.status === 201 && Boolean(id), `agent create=${response.status}`);
  },

  async 'upload file'() {
    const filePath = 'e2e/日本語入力.txt';
    const response = await request('/api/files', {
      method: 'POST',
      headers: {
        'content-type': 'text/plain',
        'x-file-path': encodeURIComponent(filePath),
        'x-resource-path-encoding': 'percent-utf8',
        origin: base,
      },
      body: 'E2E_FILE_SENTINEL=violet-orchid-731\n',
    });
    const uploaded = await responseBody(response);
    state.fileId = String(record(uploaded['file'])['id'] ?? '');
    const listed = await request('/api/files?path=e2e');
    const body = await responseBody(listed);
    const found = collection(body, 'files').some((file) => record(file)['path'] === filePath);
    return observation(
      response.status === 201 && Boolean(state.fileId) && listed.ok && found,
      `upload=${response.status}; catalogued=${String(Boolean(state.fileId))}; listed=${String(found)}`,
    );
  },

  async 'add skill'() {
    state.skillName = `e2e-proof-${state.marker}`;
    const source =
      `---\nname: ${state.skillName}\ndescription: E2E proof skill\n---\n\n` +
      'Include SKILL_SENTINEL=amber-river-219.\n';
    const response = await request('/api/skills', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({
        name: state.skillName,
        files: [{ path: 'SKILL.md', contentBase64: Buffer.from(source).toString('base64') }],
      }),
    });
    const imported = await responseBody(response);
    state.skillId = String(record(imported['skill'])['id'] ?? '');
    const listed = await request('/api/skills');
    const body = await responseBody(listed);
    const found = collection(body, 'skills').some(
      (skill) => record(skill)['name'] === state.skillName,
    );
    return observation(
      response.status === 201 && Boolean(state.skillId) && listed.ok && found,
      `skill import=${response.status}; catalogued=${String(Boolean(state.skillId))}; listed=${String(found)}`,
    );
  },

  async 'add MCP'() {
    const url = process.env['E2E_MCP_URL'];
    if (!url)
      return observation(false, 'E2E_MCP_URL is absent; no reachable MCP server was supplied.');
    const response = await request('/api/connectors', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({
        name: `E2E echo ${state.marker}`,
        transport: 'http',
        url,
        authType: 'none',
      }),
    });
    const body = await responseBody(response);
    state.connectorId = String(body['id'] ?? '');
    if (!response.ok || !state.connectorId)
      return observation(false, `connector create=${response.status}`);
    const tested = await request(`/api/connectors/${state.connectorId}/test-connection`, {
      method: 'POST',
      headers: { origin: base },
    });
    const testedBody = await responseBody(tested);
    return observation(
      tested.ok && testedBody['ok'] === true,
      `connector test=${tested.status}; ok=${String(testedBody['ok'])}`,
    );
  },

  async deploy() {
    const response = await request(`/api/agents/${state.agentId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ runtimeProfileId: state.runtimeProfileId }),
    });
    const read = await request(`/api/agents/${state.agentId}`);
    const body = await responseBody(read);
    const agent = record(body['agent'] ?? body);
    const selected = String(agent['runtimeProfileId'] ?? '') === state.runtimeProfileId;
    const assigned = await request(`/api/agents/${state.agentId}/resources`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({
        files: [{ fileId: state.fileId, access: 'read' }],
        skillIds: [state.skillId],
        connectorIds: [state.connectorId],
      }),
    });
    return observation(
      response.ok && read.ok && selected && assigned.ok,
      `deploy=${response.status}; selected=${String(selected)}; resources=${assigned.status}`,
    );
  },

  async run() {
    const response = await request(`/api/agents/${state.agentId}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({
        prompt: `Read e2e/日本語入力.txt, follow ${state.skillName}, call echo, and return both sentinels.`,
      }),
    });
    const body = await responseBody(response);
    const run = record(body['run']);
    state.runId = String(run['id'] ?? '');
    state.sessionId = String(run['sessionId'] ?? '');
    if (response.status === 401)
      return observation(false, 'gateway rejected the run credential', {
        status: 401,
        code: record(body['error'])['code'] ?? body['code'] ?? 'token_invalid',
      });
    return observation(
      response.status === 202 && Boolean(state.runId && state.sessionId),
      `run create=${response.status}`,
    );
  },

  async 'tool executes'() {
    if (!state.runId) return observation(false, 'no run id was created');
    const streamed = await streamRun(state.runId);
    state.stream = streamed.text;
    state.streamChunks = streamed.chunks;
    const toolEvent = streamHasSuccessfulToolExecution(streamed.text);
    return observation(
      streamed.response.ok && toolEvent,
      `stream=${streamed.response.status}; toolEvent=${String(toolEvent)}`,
    );
  },

  async 'stream result'() {
    const completed = /event:\s*run\.status[\s\S]*"status":"completed"/u.test(state.stream);
    const answer =
      state.stream.includes('violet-orchid-731') && state.stream.includes('amber-river-219');
    return observation(
      completed && answer && state.streamChunks >= 2,
      `completed=${String(completed)}; sentinels=${String(answer)}; chunks=${state.streamChunks}`,
    );
  },

  async 'resume session'() {
    if (!state.sessionId) return observation(false, 'no durable session id was created');
    const response = await request(`/api/agents/${state.agentId}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({
        prompt: 'What were the two sentinel values?',
        sessionId: state.sessionId,
      }),
    });
    const body = await responseBody(response);
    const run = record(body['run']);
    const resumedRun = String(run['id'] ?? '');
    if (response.status === 401)
      return observation(false, 'gateway rejected the resume credential', {
        status: 401,
        code: record(body['error'])['code'] ?? body['code'] ?? 'token_invalid',
      });
    if (response.status !== 202 || !resumedRun || run['sessionId'] !== state.sessionId)
      return observation(false, `resume create=${response.status}`);
    const streamed = await streamRun(resumedRun);
    const contextAware =
      streamed.text.includes('violet-orchid-731') && streamed.text.includes('amber-river-219');
    return observation(
      streamed.response.ok && contextAware,
      `resume stream=${streamed.response.status}; context=${String(contextAware)}`,
    );
  },
};
