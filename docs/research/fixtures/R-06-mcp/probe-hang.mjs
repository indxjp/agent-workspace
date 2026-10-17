// R-06 probe — what a hung stdio child actually does, and whether the timeout that ends the
// Test Connection also ends the process. "A Test Connection that can hang forever is a Test
// Connection that will hang forever" — this probe establishes whether the client-side timeout
// is sufficient on its own, or whether the caller must reap the child itself.
//
// The transport is started by hand before connect() so that the pid is captured while the
// process definitely exists: StdioClientTransport.pid returns null once the child has closed,
// and a probe that read it afterwards would be deciding on the absence of a negative.
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Positive assertion in both directions; anything else is an error, never a silent "not alive".
const alive = (pid) => {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    throw new Error(`alive(): not a pid: ${JSON.stringify(pid)}`);
  }
  try {
    process.kill(pid, 0);
    return true; // signalled successfully -> exists
  } catch (e) {
    if (e.code === 'ESRCH') return false; // definitively gone
    if (e.code === 'EPERM') return true; // exists, not ours
    throw new Error(`alive(): undecidable for pid ${pid}: ${e.code} ${e.message}`);
  }
};

const mk = (args) =>
  new StdioClientTransport({ command: process.execPath, args, stderr: 'pipe' });

async function scenario(label, args, { closeAfter }) {
  console.log(`\n--- ${label} ---`);
  const t = mk(args);
  await t.start();
  const pid = t.pid;
  console.log(`spawned pid=${pid}, alive right after start: ${alive(pid)}`);
  // connect() on an already-started transport: Protocol.connect calls start() again, which
  // the transport refuses, so drive the initialize by hand through a second transport instead.
  await t.close();
  await sleep(300);
  console.log(`after a bare transport.close(): alive=${alive(pid)}`);

  const t2 = mk(args);
  const c = new Client({ name: 'r06-probe', version: '0.0.1' }, { capabilities: {} });
  let pid2 = null;
  // capture the pid the moment the process is spawned, from inside connect()
  const origStart = t2.start.bind(t2);
  t2.start = async () => {
    await origStart();
    pid2 = t2.pid;
  };
  const started = Date.now();
  try {
    await c.connect(t2, { timeout: 2000 });
    console.log('unexpectedly connected');
  } catch (e) {
    console.log(`connect threw after ${Date.now() - started}ms: ${e.constructor.name}: ${e.message}`);
  }
  console.log(`pid spawned by connect = ${pid2}`);
  for (const wait of [0, 500, 2500, 5000]) {
    if (wait) await sleep(wait === 500 ? 500 : wait - 500);
    console.log(`  t+${wait}ms after the timeout returned: alive=${alive(pid2)}`);
  }
  if (closeAfter) {
    await c.close();
    await sleep(500);
    console.log(`after an explicit client.close(): alive=${alive(pid2)}`);
  }
  if (alive(pid2)) {
    console.log('  LEAKED — killing by hand');
    process.kill(pid2, 'SIGKILL');
  }
}

await scenario('hung child (reads stdin, never answers)', ['server-stdio.mjs', '--mode', 'hang'], {
  closeAfter: true,
});

// A child that ignores stdin closing AND ignores SIGTERM is the worst case on POSIX.
await scenario('child that ignores stdin EOF', ['server-deaf.mjs'], { closeAfter: true });

console.log('\n--- grandchild reaping ---');
{
  const t = mk(['server-spawner.mjs']);
  const c = new Client({ name: 'r06-probe', version: '0.0.1' }, { capabilities: {} });
  let pid = null;
  const os = t.start.bind(t);
  t.start = async () => {
    await os();
    pid = t.pid;
  };
  try {
    await c.connect(t, { timeout: 2000 });
  } catch (e) {
    console.log(`connect threw: ${e.message}`);
  }
  await sleep(3000);
  console.log(`direct child ${pid} alive: ${alive(pid)}`);
  const gp = Number(fs.readFileSync('grandchild.pid', 'utf8').trim());
  console.log(`grandchild  ${gp} alive: ${alive(gp)}`);
  if (alive(gp)) {
    console.log('  GRANDCHILD LEAKED — killing by hand');
    process.kill(gp, 'SIGKILL');
  }
  if (alive(pid)) process.kill(pid, 'SIGKILL');
  fs.unlinkSync('grandchild.pid');
}

console.log('\ndone');
