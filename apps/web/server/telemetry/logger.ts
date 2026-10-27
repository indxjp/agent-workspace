import { createJsonLogger } from '@agent-workspace/core/telemetry';

/** The web app's one structured logger (F-04): JSON lines on stdout/stderr.
 * The port redacts field values (errors included), never `msg`: a message must not carry untrusted text. */
export const log = createJsonLogger({ service: 'web' });
