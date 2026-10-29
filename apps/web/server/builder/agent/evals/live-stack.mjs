// Sets up a fresh stack for builder-evals.yml: the first-run setup with the live model key, which
// signs the setup Owner in, and checks that the key's account offers the Builder's model and that
// the built-in Builder is bound to setup's connection and runnable. The model key reaches this
// process by environment only. The Owner's session cookie, which run-evals.mjs runs the cases with
// (the Builder acts only for a person, never for an API key), is masked and written to
// OWNER_SESSION_FILE with mode 600; it is never printed.
/* global fetch */
import { writeFileSync } from 'node:fs';
import process from 'node:process';

import { BUILDER_MODEL } from '@indx-workspace/contracts/builder';

const { BASE_URL, ANTHROPIC_API_KEY, ADMIN_EMAIL, ADMIN_PASSWORD, OWNER_SESSION_FILE } =
  process.env;
const fail = (title, message) => {
  process.stderr.write(`::error title=${title}::${message}\n`);
  process.exit(1);
};
if (!OWNER_SESSION_FILE)
  fail('Missing OWNER_SESSION_FILE', 'the step must name the file the Owner session goes to');
// The server's typed error is a safe public sentence; it says why a step was refused.
const why = async (response) => {
  const { error } = await response.json().catch(() => ({}));
  return error ? ` (${error.code}: ${error.message})` : '';
};
const call = async (path, body, cookie) =>
  fetch(`${BASE_URL}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', origin: BASE_URL, ...(cookie && { cookie }) },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });

const setup = await call('/api/setup', {
  provider: 'anthropic',
  providerApiKey: ANTHROPIC_API_KEY,
  runtime: 'docker',
  adminEmail: ADMIN_EMAIL,
  adminPassword: ADMIN_PASSWORD,
  agentName: 'Builder evals bootstrap',
  agentInstructions: 'Answer briefly.',
});
if (setup.status !== 201) {
  fail('Setup failed', `/api/setup answered ${setup.status}${await why(setup)}`);
}
const cookie = (setup.headers.get('set-cookie') ?? '').split(';', 1)[0];
const token = cookie.slice(cookie.indexOf('=') + 1);
if (token === '') fail('Setup failed', '/api/setup answered without a session cookie');
process.stdout.write(`::add-mask::${token}\n`);
writeFileSync(OWNER_SESSION_FILE, cookie, { mode: 0o600 });

// The connection setup made, which the Builder binds to on a stack with no `default` connection.
const { modelConnectionId } = await setup.json();
if (typeof modelConnectionId !== 'string') {
  fail('Setup failed', '/api/setup answered without a modelConnectionId');
}

// The connection offers what the provider lists for its key; nothing in the workspace can add a model.
const discovered = await call('/api/models', undefined, cookie);
if (discovered.status !== 200) {
  fail(
    'Model discovery failed',
    `/api/models answered ${discovered.status}${await why(discovered)}`,
  );
}
const { models: offered, unavailable = [] } = await discovered.json();
const unread = unavailable.find((entry) => entry.connectionId === modelConnectionId);
if (unread !== undefined) {
  fail(
    'Model list unreadable',
    `the setup connection's model list could not be read${unread.kind === undefined ? '' : ` (${unread.kind})`}: ${unread.reason}`,
  );
}
const served = offered.some(
  (entry) => entry.connectionId === modelConnectionId && entry.providerModelId === BUILDER_MODEL,
);
if (!served) {
  fail(
    'Builder model not offered',
    `the live key's account does not list ${BUILDER_MODEL}, the model the Builder is pinned to, so no connection can serve it. Give ANTHROPIC_API_KEY access to that model. The evals cannot run, and no score is faked.`,
  );
}

const listed = await call('/api/agents', undefined, cookie);
if (listed.status !== 200) fail('Agent list failed', `/api/agents answered ${listed.status}`);
const { agents } = await listed.json();
if (!Array.isArray(agents)) {
  fail('Agent list failed', '/api/agents answered without an agents array');
}
const builder = agents.find((agent) => agent.builtin === 'builder');
if (builder === undefined) {
  fail(
    'No built-in Builder on this stack',
    'the stack has no built-in Builder agent; the web server provisions it at start-up when the `builder` feature is on (#1848 slice 1c); check the web logs for "[compose] the Builder was not provisioned". The evals cannot run, and no score is faked.',
  );
}
// What the run preflight reads first: the agent's own connection and model. The connection is ready
// and offers the model (checked above), so a Builder bound to both passes builder_model_unavailable.
if (builder.modelConnectionId !== modelConnectionId || builder.model !== BUILDER_MODEL) {
  fail(
    'Builder not runnable',
    `the Builder is on connection ${builder.modelConnectionId ?? 'none'} and model ${builder.model ?? 'none'}, not on the setup connection (${modelConnectionId}) and ${BUILDER_MODEL}; setup did not provision it again. Check the web logs for "[compose] the Builder was not provisioned". The evals cannot run, and no score is faked.`,
  );
}
