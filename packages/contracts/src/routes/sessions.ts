import type { ApiRoute } from './definition.js';
import { BINARY, created, json, ok, UNDESCRIBED } from './definition.js';
export const sessionsRoutes: readonly ApiRoute[] = [
  // §5.11 — sessions, transcripts and engine session state
  {
    method: 'GET',
    path: '/api/sessions',
    operationId: 'sessions.list',
    tag: 'sessions',
    feature: 'chat',
    summary: 'List sessions',
    success: ok(json('SessionListResponseSchema')),
  },

  {
    method: 'GET',
    path: '/api/sessions/:engineSessionId',
    operationId: 'sessions.get',
    tag: 'sessions',
    feature: 'chat',
    summary: 'Read one session',
    success: ok(json('SessionResponseSchema')),
  },

  {
    method: 'PATCH',
    path: '/api/sessions/:engineSessionId',
    operationId: 'sessions.update',
    tag: 'sessions',
    feature: 'chat',
    summary: 'Rename or archive a session',
    request: UNDESCRIBED,
    success: ok(json('SessionResponseSchema')),
  },

  {
    method: 'GET',
    path: '/api/sessions/:engineSessionId/transcript',
    operationId: 'sessions.transcript.read',
    tag: 'sessions',
    feature: 'chat',
    summary: "Read a session's transcript",
    success: ok(json('TranscriptResponseSchema')),
  },

  {
    method: 'GET',
    path: '/api/sessions/:engineSessionId/subkeys',
    operationId: 'sessions.transcript.subkeys',
    tag: 'sessions',
    feature: 'chat',
    summary: "List a transcript's subkeys",
    success: ok(json('TranscriptSubkeysResponseSchema')),
  },

  {
    method: 'POST',
    path: '/api/sessions/:engineSessionId/attachments',
    operationId: 'sessions.attachments.upload',
    tag: 'sessions',
    feature: 'core',
    summary:
      "Upload one file (bytes, name in `name`) into a visitor's session, for `runs.start` `attachments`",
    request: BINARY,
    success: created(json('SurfaceAttachmentResponseSchema')),
  },
];
