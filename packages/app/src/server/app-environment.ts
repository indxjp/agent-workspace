/**
 * The environment variables `appRuntime` and `serveRecipes` both read, defined once so the two
 * cannot drift: a value one accepts and the other refuses fails only at the later boot.
 */
import { API_KEY_PREFIX } from '@indx-workspace/contracts/api-keys';
import { z } from 'zod';

import { appSchemaName } from '../db/schema-name.js';

/** Whether `name` is a valid app name, the key of the app's `app_<name>` schema. */
export function isAppName(name: string): boolean {
  try {
    appSchemaName(name);
    return true;
  } catch {
    return false;
  }
}

const API_KEY = /^[A-Za-z0-9_\-.~]{1,512}$/u;

/** `AW_APP_API_KEY`: the app's machine key, in the platform's prefix and a header-safe alphabet. */
export const AppApiKeySchema = z.string().startsWith(API_KEY_PREFIX).regex(API_KEY);
