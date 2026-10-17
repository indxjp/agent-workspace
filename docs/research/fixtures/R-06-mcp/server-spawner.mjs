// R-06 probe fixture — a stdio "MCP server" that is really a launcher: it spawns a detached
// grandchild and then hangs. This is the `npx -y @modelcontextprotocol/server-filesystem`
// shape, where the command the platform runs is not the process that ends up holding the
// resources. It exists to establish whether killing the direct child reaps the grandchild.
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], {
  detached: false,
  stdio: 'ignore',
});
fs.writeFileSync('grandchild.pid', String(g.pid));
process.stderr.write(`spawner: grandchild ${g.pid}\n`);

// Read stdin and answer nothing: the hung case.
process.stdin.resume();
setInterval(() => {}, 1 << 30);
