import { type IncomingMessage, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { type Logger } from '@agent-workspace/core/telemetry';
import {
  ArchiveTooLargeError,
  ArchiveValidationError,
  extractUstarStream,
} from '@agent-workspace/runtime/transfer';
import { collectWorkspace } from './files.js';
import { sendError, sendJson, sendMethodNotAllowed } from './http-io.js';

const FILES_NOT_FOUND = 'the requested workspace path does not exist.';

const FILES_FAILED = 'the workspace files could not be processed.';

function isMissingPath(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/** Typed `/files` failures: only the codec's own validation messages (relative paths) are sent. */
function sendFilesFailure(
  res: ServerResponse,
  log: Logger,
  error: unknown,
  invalidCode: string,
): void {
  if (error instanceof ArchiveTooLargeError) {
    sendError(res, 413, 'archive_too_large', error.message);
  } else if (error instanceof ArchiveValidationError) {
    sendError(res, 400, invalidCode, error.message);
  } else {
    log.error('/files failed', { error });
    sendError(res, 500, 'internal_error', FILES_FAILED);
  }
}

export async function handleFiles(input: {
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  requestUrl: URL;
  workspacePath: string;
  maxFileArchiveBytes: number;
  maxFileArchiveMembers: number;
  log: Logger;
}): Promise<void> {
  const {
    req,
    res,
    method,
    requestUrl,
    workspacePath,
    maxFileArchiveBytes,
    maxFileArchiveMembers,
    log,
  } = input;
  if (method === 'POST') {
    try {
      const files = await extractUstarStream(
        Readable.toWeb(req) as ReadableStream<Uint8Array>,
        workspacePath,
        { maxBytes: maxFileArchiveBytes, maxMembers: maxFileArchiveMembers },
      );
      sendJson(res, 200, { hydrated: files });
    } catch (error) {
      sendFilesFailure(res, log, error, 'invalid_archive');
    }
    return;
  }
  if (method === 'GET') {
    try {
      const archive = await collectWorkspace(
        workspacePath,
        requestUrl.searchParams.getAll('path'),
        maxFileArchiveBytes,
      );
      res.writeHead(200, {
        'Content-Type': 'application/x-tar',
        'Cache-Control': 'no-store',
        'Content-Length': String(archive.byteLength),
      });
      res.end(Buffer.from(archive));
    } catch (error) {
      if (isMissingPath(error)) sendError(res, 404, 'file_not_found', FILES_NOT_FOUND);
      else sendFilesFailure(res, log, error, 'invalid_file_request');
    }
    return;
  }
  sendMethodNotAllowed(res, '/files', 'GET, POST');
  return;
}
