import { APPS } from './apps.ts';
import { GALLERY } from './gallery.ts';
import type { Recorder } from './types.ts';
import { USE_CASE_RECORDS } from './use-cases-records.ts';
import { USE_CASE_SCRIPTS } from './use-cases-scripts.ts';
import { USE_CASE_DOCUMENTS } from './use-cases-documents.ts';
import { USE_CASES } from './use-cases.ts';

/** Every live entry's recorder, by catalog slug. */
export const RECORDERS: Readonly<Record<string, Recorder>> = {
  ...GALLERY,
  ...APPS,
  ...USE_CASES,
  ...USE_CASE_RECORDS,
  ...USE_CASE_SCRIPTS,
  ...USE_CASE_DOCUMENTS,
};
