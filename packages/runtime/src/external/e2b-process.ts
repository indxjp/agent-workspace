import { REQUEST_TIMEOUT_MS } from './e2b-process-config.js';
import type { ExternalSandbox, ExternalSandboxRequest } from './driver.js';
import { asRecord, failure, rejected, sanitizedReason } from './e2b-errors.js';
import {
  BEARER_ENV,
  RUNNER_PORT,
  ENVD_PORT,
  RUNNER_ENTRY,
  RUNNER_CWD,
  RUNNER_USER,
  TOOL_HOST_ENTRY,
  TOOL_HOST_CWD,
  TOOL_HOST_DIR,
  MAX_START_FRAMES,
  MAX_FRAME_BYTES,
} from './e2b-process-config.js';

export type Reachable = Readonly<{
  sandbox: ExternalSandbox;
  domain: string;
  trafficToken: string;
}>;

async function awaitProcessStart(
  response: Response,
  operation: string,
  secrets: readonly string[],
): Promise<void> {
  const reader = response.body?.getReader();
  if (reader === undefined) throw failure(operation);
  try {
    const readFrame = processFrameReader(reader, operation);
    for (let frames = 0; frames < MAX_START_FRAMES; frames += 1) {
      const { flags, message } = await readFrame();
      // Bit 1 marks the end-of-stream frame; its `error` is `{code, message}`.
      if ((flags & 2) !== 0) {
        throw failure(operation, undefined, sanitizedReason(message['error'], secrets));
      }
      const event = asRecord(message['event']);
      if (typeof event['start'] === 'object' && event['start'] !== null) return;
      if ('end' in event) throw failure(operation);
    }
    throw failure(operation);
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export function createE2bProcessStarter(doFetch: typeof globalThis.fetch) {
  async function startRunner({
    reached,
    envdAccessToken,
    bearer,
    apiKey,
    workload,
  }: Readonly<{
    reached: Reachable;
    envdAccessToken: string;
    bearer: string;
    apiKey: string;
    workload: ExternalSandboxRequest['workload'];
  }>): Promise<void> {
    const operation = workload === 'tool-host' ? 'start the tool host' : 'start the runner';
    const secrets = [apiKey, envdAccessToken, reached.trafficToken, bearer];
    const environment = { NODE_ENV: 'production', HOST: '0.0.0.0', PORT: String(RUNNER_PORT) };
    // The tool host admits a call by the per-run token in its workspace, never by the sandbox bearer.
    const command =
      workload === 'tool-host'
        ? {
            cmd: 'node',
            args: [TOOL_HOST_ENTRY],
            cwd: TOOL_HOST_CWD,
            envs: { ...environment, TOOL_HOST_DIR },
          }
        : {
            cmd: 'node',
            args: [RUNNER_ENTRY],
            cwd: RUNNER_CWD,
            envs: { ...environment, [BEARER_ENV]: bearer },
          };
    const payload = new TextEncoder().encode(JSON.stringify({ process: command, stdin: false }));
    const frame = new Uint8Array(5 + payload.length);
    new DataView(frame.buffer).setUint32(1, payload.length);
    frame.set(payload, 5);
    let response: Response;
    try {
      response = await doFetch(
        `https://${String(ENVD_PORT)}-${reached.sandbox.sandboxId}.${reached.domain}/process.Process/Start`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/connect+json',
            'connect-protocol-version': '1',
            'x-access-token': envdAccessToken,
            authorization: `Basic ${Buffer.from(`${RUNNER_USER}:`).toString('base64')}`,
            ...reached.sandbox.accessHeaders,
          },
          body: frame,
          redirect: 'error',
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
      );
    } catch {
      throw failure(operation);
    }
    if (!response.ok) throw await rejected(operation, response, secrets);
    await awaitProcessStart(response, operation, secrets);
  }
  return startRunner;
}

function processFrameReader(reader: ReadableStreamDefaultReader<Uint8Array>, operation: string) {
  let buffered = new Uint8Array(0);
  const frameLength = (): number => new DataView(buffered.buffer, buffered.byteOffset).getUint32(1);
  return async () => {
    while (buffered.length < 5 || buffered.length < 5 + frameLength()) {
      const chunk = await reader.read().catch(() => undefined);
      if (chunk === undefined || chunk.done) throw failure(operation);
      const bytes: unknown = chunk.value;
      if (!(bytes instanceof Uint8Array)) throw failure(operation);
      const joined = new Uint8Array(buffered.length + bytes.length);
      joined.set(buffered);
      joined.set(bytes, buffered.length);
      buffered = joined;
      if (buffered.length >= 5 && frameLength() > MAX_FRAME_BYTES) throw failure(operation);
    }
    const flags = buffered[0] ?? 0;
    let message: Record<string, unknown>;
    try {
      message = asRecord(
        JSON.parse(new TextDecoder().decode(buffered.subarray(5, 5 + frameLength()))),
      );
    } catch {
      throw failure(operation);
    }
    buffered = buffered.slice(5 + frameLength());
    return { flags, message };
  };
}
