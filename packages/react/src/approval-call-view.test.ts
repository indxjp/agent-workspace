import { canonicalCall } from '@indx-workspace/contracts/agents';
import { describe, expect, it } from 'vitest';

import { approvalCallView } from './approval-call-view.js';

const call = (toolName: string, input: unknown) => ({
  toolName,
  canonicalCall: canonicalCall(toolName, input),
});

describe('approvalCallView (#2091 follow-up)', () => {
  it('shows a shell call that is only a command as the command alone', () => {
    expect(
      approvalCallView(
        call('Bash', { command: 'mkdir -p outputs && ls', description: 'Make the folder' }),
      ),
    ).toEqual({ kind: 'command', command: 'mkdir -p outputs && ls' });
    expect(approvalCallView(call('Bash', { command: 'rm -rf build' }))).toEqual({
      kind: 'command',
      command: 'rm -rf build',
    });
  });

  it('keeps the command exactly, newlines and spacing included', () => {
    const command = "printf '# Q3\\n' > a.md\n  cat a.md";
    expect(approvalCallView(call('Bash', { command }))).toEqual({ kind: 'command', command });
  });

  it('shows the whole call when a shell call carries any other argument', () => {
    for (const extra of [
      { timeout: 600000 },
      { run_in_background: true },
      { dangerouslyDisableSandbox: true },
    ]) {
      const view = approvalCallView(call('Bash', { command: 'ls', ...extra }));
      expect(view.kind).toBe('json');
      if (view.kind === 'json') expect(view.text).toContain(Object.keys(extra)[0]);
    }
  });

  it('shows the whole call when the command is blank or not a string, or the description is not text', () => {
    for (const input of [
      { command: '   ' },
      { command: ['ls'] },
      {},
      { command: 'ls', description: { text: 'x' } },
    ]) {
      expect(approvalCallView(call('Bash', input)).kind).toBe('json');
    }
  });

  it('shows the whole call when the command holds characters a page would hide', () => {
    for (const command of [
      'ls\rrm -rf ~',
      'echo ok\b\b\brm',
      'echo \u001b[8mhidden\u001b[0m',
      'echo \u202Efdp.exe',
      'rm\u200B -rf build',
    ]) {
      const view = approvalCallView(call('Bash', { command }));
      expect(view.kind, JSON.stringify(command)).toBe('json');
    }
    expect(approvalCallView(call('Bash', { command: 'a\tb\nc' })).kind).toBe('command');
  });

  it('shows any other tool in full, pretty-printed', () => {
    const view = approvalCallView(call('Write', { file_path: 'a.md', content: 'hi' }));
    expect(view).toEqual({
      kind: 'json',
      text: JSON.stringify({ input: { content: 'hi', file_path: 'a.md' }, name: 'Write' }, null, 2),
    });
  });

  it('shows the text as it arrived when it is not this tool’s canonical call', () => {
    for (const canonical of [
      'not json',
      '{"to":"<b>boss</b>"}',
      '{"input":{"command":"ls"},"name":"Other"}',
      '{"input":{"command":"ls"},"name":"Bash","extra":1}',
      '["Bash"]',
    ]) {
      expect(approvalCallView({ toolName: 'Bash', canonicalCall: canonical })).toEqual({
        kind: 'raw',
        text: canonical,
      });
    }
  });
});
