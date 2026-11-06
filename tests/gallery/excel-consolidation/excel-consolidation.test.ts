import { describe } from 'vitest';
import { describeExcelApproval } from './excel-consolidation.approval.test-support.ts';
import { describeExcelConversion } from './excel-consolidation.conversion.test-support.ts';
import { describeExcelProject } from './excel-consolidation.project.test-support.ts';

describe('excel consolidation agent', () => {
  describeExcelProject();
  describeExcelConversion();
  describeExcelApproval();
});
