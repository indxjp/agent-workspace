import { APPS } from './apps.ts';
import { GALLERY } from './gallery.ts';
import type { Recorder } from './types.ts';

/** Every live entry's recorder, by catalog slug. */
export const RECORDERS: Readonly<Record<string, Recorder>> = { ...GALLERY, ...APPS };
