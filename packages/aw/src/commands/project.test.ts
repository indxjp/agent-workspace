import { describe } from 'vitest';
import { describeProjectCatalogTools } from './project.catalog-tools.test-support.js';
import { describeProjectCheckFiles } from './project.check-files.test-support.js';
import { describeProjectCheckPlanning } from './project.check-planning.test-support.js';
import { describeProjectCheckSkills } from './project.check-skills.test-support.js';
import { describeProjectCheckValidation } from './project.check-validation.test-support.js';
import { describeProjectCodeTools } from './project.code-tools.test-support.js';
import { describeProjectConfiguration } from './project.configuration.test-support.js';
import { describeProjectLoader } from './project.loader.test-support.js';
import { describeProjectPushSkills } from './project.push-skills.test-support.js';
import { describeProjectPush } from './project.push.test-support.js';

describe('aw check', () => {
  describeProjectCheckPlanning();
  describeProjectCheckValidation();
  describeProjectCheckFiles();
});

describe('loadProject', () => {
  describeProjectLoader();
});

describe('aw push', () => {
  describeProjectPush();
});

describe('aw check and aw push read agent-workspace.yaml (issue #547)', () => {
  describeProjectConfiguration();
});

describe('aw check and aw push with catalog tools (issue #549)', () => {
  describeProjectCatalogTools();
});

describe('aw check with skills/ folders (issue #694)', () => {
  describeProjectCheckSkills();
});

describe('aw push with skills/ folders (issue #694)', () => {
  describeProjectPushSkills();
});

describe('aw push with code tools (issue #790)', () => {
  describeProjectCodeTools();
});
