#!/usr/bin/env node
/* global process, URL */ // The root ESLint config declares no environment globals.
// A stand-in for the plant's maintenance system, serving `apis/maintenance.openapi.json` on
// loopback. The tests start it; for a local demo:
//
//   MAINTENANCE_TOKEN=dev-token IDENTITY_SECRET=... IDENTITY_AUDIENCE=<tool-id> IDENTITY_WORKSPACE=<workspace-id> \
//     TROUBLE_LOG_STORE=./trouble-log.store.json PORT=8793 node maintenance/fake-maintenance.mjs
//
// The cases it logs are kept in TROUBLE_LOG_STORE until an expert reviews them and files them under
// `data/trouble-log/<area>/`, the folders the agent searches.
//
// The checks are the system's own rules, not the agent's: the caller (the signed `x-aw-identity`,
// ADR-0142) must be in `data/access.json`; the machine must be in an area that caller works in, and
// one that is not gets the same answer as one that does not exist; every field is a non-blank string
// of at most 300 characters; the technician recorded is the asserted caller, whatever the body says.
// The records are marked `reviewed: false` until an expert reviews them. Whether a person approved
// the call is not decided here: `logResolution` is a write, so the platform runs it only for an
// approved call.
import { readdirSync, readFileSync, renameSync, existsSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { IDENTITY_ASSERTION_HEADER, verifyIdentity } from '@indx-workspace/sdk';

import { normalise } from '../../shared/jp-search.mjs';

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
export const BASE_PATH = '/api/v1';
const FIELD_MAX = 300;

const readBody = async (request) => {
  request.setEncoding('utf8');
  let text = '';
  for await (const chunk of request) text += chunk;
  return text;
};

const squash = (value) => normalise(value).replace(/\s/gu, '');

/**
 * Start the fake maintenance system. Resolves with its base URL (ending in `/api/v1`), the
 * `requests` it received (method, path and parsed body) and a `close()`. `identity` verifies the
 * caller: `{ key, audience, workspace }`, `key` a string or a list while it rotates. `storeFile`
 * persists the logged cases as a JSON array, for another process to read.
 */
export function startFakeMaintenance({
  token,
  identity,
  storeFile,
  port = 0,
  troubleDir = path.join(DATA_DIR, 'trouble-log'),
  accessFile = path.join(DATA_DIR, 'access.json'),
}) {
  const access = JSON.parse(readFileSync(accessFile, 'utf8'));
  // `trouble-log/<area>/<machineId>.json`: the folder is the area access.json grants.
  const files = readdirSync(troubleDir, { recursive: true })
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => ({
      area: path.dirname(name),
      ...JSON.parse(readFileSync(path.join(troubleDir, name), 'utf8')),
    }));
  const machines = files.map(({ area, machineId, name }) => ({ area, machineId, name }));
  const fixtureIds = files.flatMap((file) => file.records.map((record) => record.id));
  let stored = existsSync(storeFile) ? JSON.parse(readFileSync(storeFile, 'utf8')) : [];
  const requests = [];

  const save = () => {
    const draft = `${storeFile}.${process.pid}.tmp`;
    writeFileSync(draft, `${JSON.stringify(stored, null, 2)}\n`);
    renameSync(draft, storeFile); // replace in one step so a reader never sees half a file
  };

  const server = createServer(async (request, response) => {
    const send = (status, body) => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(body));
    };
    const url = new URL(request.url ?? '/', 'http://maintenance.invalid');
    const entry = { method: request.method, path: url.pathname };
    requests.push(entry);
    if (request.headers.authorization !== `Bearer ${token}`) {
      send(401, { error: 'unauthorized' });
      return;
    }
    if (request.method !== 'POST' || url.pathname !== `${BASE_PATH}/resolutions`) {
      send(404, { error: 'no such route' });
      return;
    }
    const caller = await verifyIdentity(
      request.headers[IDENTITY_ASSERTION_HEADER] ?? '',
      identity.key,
      new Date(),
      { audience: identity.audience, workspace: identity.workspace },
    );
    if (!caller.ok) {
      send(401, { code: caller.code });
      return;
    }
    if (!Object.hasOwn(access, caller.payload.sub)) {
      send(403, { error: 'no access: this caller is not registered for this system' });
      return;
    }
    let input;
    try {
      input = JSON.parse(await readBody(request));
    } catch {
      send(400, { error: 'the body must be JSON' });
      return;
    }
    entry.body = input;

    const { areas } = access[caller.payload.sub];
    const visible = machines.filter((machine) => areas.includes(machine.area));
    const wanted = typeof input?.machineId === 'string' ? squash(input.machineId) : '';
    const machine = visible.find(
      (candidate) => squash(candidate.machineId) === wanted || squash(candidate.name) === wanted,
    );
    if (machine === undefined) {
      send(422, {
        error: `unknown machineId; known machines: ${visible.map((m) => `${m.machineId} ${m.name}`).join(', ')}`,
      });
      return;
    }
    const fields = {};
    for (const key of ['symptom', 'cause', 'action']) {
      const value = input[key];
      if (typeof value !== 'string' || value.trim() === '') {
        send(422, { error: `${key} must be a non-empty string` });
        return;
      }
      if ([...value.trim()].length > FIELD_MAX) {
        send(422, { error: `${key} must be at most ${FIELD_MAX} characters` });
        return;
      }
      fields[key] = value.trim();
    }
    const { durationMin } = input;
    if (
      durationMin !== undefined &&
      (!Number.isInteger(durationMin) || durationMin < 1 || durationMin > 1440)
    ) {
      send(422, { error: 'durationMin must be an integer from 1 to 1440' });
      return;
    }

    const highest = Math.max(
      ...[...fixtureIds, ...stored.map((record) => record.id)].map((id) => Number(id.slice(2))),
    );
    const record = {
      id: `T-${String(highest + 1).padStart(4, '0')}`,
      date: new Date().toISOString().slice(0, 10),
      machineId: machine.machineId,
      ...fields,
      durationMin: durationMin ?? null,
      technician: caller.payload.sub,
      // An expert reviews every agent-logged case before it counts as a known cause.
      reviewed: false,
    };
    stored = [...stored, record];
    save();
    send(201, {
      ...record,
      machineName: machine.name,
      citation: `〔過去トラ ${record.id}〕`,
      logged: true,
    });
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        url: `http://127.0.0.1:${address.port}${BASE_PATH}`,
        requests,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const system = await startFakeMaintenance({
    token: process.env.MAINTENANCE_TOKEN ?? 'dev-token',
    identity: {
      key: (process.env.IDENTITY_SECRET ?? '').split(','),
      audience: process.env.IDENTITY_AUDIENCE ?? '',
      workspace: process.env.IDENTITY_WORKSPACE ?? '',
    },
    storeFile: process.env.TROUBLE_LOG_STORE ?? './trouble-log.store.json',
    port: Number(process.env.PORT ?? 8793),
  });
  process.stdout.write(`fake maintenance system on ${system.url}\n`);
}
