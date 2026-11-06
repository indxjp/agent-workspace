/**
 * Host paths out of what a reader of a run's events is served (UX-02 in #2086).
 *
 * A run works in `<workspace root>/<workspace id>/<session id>` on the runtime's host
 * (`compose/run-request.ts`'s `sandboxFor`). The engine names that directory in its own messages —
 * the session's `cwd`, a tool's absolute `file_path`, "File created successfully at: …" — and those
 * reach the browser verbatim in `raw`, `input` and `output`. On a `local` runtime the root is a
 * directory on the server, so Technical details showed the server's own filesystem layout.
 *
 * The stored rows are left as the engine wrote them; the mask is applied on read, so runs recorded
 * before it are served without the path too. The root is not known here (it is the runtime
 * profile's, per run), so a path is recognised by its last two segments, which are this run's own
 * workspace and session ids, and everything from the path's start to the session segment becomes
 * {@link RUN_DIRECTORY_PLACEHOLDER}. A path inside the directory keeps its relative part:
 * `<workspace>/outputs/report.md`.
 */
import type { SseWireEvent } from './sse';

/** What the run's own directory reads as, in every string of every frame. */
export const RUN_DIRECTORY_PLACEHOLDER = '<workspace>';

/** The characters a path in prose or a command line cannot contain: they end it. */
const PATH_END = String.raw`\s"'\x60<>|(){}\[\],;=`;
const PATH_END_CHAR = new RegExp(`[${PATH_END}]`, 'u');

function escapeForPattern(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
}

/**
 * Where the path whose run-directory tail starts at `tail` begins: the first separator, or drive
 * letter, of the token it is in. `cwd:/srv/…` begins at `/`, `C:\\srv\\…` at `C`. The walk back
 * stops at `floor`, the end of the previous match, so a long string with many paths in one token is
 * still read once, not once per path.
 */
function pathStart(text: string, tail: number, floor: number): number {
  let start = tail;
  while (start > floor && !PATH_END_CHAR.test(text.charAt(start - 1))) start -= 1;
  for (let index = start; index < tail; index += 1) {
    const char = text.charAt(index);
    if (char === '/' || char === '\\') return index;
    const drive =
      /[A-Za-z]/u.test(char) &&
      (index === start || !/[A-Za-z]/u.test(text.charAt(index - 1))) &&
      /^:[\\/]/u.test(text.slice(index + 1, index + 3));
    if (drive) return index;
  }
  return tail;
}

/**
 * The function that masks one run's directory in a string. `null` when an id is empty, which a
 * stored run never has; masking on an empty segment would match any path.
 */
export function runDirectoryMask(
  workspaceId: string,
  sessionId: string,
): ((text: string) => string) | null {
  if (workspaceId === '' || sessionId === '') return null;
  // One separator on each side, not `[\\/]+`: a repeated class before a literal is quadratic on a
  // long run of slashes. The session segment ends where an id character stops: `…/<session>に` in
  // Japanese prose too.
  const tail = new RegExp(
    String.raw`[\\/]${escapeForPattern(workspaceId)}[\\/]${escapeForPattern(sessionId)}(?![A-Za-z0-9_-])`,
    'gu',
  );
  return (text) => {
    // Cheap refusal first: most strings never name the session, and base64 blobs are long.
    if (!text.includes(sessionId)) return text;
    let masked = '';
    let copied = 0;
    for (const match of text.matchAll(tail)) {
      const start = pathStart(text, match.index, copied);
      masked += text.slice(copied, start) + RUN_DIRECTORY_PLACEHOLDER;
      copied = match.index + match[0].length;
    }
    return copied === 0 ? text : masked + text.slice(copied);
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * `value` with every string inside it, keys included, passed through `mask`. Only arrays and plain
 * objects are walked; any other object (a `Date`, bytes) is returned as it is.
 */
export function maskStrings(value: unknown, mask: (text: string) => string): unknown {
  if (typeof value === 'string') return mask(value);
  if (Array.isArray(value)) return value.map((item) => maskStrings(item, mask));
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [mask(key), maskStrings(item, mask)]),
    );
  }
  return value;
}

/** The run's events with its host directory masked in each frame's data. */
export async function* withoutRunDirectory(
  source: AsyncIterable<SseWireEvent>,
  run: { readonly workspaceId: string; readonly sessionId: string },
): AsyncGenerator<SseWireEvent> {
  const mask = runDirectoryMask(run.workspaceId, run.sessionId);
  for await (const event of source) {
    yield mask === null ? event : { ...event, data: maskStrings(event.data, mask) };
  }
}
