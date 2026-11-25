import { describe, expect, it } from 'vitest';

import {
  DEMO_RECORD_KINDS,
  DEMO_RECORD_SAMPLES,
  DEMO_RECORD_SCHEMAS,
  DemoRecordWriteAnswerSchema,
  DemoSeedConnectorSchema,
} from './demo-operator.js';

describe('the records a demo stand-in keeps (ADR-0169)', () => {
  it.each(DEMO_RECORD_KINDS)('admits the %s sample in Japanese and in English', (kind) => {
    const schema = DEMO_RECORD_SCHEMAS[kind];
    expect(schema.safeParse(DEMO_RECORD_SAMPLES[kind].ja).success).toBe(true);
    expect(schema.safeParse(DEMO_RECORD_SAMPLES[kind].en).success).toBe(true);
  });

  it.each(DEMO_RECORD_KINDS)(
    'refuses a %s record with an unknown key or a missing field',
    (kind) => {
      const schema = DEMO_RECORD_SCHEMAS[kind];
      expect(schema.safeParse({ ...DEMO_RECORD_SAMPLES[kind].en, password: 'x' }).success).toBe(
        false,
      );
      expect(schema.safeParse({}).success).toBe(false);
    },
  );

  it('refuses an event or a booking that ends before it starts, naming the end', () => {
    for (const kind of ['calendar', 'booking'] as const) {
      const sample = DEMO_RECORD_SAMPLES[kind].en;
      const parsed = DEMO_RECORD_SCHEMAS[kind].safeParse({ ...sample, end: sample.start });
      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues.map((issue) => issue.path.join('.'))).toEqual(['end']);
    }
  });

  it('names only the field of a time that is not a time, never the end as well', () => {
    for (const field of ['start', 'end'] as const) {
      const sample = DEMO_RECORD_SAMPLES.booking.en;
      const parsed = DEMO_RECORD_SCHEMAS.booking.safeParse({ ...sample, [field]: 'tomorrow' });
      expect(parsed.error?.issues.map((issue) => issue.path.join('.'))).toEqual([field]);
    }
  });

  it('refuses a time with no offset, a date that is not a date, and text over its bound', () => {
    const calendar = DEMO_RECORD_SAMPLES.calendar.en;
    expect(
      DEMO_RECORD_SCHEMAS.calendar.safeParse({ ...calendar, start: '2026-12-01T10:00:00' }).success,
    ).toBe(false);
    const task = DEMO_RECORD_SAMPLES.task.en;
    expect(DEMO_RECORD_SCHEMAS.task.safeParse({ ...task, due: 'tomorrow' }).success).toBe(false);
    expect(DEMO_RECORD_SCHEMAS.task.safeParse({ ...task, title: 'x'.repeat(201) }).success).toBe(
      false,
    );
    const access = DEMO_RECORD_SAMPLES.access.en;
    expect(DEMO_RECORD_SCHEMAS.access.safeParse({ ...access, level: 'root' }).success).toBe(false);
  });

  it('answers a kept record or a typed refusal, and nothing else', () => {
    expect(
      DemoRecordWriteAnswerSchema.safeParse({
        demoOnly: true,
        recorded: true,
        tool: 'event_create',
        record: { id: 'calendar-1' },
      }).success,
    ).toBe(true);
    expect(
      DemoRecordWriteAnswerSchema.safeParse({
        demoOnly: true,
        recorded: false,
        tool: 'event_create',
        code: 'demo_record_invalid',
        issues: [{ path: 'end', message: 'must end after it starts' }],
      }).success,
    ).toBe(true);
    expect(
      DemoRecordWriteAnswerSchema.safeParse({
        demoOnly: true,
        recorded: false,
        tool: 'event_create',
        code: 'sent',
      }).success,
    ).toBe(false);
  });
});

describe('a declared connector with recorded writes', () => {
  const calendar = {
    name: 'calendar',
    reads: ['event_list'],
    writes: ['event_create'],
  } as const;

  it('is unchanged without recorded writes, and takes one that names its own tools', () => {
    expect(DemoSeedConnectorSchema.safeParse(calendar).success).toBe(true);
    const parsed = DemoSeedConnectorSchema.parse({
      ...calendar,
      recorded: [{ write: 'event_create', kind: 'calendar', read: 'event_list' }],
    });
    expect(parsed.recorded).toEqual([
      { write: 'event_create', kind: 'calendar', read: 'event_list' },
    ]);
  });

  it('refuses a recorded write that is not its write tool, a read that is not its read tool, and a write named twice', () => {
    const parsed = DemoSeedConnectorSchema.safeParse({
      ...calendar,
      recorded: [
        { write: 'event_delete', kind: 'calendar', read: 'event_list' },
        { write: 'event_create', kind: 'calendar', read: 'room_list' },
        { write: 'event_create', kind: 'calendar', read: 'event_list' },
      ],
    });
    expect(parsed.error?.issues.map((issue) => issue.path.join('.'))).toEqual([
      'recorded.0.write',
      'recorded.1.read',
      'recorded.2.write',
    ]);
  });

  it('refuses an unknown kind', () => {
    expect(
      DemoSeedConnectorSchema.safeParse({
        ...calendar,
        recorded: [{ write: 'event_create', kind: 'email', read: 'event_list' }],
      }).success,
    ).toBe(false);
  });
});
