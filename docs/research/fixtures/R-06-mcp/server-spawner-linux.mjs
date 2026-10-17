// R-06 probe fixture (Linux) — a stdio "MCP server" that is really a launcher: it forks a
// grandchild that holds the real resources, then hangs. This is the shape of spec §8's own
// example, `npx -y @modelcontextprotocol/server-filesystem /workspace`, where the process the
// platform spawns is the package runner and the MCP server proper is its child.
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const g = spawn(process.execPath, ['-e', 'process.stdin.resume(); setInterval(() => {}, 1 << 30)'], {
  stdio: 'ignore',
});
fs.writeFileSync('/tmp/grandchild.pid', String(g.pid));
process.stderr.write(`spawner: grandchild ${g.pid}\n`);

process.stdin.resume();
setInterval(() => {}, 1 << 30);
