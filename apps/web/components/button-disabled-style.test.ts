import { describe, expect, it } from 'vitest';

import { BTN as AGENT_BTN } from './agents/agent-form-styles';
import { BTN as PROJECT_BTN } from './projects/project-form';
import { BUTTON } from './resources/resource-styles';

// A disabled button must look disabled (ui/assets/app.css: `.btn[disabled] { opacity: .45 }`):
// the shared classes carry it, so a screen cannot forget it (seen on the Schedules tab).
describe('the shared button classes look disabled when disabled', () => {
  it.each([
    ['agents BTN', AGENT_BTN],
    ['projects BTN', PROJECT_BTN],
    ['resources BUTTON', BUTTON],
  ])('%s', (_name, classes) => {
    expect(classes.split(' ')).toEqual(
      expect.arrayContaining(['disabled:opacity-[.45]', 'disabled:cursor-not-allowed']),
    );
  });
});
