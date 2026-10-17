/**
 * Every use case in the gallery, in the order its benchmark declares.
 *
 * The benchmarks are imported statically: the repository's import-boundary gate
 * (`tests/no-sdk-import.test.ts`) refuses a computed `import()`. `benchmark.test.ts` checks that
 * this list and the directories under `tests/gallery/` that hold a project file are the same, so
 * a use case added without registering it here fails there.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import cadDrafting from '../cad-drafting/benchmark.ts';
import contractReview from '../contract-review/benchmark.ts';
import customerInquiry from '../customer-inquiry/benchmark.ts';
import excelConsolidation from '../excel-consolidation/benchmark.ts';
import maintenanceTroubleshooting from '../maintenance-troubleshooting/benchmark.ts';
import manualSearch from '../manual-search/benchmark.ts';
import meetingMinutes from '../meeting-minutes/benchmark.ts';
import qualityDefect from '../quality-defect/benchmark.ts';
import quotation from '../quotation/benchmark.ts';
import ringiReview from '../ringi-review/benchmark.ts';
import type { Benchmark } from './benchmark.ts';

export const GALLERY_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPOSITORY_ROOT = path.resolve(GALLERY_DIR, '..', '..');
export const TUTORIALS_DIR = path.join(REPOSITORY_ROOT, 'docs', 'sdk', 'site', 'tutorials');

const BENCHMARKS: readonly Benchmark[] = [
  manualSearch,
  cadDrafting,
  quotation,
  ringiReview,
  customerInquiry,
  excelConsolidation,
  contractReview,
  meetingMinutes,
  maintenanceTroubleshooting,
  qualityDefect,
];

export interface UseCase {
  readonly dir: string;
  readonly benchmark: Benchmark;
}

export function loadUseCases(): UseCase[] {
  return [...BENCHMARKS]
    .sort((left, right) => left.order - right.order)
    .map((benchmark) => ({ dir: path.join(GALLERY_DIR, benchmark.id), benchmark }));
}
