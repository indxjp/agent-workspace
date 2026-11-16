import { describe, expect, it } from 'vitest';

import type { DefinitionChange } from '@indx-workspace/sdk/portable';

import { changeInWords } from './builder-approval-words';

const set = (section: DefinitionChange['section'], path: string, after: unknown) =>
  changeInWords({ section, path, after });
const edit = (
  section: DefinitionChange['section'],
  path: string,
  before: unknown,
  after: unknown,
) => changeInWords({ section, path, before, after });

describe('changeInWords (UX-11)', () => {
  it('names a permission and says allowed or not', () => {
    expect(set('permissions', 'definition.agent.permissions.readFiles', true)).toEqual({
      label: 'Read files',
      value: 'Allowed',
    });
    expect(edit('permissions', 'definition.agent.permissions.runCommands', false, true)).toEqual({
      label: 'Run commands',
      value: 'Not allowed → Allowed',
    });
  });

  it('reads a null model or connection as the deployment default, a null runtime as the workspace default', () => {
    expect(set('model', 'definition.agent.model', null)).toEqual({
      label: 'Model',
      value: 'Deployment default',
    });
    expect(set('model', 'definition.agent.modelConnectionName', null).label).toBe(
      'Model connection',
    );
    expect(set('runtime', 'definition.agent.runtimeProfileName', null)).toEqual({
      label: 'Runtime profile',
      value: 'Workspace default',
    });
  });

  it('names the tool policy fields', () => {
    expect(set('policy', 'definition.policy.tools.base', 'claude_code_preset')).toEqual({
      label: 'Tool set',
      value: 'Claude Code preset',
    });
    expect(
      edit('policy', 'definition.policy.tools.allowDangerouslySkipPermissions', false, true),
    ).toEqual({ label: 'Skip permission checks', value: 'No → Yes' });
    expect(edit('policy', 'definition.policy.tools.permissionMode', 'default', 'plan')).toEqual({
      label: 'Permission mode',
      value: '"default" → "plan"',
    });
  });

  it('says a list entry was added or removed, with its name', () => {
    expect(set('resources', 'definition.resources.connectors["crm"]', true)).toEqual({
      label: 'Connector: crm',
      value: 'Added',
    });
    expect(edit('policy', 'definition.policy.tools.deny["WebFetch"]', true, undefined)).toEqual({
      label: 'Blocked tool: WebFetch',
      value: 'Removed',
    });
    expect(
      set('policy', 'definition.policy.tools.autoApprove["Bash(git status)"]', true).label,
    ).toBe('Used without asking: Bash(git status)');
    expect(set('resources', 'definition.resources.files["receipts/"]', 'read')).toEqual({
      label: 'File access: receipts/',
      value: 'Added: Read only',
    });
    expect(
      edit('resources', 'definition.resources.files["receipts/"]', 'read', 'read-write').value,
    ).toBe('Read only → Read and write');
    expect(set('resources', 'definition.resources.skills["memo"].revision', 3)).toEqual({
      label: 'Skill version: memo',
      value: 'Added: 3',
    });
  });

  it('shows what a changed entry was and what it becomes', () => {
    expect(edit('resources', 'definition.resources.skills["memo"].revision', 3, 4)).toEqual({
      label: 'Skill version: memo',
      value: '3 → 4',
    });
    expect(edit('tools', 'toolBundles["pdf"]', 'sha256:aa', 'sha256:bb')).toEqual({
      label: 'Code tool: pdf',
      value: '"sha256:aa" → "sha256:bb"',
    });
    expect(edit('tools', 'toolBundles["pdf"].timeoutMs', 30000, 60000)).toEqual({
      label: 'Code tool timeout (ms): pdf',
      value: '30000 → 60000',
    });
  });

  it("names a code tool's domains and secrets, and a file listed twice", () => {
    expect(set('tools', 'toolBundles["pdf"].allowedDomains["example.com"]', true)).toEqual({
      label: 'Code tool pdf may reach: example.com',
      value: 'Added',
    });
    expect(set('tools', 'toolBundles["pdf"].secrets["API_KEY"]', true)).toEqual({
      label: 'Code tool pdf uses secret: API_KEY',
      value: 'Added',
    });
    expect(set('resources', 'definition.resources.files["a/"]#2', 'read-write')).toEqual({
      label: 'File access: a/ (entry 2)',
      value: 'Added: Read and write',
    });
  });

  it('quotes a name with space at either end, so it never reads as another', () => {
    expect(set('resources', 'definition.resources.connectors["crm "]', true).label).toBe(
      'Connector: "crm "',
    );
    expect(set('resources', 'definition.resources.connectors[""]', true).label).toBe(
      'Connector: ""',
    );
  });

  it('keeps a quoted string exactly, so two values never look the same', () => {
    expect(set('instructions', 'definition.agent.instructions', 'Ask\u200B first.').value).toBe(
      '"Ask<U+200B> first."',
    );
    expect(
      set('policy', 'definition.policy.tools.autoApprove["Bash(git\u00A0status)"]', true).label,
    ).toBe('Used without asking: Bash(git<U+00A0>status)');
  });

  it('shows a path it does not know as the path itself, never hides it', () => {
    expect(set('tools', 'toolBundles["pdf"].mounts["x"]', true)).toEqual({
      label: 'toolBundles["pdf"].mounts["x"]',
      value: 'Yes',
    });
    expect(set('resources', String.raw`definition.resources.connectors["\x"]`, true).label).toBe(
      String.raw`definition.resources.connectors["\x"]`,
    );
    expect(set('description', 'constructor', null)).toEqual({
      label: 'constructor',
      value: 'None',
    });
    expect(set('policy', 'definition.policy.tools.base[not json]', true).label).toBe(
      'definition.policy.tools.base[not json]',
    );
  });
});
