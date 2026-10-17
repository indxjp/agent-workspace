// R-06 probe — the hung-stdio-child question on Linux, which is the platform the runner image
// actually is. Windows answers this differently and its answer is not transferable.
//
// Run inside node:24-bookworm-slim with @modelcontextprotocol/sdk installed.
//
// Establishes, for an MCP stdio server that is a *launcher* (the `npx -y …` shape spec §8's
// own example uses), whether StdioClientTransport.close() reaps the process that is actually
// holding the resources, or only the process it spawned.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const alive = (pid) => {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    throw new Error(`alive(): not a pid: ${JSON.stringify(pid)}`);
  }
  // /proc is the authority inside the container; a zombie counts as gone for our purposes.
  let stat;
  try {
    stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw new Error(`alive(): undecidable for ${pid}: ${e.code}`);
  }
  const state = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0];
  if (state === 'Z') return false;
  return true;
};

const results = {};

async function run(label, args) {
  const t = new StdioClientTransport({ command: process.execPath, args, stderr: 'pipe' });
  const c = new Client({ name: 'r06-probe', version: '0.0.1' }, { capabilities: {} });
  let pid = null;
  const os = t.start.bind(t);
  t.start = async () => {
    await os();
    pid = t.pid;
  };
  let threw = null;
  const t0 = Date.now();
  try {
    await c.connect(t, { timeout: 2000 });
  } catch (e) {
    threw = `${e.constructor.name}: ${e.message}`;
  }
  const ms = Date.now() - t0;
  await sleep(5000); // past close()'s 2s+2s SIGTERM/SIGKILL escalation
  const gcFile = '/tmp/grandchild.pid';
  let gp = null;
  if (fs.existsSync(gcFile)) {
    gp = Number(fs.readFileSync(gcFile, 'utf8').trim());
    fs.unlinkSync(gcFile);
  }
  const r = {
    threw,
    ms,
    directChildPid: pid,
    directChildAlive: alive(pid),
    grandchildPid: gp,
    grandchildAlive: gp === null ? null : alive(gp),
  };
  results[label] = r;
  console.log(label, JSON.stringify(r));
  if (gp !== null && alive(gp)) {
    try {
      process.kill(gp, 'SIGKILL');
    } catch {}
  }
  if (alive(pid)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
}

await run('hung-child', ['/probe/server-stdio.mjs', '--mode', 'hang']);
await run('deaf-child-ignores-sigterm', ['/probe/server-deaf.mjs']);
await run('launcher-with-grandchild', ['/probe/server-spawner-linux.mjs']);

// The fix ADR-W1-INF-03b prescribes, applied to the launcher case: spawn the child as a
// process-group leader and signal the group rather than the pid.
console.log('\n-- process-group kill, the ADR-W1-INF-03b shape --');
{
  const child = spawn(process.execPath, ['/probe/server-spawner-linux.mjs'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  });
  await sleep(1500);
  const gp = Number(fs.readFileSync('/tmp/grandchild.pid', 'utf8').trim());
  console.log(`before: child=${child.pid} alive=${alive(child.pid)} grandchild=${gp} alive=${alive(gp)}`);
  process.kill(-child.pid, 'SIGKILL');
  await sleep(1000);
  const after = { childAlive: alive(child.pid), grandchildAlive: alive(gp) };
  console.log(`after process.kill(-${child.pid}, SIGKILL): ${JSON.stringify(after)}`);
  results['process-group-kill'] = after;
  fs.unlinkSync('/tmp/grandchild.pid');
}

fs.writeFileSync('/probe/linux-tree-results.json', JSON.stringify({ platform: process.platform, node: process.version, results }, null, 2));
