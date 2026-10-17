// R-06 probe (Linux) — the reference testConnection() against a *launcher*-shaped stdio
// server, and the wrapper that fixes it.
//
// StdioServerParameters (the MCP SDK's stdio config) has no `detached` option — command,
// args, env, stderr, cwd, maxBufferSize and nothing else — so StdioClientTransport cannot make
// the child a process-group leader and its close() can only ever signal the one pid. Against
// `npx -y <server>`, which is the shape spec §8's own example uses, that leaves the real server
// running after Test Connection has returned.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { testConnection } from './test-connection.mjs';

const alive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`alive(): not a pid: ${pid}`);
  let stat;
  try {
    stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw new Error(`alive(): undecidable for ${pid}: ${e.code}`);
  }
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] !== 'Z';
};

console.log('--- A. testConnection() straight at a launcher-shaped stdio server ---');
{
  const r = await testConnection(
    { command: process.execPath, args: ['/probe/server-spawner-linux.mjs'] },
    { timeoutMs: 2000 },
  );
  console.log(`result: ${r.kind} — ${r.message}`);
  await sleep(5000); // past close()'s stdin-end + 2s SIGTERM + 2s SIGKILL ladder
  const gp = Number(fs.readFileSync('/tmp/grandchild.pid', 'utf8').trim());
  console.log(`grandchild ${gp} still alive after testConnection returned: ${alive(gp)}`);
  if (alive(gp)) process.kill(gp, 'SIGKILL');
  fs.unlinkSync('/tmp/grandchild.pid');
}

console.log('\n--- B. the same probe run inside a process-group leader, group-killed after ---');
{
  // The whole probe runs in a short-lived child that is its own process-group leader; whatever
  // tree the MCP server builds inherits that group, and one kill(-pgid) reaps all of it. This
  // is ADR-W1-INF-03b's shape applied to the connector probe.
  const runner = `
    import { testConnection } from '/probe/test-connection.mjs';
    const r = await testConnection({ command: process.execPath, args: ['/probe/server-spawner-linux.mjs'] }, { timeoutMs: 2000 });
    process.stdout.write(JSON.stringify({ kind: r.kind, message: r.message }));
  `;
  fs.writeFileSync('/tmp/runner.mjs', runner);
  const child = spawn(process.execPath, ['/tmp/runner.mjs'], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_PATH: process.env.NODE_PATH },
  });
  let out = '';
  child.stdout.on('data', (c) => (out += c));
  const finished = new Promise((res) => child.on('exit', res));
  const deadline = sleep(15000).then(() => 'deadline');
  const who = await Promise.race([finished.then(() => 'exited'), deadline]);
  console.log(`probe child ${who}; it reported: ${out || '(nothing)'}`);
  const gp = Number(fs.readFileSync('/tmp/grandchild.pid', 'utf8').trim());
  console.log(`grandchild ${gp} alive before the group kill: ${alive(gp)}`);
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch (e) {
    console.log(`group kill failed: ${e.code}`);
  }
  await sleep(1000);
  console.log(`grandchild ${gp} alive after process.kill(-${child.pid}, SIGKILL): ${alive(gp)}`);
  if (alive(gp)) process.kill(gp, 'SIGKILL');
  fs.unlinkSync('/tmp/grandchild.pid');
}
process.exit(0);
