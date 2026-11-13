import { type RuntimeEnvironmentInput } from './env.js';

export const baseInput: RuntimeEnvironmentInput = {
  gatewayBaseUrl: 'https://gateway.internal.example/v1',
  authToken: 'run-token-aaa',
  configDir: '/sandbox/session-a/.claude',
  runId: 'run-aaa',
  sessionId: 'session-aaa',
  nodeMajorVersion: 20, // sub-24: drives the NODE_USE_ENV_PROXY-absent branch by default
  networkPolicy: 'open',
};

export const CONFIG_DIRECTORY = '.claude';
