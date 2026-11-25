/**
 * The use case's contract and moment tiers (use-cases/README.md). An entry with code beyond its
 * agent and surface definitions lists a flow that runs it.
 */
import { describeUseCase } from '../kit/describe-use-case.ts';
import agent from './agents/maintenance.ts';
import surface from './surfaces/main.ts';

describeUseCase('maintenance', {
  definitions: { 'agents/maintenance.ts': agent, 'surfaces/main.ts': surface },
});
