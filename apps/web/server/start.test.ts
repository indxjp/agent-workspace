/**
 * Contract C2 (#441): `startWeb`'s options and posture check, and the build directory seam in
 * `next.config.ts`. Next.js itself is replaced by a spy; nothing here boots a server.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { readNextDistDir } from '../next.config';
import { closeHeldComposition, holdComposition } from './composition/held-composition';
import { startWeb, StartWebOptionsError, type StartWebOptions } from './start';

const mocks = vi.hoisted(() => ({ createNext: vi.fn() }));

vi.mock('next/dist/server/next.js', () => ({ default: mocks.createNext }));

/** A Next stand-in whose `prepare` fails, so `startWeb` stops right after `createNext`. */
const PREPARE_STOPPED = 'prepare stopped by the test';

function stopAtPrepare(): void {
  mocks.createNext.mockReturnValue({
    prepare: () => Promise.reject(new Error(PREPARE_STOPPED)),
    getRequestHandler: () => () => Promise.resolve(),
    close: () => Promise.resolve(),
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('startWeb', () => {
  it('rejects an unknown option with a typed error before Next is created', async () => {
    mocks.createNext.mockClear();
    const options = { dev: false, port: 4000 } as StartWebOptions;
    const failure = startWeb({ HOST: '127.0.0.1' }, options);
    await expect(failure).rejects.toBeInstanceOf(StartWebOptionsError);
    await expect(failure).rejects.toMatchObject({ code: 'invalid_start_options' });
    expect(mocks.createNext).not.toHaveBeenCalled();
  });

  it('rejects an empty dir with a typed error before Next is created', async () => {
    mocks.createNext.mockClear();
    await expect(startWeb({}, { dir: '' })).rejects.toBeInstanceOf(StartWebOptionsError);
    expect(mocks.createNext).not.toHaveBeenCalled();
  });

  it.each(['', '   ', ' 127.0.0.1'])(
    'rejects a local posture on HOST=%j, which Node would not bind as loopback',
    async (host) => {
      mocks.createNext.mockClear();
      await expect(
        startWeb({ NODE_ENV: 'production', AW_DEPLOYMENT_POSTURE: 'local', HOST: host }),
      ).rejects.toThrow('local posture needs a loopback HOST');
      expect(mocks.createNext).not.toHaveBeenCalled();
    },
  );

  it('binds 127.0.0.1, not every interface, when HOST is blank and no posture is set', async () => {
    mocks.createNext.mockClear();
    stopAtPrepare();
    await expect(startWeb({ NODE_ENV: 'production', HOST: '' })).rejects.toThrow(PREPARE_STOPPED);
    expect(mocks.createNext).toHaveBeenCalledWith(
      expect.objectContaining({ hostname: '127.0.0.1' }),
    );
  });

  it('refuses a public bind when process.env holds a local posture the sites will read', async () => {
    mocks.createNext.mockClear();
    vi.stubEnv('AW_DEPLOYMENT_POSTURE', 'local');
    vi.stubEnv('HOST', '127.0.0.1');
    await expect(startWeb({ NODE_ENV: 'production', HOST: '0.0.0.0' })).rejects.toThrow(
      'local posture needs a loopback HOST',
    );
    expect(mocks.createNext).not.toHaveBeenCalled();
  });

  it('rejects a local posture on a non-loopback HOST before Next is created', async () => {
    mocks.createNext.mockClear();
    await expect(
      startWeb({ NODE_ENV: 'production', AW_DEPLOYMENT_POSTURE: 'local', HOST: '0.0.0.0' }),
    ).rejects.toThrow('local posture needs a loopback HOST');
    expect(mocks.createNext).not.toHaveBeenCalled();
  });

  it('rejects an invalid posture before Next is created', async () => {
    mocks.createNext.mockClear();
    await expect(startWeb({ AW_DEPLOYMENT_POSTURE: 'prod' })).rejects.toThrow(
      /AW_DEPLOYMENT_POSTURE/u,
    );
    expect(mocks.createNext).not.toHaveBeenCalled();
  });
});

/**
 * S1-25 (#510): the local runtime stops its embedded PostgreSQL right after closing the web server.
 * The composition's pools stayed open until the process exited, so every idle pooled client was
 * terminated with `57P01` on a normal Ctrl+C. `close` now releases them after Next has closed.
 */
describe('startWeb close', () => {
  afterEach(async () => {
    await closeHeldComposition();
  });

  it('closes the held composition after Next, and only once', async () => {
    const events: string[] = [];
    mocks.createNext.mockReturnValue({
      prepare: () => Promise.resolve(),
      getRequestHandler: () => () => Promise.resolve(),
      close: () => {
        events.push('next.close');
        return Promise.resolve();
      },
    });
    holdComposition({
      close: () => {
        events.push('composition.close');
        return Promise.resolve();
      },
    });

    const web = await startWeb({ NODE_ENV: 'production', HOST: '127.0.0.1', PORT: '0' });
    await web.close();
    expect(events).toStrictEqual(['next.close', 'composition.close']);

    // Released and forgotten: nothing is closed a second time.
    await closeHeldComposition();
    expect(events).toStrictEqual(['next.close', 'composition.close']);
  });

  it('still closes the held composition when Next fails to close', async () => {
    const events: string[] = [];
    mocks.createNext.mockReturnValue({
      prepare: () => Promise.resolve(),
      getRequestHandler: () => () => Promise.resolve(),
      close: () => Promise.reject(new Error('next close failed')),
    });
    holdComposition({
      close: () => {
        events.push('composition.close');
        return Promise.resolve();
      },
    });

    const web = await startWeb({ NODE_ENV: 'production', HOST: '127.0.0.1', PORT: '0' });
    await expect(web.close()).rejects.toThrow('next close failed');
    expect(events).toStrictEqual(['composition.close']);
  });
});

describe('readNextDistDir', () => {
  it('defaults to .next when unset or blank', () => {
    expect(readNextDistDir({})).toBe('.next');
    expect(readNextDistDir({ AW_NEXT_DIST_DIR: '  ' })).toBe('.next');
  });

  it('uses a .next-prefixed directory name as given', () => {
    expect(readNextDistDir({ AW_NEXT_DIST_DIR: '.next-local' })).toBe('.next-local');
    expect(readNextDistDir({ AW_NEXT_DIST_DIR: ' .next.runtime ' })).toBe('.next.runtime');
  });

  // `next build` deletes distDir recursively first, so each of these would delete this app's own
  // sources (`.`, `app`, `server`, `public/`, ...) or escape it.
  it.each([
    '.',
    './',
    'app',
    'server',
    'public/',
    './public',
    'node_modules',
    'build/next',
    '.next/sub',
    '.next/../app',
    '/var/next',
    'C:\\next',
    '../next',
    'build/../../next',
    'build\\..\\next',
  ])('refuses %s and names the variable', (value) => {
    expect(() => readNextDistDir({ AW_NEXT_DIST_DIR: value })).toThrow(/AW_NEXT_DIST_DIR/u);
  });
});
