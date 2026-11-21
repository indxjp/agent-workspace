#!/usr/bin/env node
/* global console, fetch, setTimeout, Image, document */
/**
 * Regenerates the store's screenshots (use-cases plan §6.3; `shots.mjs` says which):
 *
 *   pnpm exec nx run-many -t build --projects=@indx-workspace/contracts,@indx-workspace/platforms,@indx-workspace/sdk,@indx-workspace/react,@indx-workspace/app,@indx-workspace/aw,@indx-workspace/cli,@indx-workspace/embedded,@indx-workspace/create
 *   node tests/store/shots/shoot.mjs
 *
 * It installs and builds a copy of examples/store the way the apps lane does (the packed
 * `@indx-workspace/*` packages, `npm install`, `next build`), starts it with `next start` against
 * a stand-in platform that lists every live entry as under maintenance, so each entry page's
 * Try it section replays the entry's recording, and photographs that recording
 * (`data-testid="try-recording"`, its end when it is long: the result) at
 * `/agents/<slug>?lang=<ja|en>` with Playwright's Chromium.
 * Chromium also encodes the WebP, and `examples/store/app/shots.generated.ts` records each shot's
 * size for its `<img>`. The platform is never reached and no model runs. Set
 * `SHOTS_WORK_DIR` to keep the copy (a second run then skips the install and the build).
 */
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { chromium } from '@playwright/test';

import { packPackages } from '../../app-kit/run.mjs';
import { installStep } from '../../apps/lane-commands.mjs';
import { stepOf } from '../../apps/lane-process.mjs';
import { CATALOG } from '../../../examples/store/catalog/index.ts';
import { expectedShots, renderShotSizes, SHOTS_DIR, SHOTS_GENERATED, webpSize } from './shots.mjs';

const READY_TIMEOUT_MS = 120_000;
const VIEWPORT = { width: 1280, height: 900 };
const WEBP_QUALITY = 0.85;
/** The tallest shot: a long recording keeps its end, where the result is. */
const MAX_SHOT_HEIGHT = 1200;

/**
 * The part of the recording a shot shows: all of it, or its last {@link MAX_SHOT_HEIGHT} pixels.
 *
 * @param {{ x: number; y: number; width: number; height: number } | null} box
 */
function resultClip(box) {
  if (box === null) throw new Error('the page shows no recording');
  const height = Math.min(box.height, MAX_SHOT_HEIGHT);
  return { x: box.x, y: box.y + box.height - height, width: box.width, height };
}

/** @param {{ status: string; reason: string }} outcome */
function required(outcome) {
  if (outcome.status !== 'ok') throw new Error(outcome.reason);
}

/** A stand-in platform: every live entry is under maintenance; anything else is not found. */
function standInPlatform(maintenance) {
  const server = createServer((request, response) => {
    if (request.url === '/api/store/demos') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ maintenance }));
      return;
    }
    response.writeHead(404).end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      resolve({ url: `http://127.0.0.1:${String(port)}`, close: () => server.close() });
    });
  });
}

/** A port nothing listens on now. */
function freePort() {
  return new Promise((resolve) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() =>
        resolve(typeof address === 'object' && address !== null ? address.port : 0),
      );
    });
  });
}

/** Waits until `url` answers, or throws after {@link READY_TIMEOUT_MS}. */
async function ready(url) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((wake) => setTimeout(wake, 1000));
  }
  throw new Error(`${url} did not answer within ${String(READY_TIMEOUT_MS)} ms`);
}

/** `png` re-encoded as WebP by the canvas of `page`, a blank page of the browser. */
async function toWebp(page, png) {
  const dataUrl = await page.evaluate(
    async ({ base64, quality }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${base64}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      canvas.getContext('2d')?.drawImage(image, 0, 0);
      return canvas.toDataURL('image/webp', quality);
    },
    { base64: png.toString('base64'), quality: WEBP_QUALITY },
  );
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
}

async function main() {
  const keep = process.env['SHOTS_WORK_DIR'] !== undefined;
  const work = path.resolve(
    process.env['SHOTS_WORK_DIR'] ?? mkdtempSync(path.join(tmpdir(), 'store-shots-')),
  );
  const copy = path.join(work, 'store');
  const home = path.join(work, 'home');
  mkdirSync(home, { recursive: true });
  const env = {
    PATH: process.env['PATH'],
    HOME: home,
    LANG: process.env['LANG'] ?? 'C.UTF-8',
    NEXT_TELEMETRY_DISABLED: '1',
    npm_config_cache:
      process.env['npm_config_cache'] ?? path.join(process.env['HOME'] ?? home, '.npm'),
  };
  if (!existsSync(path.join(copy, '.next', 'BUILD_ID'))) {
    console.log(`== installing and building a copy of examples/store in ${copy}`);
    required(installStep('store', copy, packPackages(path.join(work, 'packs')), env));
    required(stepOf('next build', 'npx', ['--no-install', 'next', 'build'], { cwd: copy, env }));
  }
  const shots = expectedShots(CATALOG);
  const platform = await standInPlatform([...new Set(shots.map(({ slug }) => slug))]);
  const port = await freePort();
  const app = `http://127.0.0.1:${String(port)}`;
  const server = spawn(
    'npx',
    ['--no-install', 'next', 'start', '-p', String(port), '-H', '127.0.0.1'],
    {
      cwd: copy,
      env: {
        ...env,
        NODE_ENV: 'production',
        AW_URL: platform.url,
        AW_APP_NAME: 'store',
        // The pages photographed read no data; the pool is never opened.
        DATABASE_URL: 'postgres://shots@127.0.0.1:9/shots',
        AW_WORKSPACE_ID: randomUUID(),
      },
      stdio: 'inherit',
      // Its own process group, so the server `npx` starts stops with it.
      detached: true,
    },
  );
  const browser = await chromium.launch();
  try {
    await ready(`${app}/robots.txt`);
    const page = await browser.newPage({ viewport: VIEWPORT });
    const encoder = await browser.newPage();
    mkdirSync(SHOTS_DIR, { recursive: true });
    /** @type {Record<string, { width: number; height: number }>} */
    const sizes = {};
    for (const { slug, lang, file } of shots) {
      await page.goto(`${app}/agents/${slug}?lang=${lang}`);
      const png = await page.screenshot({
        type: 'png',
        animations: 'disabled',
        fullPage: true,
        clip: resultClip(await page.getByTestId('try-recording').boundingBox()),
      });
      const webp = await toWebp(encoder, png);
      writeFileSync(path.join(SHOTS_DIR, file), webp);
      sizes[`${slug}.${lang}`] = webpSize(webp);
      console.log(`   wrote examples/store/public/shots/${file}`);
    }
    writeFileSync(SHOTS_GENERATED, renderShotSizes(sizes));
  } finally {
    await browser.close();
    if (server.pid !== undefined) process.kill(-server.pid);
    platform.close();
    if (!keep) rmSync(work, { recursive: true, force: true });
  }
}

await main();
