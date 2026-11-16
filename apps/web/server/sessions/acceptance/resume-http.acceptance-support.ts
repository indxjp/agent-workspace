import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { listSessions, listTranscriptSubkeys, loadTranscript } from '../api';
import {
  appendSessionState,
  deleteSessionState,
  getSessionStateBlob,
  listSessionStateEntries,
  listSessionStateStreams,
  putSessionStateBlob,
  replaceSessionState,
} from '../state-api';

function stateEntriesResponse(request: Request, sessionId: string, method: string | undefined) {
  switch (method) {
    case 'POST':
      return appendSessionState(request, sessionId);
    case 'PUT':
      return replaceSessionState(request, sessionId);
    case 'DELETE':
      return deleteSessionState(request, sessionId);
    default:
      return listSessionStateEntries(request, sessionId);
  }
}

async function dispatchSessionRequest(
  request: Request,
  method: string | undefined,
): Promise<Response> {
  const segments = new URL(request.url).pathname.split('/').filter((one) => one.length > 0);
  let response: Response;
  if (segments.length === 2 && method === 'GET') {
    response = await listSessions(request);
  } else if (segments.length === 4 && segments[3] === 'state-entries') {
    response = await stateEntriesResponse(request, segments[2] ?? '', method);
  } else if (segments.length === 4 && segments[3] === 'state-streams') {
    response = await listSessionStateStreams(request, segments[2] ?? '');
  } else if (segments.length === 4 && segments[3] === 'state-blobs') {
    const id = segments[2] ?? '';
    response =
      method === 'PUT'
        ? await putSessionStateBlob(request, id)
        : await getSessionStateBlob(request, id);
  } else if (segments.length === 4 && segments[3] === 'transcript' && method === 'GET') {
    response = await loadTranscript(request, segments[2] ?? '');
  } else if (segments.length === 4 && segments[3] === 'subkeys') {
    response = await listTranscriptSubkeys(request, segments[2] ?? '');
  } else {
    response = new Response('{"error":{"code":"not_found","message":"no such route"}}', {
      status: 404,
    });
  }
  return response;
}

async function respondToSessionRequest(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  chunks: readonly Buffer[],
): Promise<void> {
  const body = Buffer.concat(chunks);
  const request = new Request(`http://127.0.0.1${incoming.url ?? '/'}`, {
    ...(incoming.method === undefined ? {} : { method: incoming.method }),
    headers: Object.entries(incoming.headers).flatMap(([name, value]) =>
      typeof value === 'string' ? [[name, value] as [string, string]] : [],
    ),
    ...(body.length === 0 ? {} : { body: new Uint8Array(body) }),
  });
  const response = await dispatchSessionRequest(request, incoming.method);
  outgoing.writeHead(response.status, Object.fromEntries(response.headers));
  outgoing.end(Buffer.from(await response.arrayBuffer()));
}

/** Bridge the plain HTTP fixture to the same handlers the App Router calls. */
export function createSessionMirrorServer() {
  return createServer((incoming, outgoing) => {
    const chunks: Buffer[] = [];
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
    incoming.on('end', () => {
      void respondToSessionRequest(incoming, outgoing, chunks);
    });
  });
}
