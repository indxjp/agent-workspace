/**
 * Pick the Cloud Run lane's result line of one execution out of Cloud Logging output.
 *
 *   gcloud logging read ... --format='value(textPayload)' | node log-result.mjs <mode> <nonce>
 *
 * Every execution of a lane job gets a fresh nonce (`AW_ISOLATION_NONCE`) and echoes it in its
 * `AW_ISOLATION_RESULT <json>` line. Only a line with the expected mode and that exact nonce is
 * accepted, so a line of an earlier execution of a job with the same name (a re-run keeps the run id,
 * a prefix can be reused) is never read as this execution's result. It prints the payload JSON and
 * exits 0, exits 1 when no such line is there yet (the caller retries, then fails the lane), and
 * exits 2 on a bad argument or two different lines with the same nonce.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const MARKER = 'AW_ISOLATION_RESULT ';
const NONCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{15,127}$/u;
const MODES = new Set(['create', 'destroy', 'probe', 'token', 'tool-open', 'tool-call', 'tool-close', 'proxy-restricted', 'proxy-open']);

/**
 * The payload of the line that carries `mode` and `nonce`, or undefined when there is none. Pure.
 * Throws on a malformed expectation, and on two different payloads with the same nonce.
 *
 * @param {string} text @param {{ mode: string; nonce: string }} expected
 * @returns {Record<string, unknown> | undefined}
 */
export function pickResult(text, { mode, nonce }) {
  if (!MODES.has(mode)) throw new Error(`unknown mode ${JSON.stringify(mode)}`);
  if (!NONCE_PATTERN.test(nonce)) throw new Error('the expected nonce is missing or malformed');
  const matches = new Map();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith(MARKER)) continue;
    let payload;
    try {
      payload = JSON.parse(line.slice(MARKER.length));
    } catch {
      continue;
    }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) continue;
    if (payload.mode !== mode || payload.nonce !== nonce) continue;
    matches.set(JSON.stringify(payload), payload);
  }
  if (matches.size > 1) throw new Error(`${String(matches.size)} different ${mode} results carry the same nonce`);
  return matches.values().next().value;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [mode = '', nonce = ''] = process.argv.slice(2);
  try {
    const payload = pickResult(readFileSync(0, 'utf8'), { mode, nonce });
    if (payload === undefined) {
      process.stderr.write(`no ${mode} result line with the expected nonce\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write(`${JSON.stringify(payload)}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
