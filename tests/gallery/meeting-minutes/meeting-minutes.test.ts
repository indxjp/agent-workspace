/**
 * Use case 8, the meeting minutes and action-item agent: the definition passes the contract, the
 * date script and the task tracker do their jobs, and the backend drafts minutes, then registers
 * the action items one run and one approval at a time, so only what a person approved is written.
 */
import { describe } from 'vitest';
import { defineDefinitionCases } from './meeting-minutes.definition.test-support.ts';
import { defineTrackerCases } from './meeting-minutes.tracker.test-support.ts';
import {
  defineDraftOutputCases,
  defineDraftRunCases,
} from './meeting-minutes.draft.test-support.ts';
import { defineApprovalCases } from './meeting-minutes.approval.test-support.ts';
describe('meeting minutes agent', () => {
  defineDefinitionCases();
  defineTrackerCases();
  defineDraftOutputCases();
  defineApprovalCases();
  defineDraftRunCases();
});
