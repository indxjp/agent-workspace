import path from 'node:path';

export const ROOT = path.resolve(import.meta.dirname, '../../..');

export const CLOUDFLARE = 'https://api.cloudflare.com/client/v4';

/** One template of each kind per E2B lane (`-ve`, `-ce`), so the two lanes never create the same template at once. */
export const RUNTIME_TEMPLATE_PREFIX = 'aw-runtime-journey';

export const TOOL_HOST_TEMPLATE_PREFIX = 'aw-tool-host-journey';

export const NEON = 'https://console.neon.tech/api/v2';

export const SURFACE = 'main';
