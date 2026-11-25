/**
 * The use case's contract and moment tiers (use-cases/README.md). An entry with code beyond its
 * agent and surface definitions lists a flow that runs it.
 */
import { describeUseCase } from '../kit/describe-use-case.ts';
import agent from './agents/hr-qa.ts';
import surface from './surfaces/main.ts';

describeUseCase('hr-qa', {
  definitions: { 'agents/hr-qa.ts': agent, 'surfaces/main.ts': surface },
});
