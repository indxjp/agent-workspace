// @vitest-environment happy-dom
/**
 * UX-18 in #2086: the agent screen's Schedules tab. The model runs directly; the screen is mounted
 * against the SDK's fetch double, so each test sees the exact requests it sends.
 */
import type { TriggerResource } from '@indx-workspace/contracts/triggers';
import { ApiProblemError, createClient } from '@indx-workspace/sdk';
import {
  fetchDouble,
  jsonResponse,
  type FetchDouble,
  type RecordedRequest,
} from '@indx-workspace/sdk/testing';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentTabs } from './platforms';
import { agentTab } from './platforms-model';
import { AgentSchedulesScreen } from './schedules';
import { scheduleRefusalText, schedulesStrings } from './schedules-messages';
import {
  agentSchedules,
  formatRunTime,
  nextRun,
  presetCron,
  problemCode,
  scheduleProblem,
} from './schedules-model';

const double: { current: FetchDouble } = {
  current: fetchDouble(() => jsonResponse(500, { error: { code: 'unset', message: 'unset' } })),
};
vi.mock('../../lib/browser-client', () => ({
  browserClient: () =>
    createClient({
      baseUrl: 'https://aw.example.com',
      auth: { kind: 'session' },
      fetch: (input, init) => double.current.fetch(input, init),
    }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const AGENT = '11111111-1111-4111-8111-111111111111';
const OTHER_AGENT = '22222222-2222-4222-8222-222222222222';
const OWNER = '33333333-3333-4333-8333-333333333333';

function trigger(
  overrides: Partial<TriggerResource> & { id: string; name: string },
): TriggerResource {
  return {
    kind: 'schedule',
    agentId: AGENT,
    prompt: 'Summarise yesterday.',
    cron: '0 9 * * *',
    timezone: 'Asia/Tokyo',
    enabled: true,
    outputSchema: null,
    subject: null,
    ownerPrincipalId: OWNER,
    hasSecret: false,
    hasZoomSecretToken: false,
    lastFiredAt: null,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    ...overrides,
  };
}

const DAILY = trigger({ id: '44444444-4444-4444-8444-444444444444', name: 'daily-report' });
const PAUSED = trigger({
  id: '55555555-5555-4555-8555-555555555555',
  name: 'paused-one',
  enabled: false,
  cron: '30 8 * * 1-5',
});
const WEBHOOK = trigger({
  id: '66666666-6666-4666-8666-666666666666',
  name: 'a-webhook',
  kind: 'webhook',
  cron: null,
  timezone: null,
  hasSecret: true,
});
const OTHERS = trigger({
  id: '77777777-7777-4777-8777-777777777777',
  name: 'other-agent',
  agentId: OTHER_AGENT,
});

describe('the schedules model', () => {
  it("lists only this agent's schedule triggers, by name", () => {
    expect(agentSchedules([PAUSED, WEBHOOK, OTHERS, DAILY], AGENT).map((t) => t.name)).toEqual([
      'daily-report',
      'paused-one',
    ]);
  });

  it('finds the next run in the schedule’s own time zone', () => {
    const after = new Date('2026-11-09T01:00:00.000Z'); // 10:00 in Tokyo
    expect(nextRun('0 9 * * *', 'Asia/Tokyo', after)?.toISOString()).toBe(
      '2026-11-10T00:00:00.000Z',
    );
    expect(nextRun('0 9 * * *', 'UTC', after)?.toISOString()).toBe('2026-11-09T09:00:00.000Z');
    expect(nextRun('not cron', 'UTC', after)).toBeNull();
    expect(nextRun('0 9 * * *', 'Mars/Base', after)).toBeNull();
  });

  it('explains a cron expression the server would refuse', () => {
    expect(scheduleProblem('0 9 * * *', 'Asia/Tokyo')).toBeNull();
    expect(scheduleProblem('0 9 * *', 'UTC')).toBe('fields');
    expect(scheduleProblem('0 0 9 * * *', 'UTC')).toBe('fields');
    expect(scheduleProblem('99 9 * * *', 'UTC')).toBe('invalid');
    expect(scheduleProblem('0 9 * * *', 'Mars/Base')).toBe('invalid');
    expect(scheduleProblem('0 0 30 2 *', 'UTC')).toBe('never');
    // croner reads an empty zone as the local time; the server and the preview would not.
    expect(scheduleProblem('0 9 * * *', '')).toBe('timezone');
    expect(scheduleProblem('0 9 * * *', '   ')).toBe('timezone');
  });

  it('turns a preset into its cron expression, and custom into the typed one', () => {
    expect(presetCron('weekdays', 'ignored')).toBe('0 9 * * 1-5');
    expect(presetCron('custom', '  15 7 * * *  ')).toBe('15 7 * * *');
  });

  it('names the zone after the time, so nobody converts from UTC', () => {
    const at = new Date('2026-11-10T00:00:00.000Z');
    expect(formatRunTime(at, 'Asia/Tokyo', 'en')).toMatch(/09:00 \(Asia\/Tokyo\)$/u);
    expect(formatRunTime(at, 'UTC', 'en')).toMatch(/00:00 \(UTC\)$/u);
    expect(formatRunTime(at, 'Asia/Tokyo', 'ja')).toMatch(/9:00 \(Asia\/Tokyo\)$/u);
  });

  it('formats nothing, rather than throwing, for a zone Intl does not know', () => {
    const at = new Date('2026-11-10T00:00:00.000Z');
    expect(formatRunTime(at, '', 'en')).toBeNull();
    expect(formatRunTime(at, 'Mars/Base', 'ja')).toBeNull();
  });

  it('reads a problem code, and nothing from any other error', () => {
    const problem = new ApiProblemError({
      status: 409,
      problem: { code: 'trigger_name_taken', message: 'taken' },
    });
    expect(problemCode(problem)).toBe('trigger_name_taken');
    expect(problemCode(new Error('offline'))).toBeNull();
  });

  it('words each refusal, and falls back to a generic sentence', () => {
    const en = schedulesStrings('en');
    expect(scheduleRefusalText('trigger_name_taken', en)).toContain('already exists');
    expect(scheduleRefusalText('forbidden', en)).toContain('role');
    expect(scheduleRefusalText('something_new', en)).toBe(en.failed);
    expect(scheduleRefusalText(null, en)).toBe(en.failed);
    expect(scheduleRefusalText('trigger_name_taken', schedulesStrings('ja'))).toContain('名前');
  });
});

describe('the Schedules tab link', () => {
  const tabs = (schedules: boolean) =>
    renderToStaticMarkup(
      <AgentTabs agentId="a1" current={agentTab('schedules')} locale="en" schedules={schedules} />,
    );

  it('opens the Schedules tab for tab=schedules', () => {
    expect(agentTab('schedules')).toBe('schedules');
    expect(tabs(true)).toMatch(/aria-current="page"[^>]*>Schedules</u);
    expect(tabs(true)).toContain('href="/agents/a1?tab=schedules"');
  });

  it('hides the tab while triggers are switched off', () => {
    expect(tabs(false)).not.toContain('Schedules');
  });
});

let unmount: (() => void) | undefined;
afterEach(() => {
  unmount?.();
  unmount = undefined;
  document.body.innerHTML = '';
});

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

async function mount(locale: 'en' | 'ja' = 'en'): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => {
    root.render(<AgentSchedulesScreen agentId={AGENT} locale={locale} />);
  });
  unmount = () => {
    act(() => {
      root.unmount();
    });
  };
  await settle();
  return host;
}

/** Answer the list with `triggers`, and each write with `write` (default: echo a trigger). */
function serve(
  triggers: readonly TriggerResource[],
  write: (request: RecordedRequest) => Response = () => jsonResponse(200, { trigger: DAILY }),
): void {
  double.current = fetchDouble((request) =>
    request.method === 'GET' && request.url.pathname === '/api/triggers'
      ? jsonResponse(200, { triggers })
      : write(request),
  );
}

const writes = () => double.current.calls.filter((call) => call.method !== 'GET');

function button(host: HTMLElement, name: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find(
    (candidate) => (candidate.getAttribute('aria-label') ?? candidate.textContent) === name,
  );
  if (found === undefined) throw new Error(`no button ${name}`);
  return found;
}

function type(field: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype =
    field instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function choose(field: HTMLSelectElement, value: string): void {
  act(() => {
    field.value = value;
    field.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function field<T extends HTMLElement>(host: HTMLElement, label: string): T {
  const found = [...host.querySelectorAll('label')].find((each) => each.textContent === label);
  const id = found?.getAttribute('for');
  const control = id === null || id === undefined ? null : host.ownerDocument.getElementById(id);
  if (control === null) throw new Error(`no field ${label}`);
  return control as T;
}

describe('the Schedules tab', () => {
  it('is the page’s one main landmark and lists only this agent’s schedules', async () => {
    serve([PAUSED, WEBHOOK, OTHERS, DAILY]);
    const host = await mount();
    expect(host.querySelectorAll('main')).toHaveLength(1);
    const items = host.querySelectorAll('ul[aria-label="Schedules of this agent"] > li');
    expect([...items].map((item) => item.querySelector('.font-mono')?.textContent)).toEqual([
      'daily-report',
      'paused-one',
    ]);
    expect(host.textContent).toContain('Every day at 09:00');
    expect(host.textContent).toContain('(Asia/Tokyo)');
    expect(host.textContent).toContain('— (paused)');
    expect(host.textContent).toContain('30 8 * * 1-5');
  });

  it('says so when the agent has no schedules', async () => {
    serve([WEBHOOK]);
    const host = await mount();
    expect(host.textContent).toContain('This agent has no schedules yet.');
  });

  it('tells a Viewer who may see schedules, instead of an error', async () => {
    double.current = fetchDouble(() =>
      jsonResponse(403, { error: { code: 'forbidden', message: 'no' } }),
    );
    const host = await mount();
    expect(host.textContent).toContain('Only an Owner, an Admin or a Builder');
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it('reports a list that could not be loaded', async () => {
    double.current = fetchDouble(() =>
      jsonResponse(500, { error: { code: 'internal', message: 'x' } }),
    );
    const host = await mount();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('could not be loaded');
  });

  it('pauses and resumes with one PATCH of enabled, then reads the list again', async () => {
    serve([DAILY, PAUSED]);
    const host = await mount();
    act(() => {
      button(host, 'Pause daily-report').click();
    });
    await settle();
    act(() => {
      button(host, 'Resume paused-one').click();
    });
    await settle();
    expect(writes().map((call) => [call.method, call.url.pathname, call.json])).toEqual([
      ['PATCH', `/api/triggers/${DAILY.id}`, { enabled: false }],
      ['PATCH', `/api/triggers/${PAUSED.id}`, { enabled: true }],
    ]);
    expect(double.current.calls.filter((call) => call.method === 'GET')).toHaveLength(3);
  });

  it('asks before deleting; Keep and Escape send nothing, Delete sends one DELETE', async () => {
    serve([DAILY]);
    const host = await mount();
    act(() => {
      button(host, 'Delete daily-report').click();
    });
    expect(host.textContent).toContain('Delete the schedule daily-report?');
    expect(document.activeElement?.textContent).toBe('Keep');
    act(() => {
      button(host, 'Keep').click();
    });
    act(() => {
      button(host, 'Delete daily-report').click();
    });
    const group = host.querySelector('[role="group"]');
    act(() => {
      group?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(host.querySelector('[role="group"]')).toBeNull();
    expect(writes()).toHaveLength(0);
    act(() => {
      button(host, 'Delete daily-report').click();
    });
    act(() => {
      button(host.querySelector('[role="group"]') as HTMLElement, 'Delete').click();
    });
    await settle();
    expect(writes().map((call) => [call.method, call.url.pathname])).toEqual([
      ['DELETE', `/api/triggers/${DAILY.id}`],
    ]);
  });

  it('shows the refusal of a change in plain words, on that schedule', async () => {
    serve([DAILY], () => jsonResponse(403, { error: { code: 'forbidden', message: 'no' } }));
    const host = await mount();
    act(() => {
      button(host, 'Pause daily-report').click();
    });
    await settle();
    expect(host.querySelector('li [role="alert"]')?.textContent).toBe(
      'Your role cannot change this schedule.',
    );
  });

  it('adds a schedule from a preset, in the chosen zone, and announces it', async () => {
    serve([], () => jsonResponse(201, { trigger: DAILY }));
    const host = await mount();
    type(field<HTMLInputElement>(host, 'Name'), 'morning-brief');
    type(field<HTMLTextAreaElement>(host, 'Prompt'), 'Brief me.');
    choose(field<HTMLSelectElement>(host, 'Repeats'), 'weekdays');
    type(field<HTMLInputElement>(host, 'Time zone'), 'Asia/Tokyo');
    expect(host.textContent).toMatch(/First run: .*09:00 \(Asia\/Tokyo\)/u);
    const submit = host.querySelector<HTMLButtonElement>('button[type="submit"]');
    expect(submit?.disabled).toBe(false);
    act(() => {
      submit?.closest('form')?.requestSubmit();
    });
    await settle();
    expect(writes().map((call) => [call.method, call.url.pathname, call.json])).toEqual([
      [
        'POST',
        '/api/triggers',
        {
          kind: 'schedule',
          name: 'morning-brief',
          agentId: AGENT,
          prompt: 'Brief me.',
          cron: '0 9 * * 1-5',
          timezone: 'Asia/Tokyo',
        },
      ],
    ]);
    expect(host.querySelector('[role="status"]')?.textContent).toBe(
      'Schedule morning-brief added.',
    );
    expect(field<HTMLInputElement>(host, 'Name').value).toBe('');
  });

  it('will not send a custom expression it can already tell is wrong', async () => {
    serve([]);
    const host = await mount();
    type(field<HTMLInputElement>(host, 'Name'), 'broken');
    type(field<HTMLTextAreaElement>(host, 'Prompt'), 'x');
    choose(field<HTMLSelectElement>(host, 'Repeats'), 'custom');
    type(field<HTMLInputElement>(host, 'Cron expression'), '0 9 * *');
    expect(host.textContent).toContain('A cron expression has exactly five fields.');
    expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
    type(field<HTMLInputElement>(host, 'Cron expression'), '15 7 * * *');
    expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false);
  });

  it('shows the server’s refusal of a new schedule in plain words', async () => {
    serve([], () => jsonResponse(409, { error: { code: 'trigger_name_taken', message: 'taken' } }));
    const host = await mount();
    type(field<HTMLInputElement>(host, 'Name'), 'daily-report');
    type(field<HTMLTextAreaElement>(host, 'Prompt'), 'x');
    act(() => {
      host.querySelector('form')?.requestSubmit();
    });
    await settle();
    expect(host.querySelector('form [role="alert"]')?.textContent).toContain('already exists');
    expect(field<HTMLInputElement>(host, 'Name').value).toBe('daily-report');
  });

  it('speaks Japanese when the page does', async () => {
    serve([DAILY]);
    const host = await mount('ja');
    expect(host.querySelector('main')?.getAttribute('lang')).toBe('ja');
    expect(host.textContent).toContain('スケジュールを追加');
    expect(host.textContent).toContain('毎日 09:00');
    expect(host.textContent).toContain('時刻を変更');
  });
});

describe("changing a schedule's time (ADR-0144 D5)", () => {
  const changeForm = (host: HTMLElement, name: string): HTMLFormElement => {
    const form = host.querySelector<HTMLFormElement>(`form[aria-label="Change when ${name} runs"]`);
    if (form === null) throw new Error(`no change form for ${name}`);
    return form;
  };

  it('re-times a schedule with one PATCH of cron and time zone, then reads the list again', async () => {
    serve([DAILY]);
    const host = await mount();
    expect(host.textContent).not.toContain('delete it and add it again');
    act(() => {
      button(host, 'Change when daily-report runs').click();
    });
    const form = changeForm(host, 'daily-report');
    expect(document.activeElement).toBe(field<HTMLSelectElement>(form, 'Repeats'));
    expect(field<HTMLSelectElement>(form, 'Repeats').value).toBe('daily');
    expect(field<HTMLInputElement>(form, 'Time zone').value).toBe('Asia/Tokyo');
    expect(button(form, 'Save time').disabled).toBe(true);
    expect(form.textContent).not.toContain('Next run after this change');
    choose(field<HTMLSelectElement>(form, 'Repeats'), 'weekdays');
    type(field<HTMLInputElement>(form, 'Time zone'), 'Europe/Paris');
    expect(form.textContent).toContain('Next run after this change:');
    expect(form.textContent).toContain('(Europe/Paris)');
    expect(button(form, 'Save time').disabled).toBe(false);
    act(() => {
      form.requestSubmit();
    });
    await settle();
    expect(writes().map((call) => [call.method, call.url.pathname, call.json])).toEqual([
      ['PATCH', `/api/triggers/${DAILY.id}`, { cron: '0 9 * * 1-5', timezone: 'Europe/Paris' }],
    ]);
    expect(host.textContent).toContain('Schedule daily-report now runs at the new time.');
    expect(host.querySelector('form[aria-label="Change when daily-report runs"]')).toBeNull();
    expect(double.current.calls.filter((call) => call.method === 'GET')).toHaveLength(2);
  });

  it('opens a custom expression as custom, refuses a wrong one, and Cancel or Escape send nothing', async () => {
    serve([PAUSED]);
    const host = await mount();
    act(() => {
      button(host, 'Change when paused-one runs').click();
    });
    let form = changeForm(host, 'paused-one');
    expect(field<HTMLSelectElement>(form, 'Repeats').value).toBe('custom');
    expect(field<HTMLInputElement>(form, 'Cron expression').value).toBe('30 8 * * 1-5');
    type(field<HTMLInputElement>(form, 'Cron expression'), '30 8 * *');
    expect(form.textContent).toContain('exactly five fields');
    expect(button(form, 'Save time').disabled).toBe(true);
    act(() => {
      form.requestSubmit();
    });
    act(() => {
      button(form, 'Cancel').click();
    });
    expect(host.querySelector('form[aria-label="Change when paused-one runs"]')).toBeNull();
    act(() => {
      button(host, 'Change when paused-one runs').click();
    });
    form = changeForm(host, 'paused-one');
    act(() => {
      form.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(host.querySelector('form[aria-label="Change when paused-one runs"]')).toBeNull();
    expect(writes()).toEqual([]);
  });

  it('shows the server’s refusal of a new time in plain words, and keeps the form open', async () => {
    serve([DAILY], () => jsonResponse(400, { error: { code: 'invalid_field', message: 'no' } }));
    const host = await mount();
    act(() => {
      button(host, 'Change when daily-report runs').click();
    });
    const form = changeForm(host, 'daily-report');
    choose(field<HTMLSelectElement>(form, 'Repeats'), 'hourly');
    act(() => {
      form.requestSubmit();
    });
    await settle();
    expect(form.querySelector('[role="alert"]')?.textContent).toContain(
      'The server did not accept this schedule',
    );
    expect(button(form, 'Save time').disabled).toBe(false);
  });
  it('keeps the tab when the time zone of the add form is emptied, and says what is missing', async () => {
    serve([DAILY]);
    const host = await mount();
    type(field<HTMLInputElement>(host, 'Name'), 'morning-brief');
    type(field<HTMLTextAreaElement>(host, 'Prompt'), 'Brief me.');
    type(field<HTMLInputElement>(host, 'Time zone'), '');
    expect(host.querySelector('main')).not.toBeNull();
    expect(host.textContent).toContain('Enter a time zone, for example Asia/Tokyo.');
    expect(host.textContent).not.toContain('First run:');
    expect(button(host, 'Add schedule').disabled).toBe(true);
  });

  it('keeps the tab when the zone of the Change time form is emptied, and says what is missing', async () => {
    serve([DAILY]);
    const host = await mount('ja');
    act(() => {
      button(host, 'daily-report の実行時刻を変更').click();
    });
    const form = host.querySelector<HTMLFormElement>(
      'form[aria-label="daily-report の実行時刻を変更"]',
    );
    if (form === null) throw new Error('no change form');
    type(field<HTMLInputElement>(form, 'タイムゾーン'), '');
    expect(host.querySelector('main')).not.toBeNull();
    expect(form.textContent).toContain('タイムゾーンを入力してください。');
    expect(button(form, '時刻を保存').disabled).toBe(true);
  });

  it('gives the focus back to Change time when its form closes: Cancel, Escape and Save', async () => {
    serve([DAILY]);
    const host = await mount();
    const opener = () => button(host, 'Change when daily-report runs');
    act(() => {
      opener().click();
    });
    act(() => {
      button(changeForm(host, 'daily-report'), 'Cancel').click();
    });
    expect(document.activeElement).toBe(opener());
    act(() => {
      opener().click();
    });
    act(() => {
      changeForm(host, 'daily-report').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(document.activeElement).toBe(opener());
    act(() => {
      opener().click();
    });
    const form = changeForm(host, 'daily-report');
    choose(field<HTMLSelectElement>(form, 'Repeats'), 'weekdays');
    act(() => {
      form.requestSubmit();
    });
    await settle();
    expect(document.activeElement).toBe(opener());
  });

  it('gives the focus back to Delete when Keep or Escape closes the question', async () => {
    serve([DAILY]);
    const host = await mount();
    const remove = () => button(host, 'Delete daily-report');
    act(() => {
      remove().click();
    });
    act(() => {
      button(host, 'Keep').click();
    });
    expect(document.activeElement).toBe(remove());
    act(() => {
      remove().click();
    });
    act(() => {
      host
        .querySelector('[role="group"]')
        ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(document.activeElement).toBe(remove());
    // Escape from the question's own Delete button lands on the row's Delete too.
    act(() => {
      remove().click();
    });
    const question = host.querySelector<HTMLElement>('[role="group"]');
    if (question === null) throw new Error('no question');
    act(() => {
      button(question, 'Delete').focus();
    });
    act(() => {
      question.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(document.activeElement).toBe(remove());
  });
});
