// R-06 probe fixture — a stdio child that never answers, never exits on stdin EOF, and (on
// POSIX) ignores SIGTERM. It exists to force StdioClientTransport.close() all the way down its
// escalation ladder: end stdin -> wait -> SIGTERM -> wait -> SIGKILL.
try {
  process.on('SIGTERM', () => {
    process.stderr.write('server-deaf: ignoring SIGTERM\n');
  });
} catch {}
process.stdin.resume();
process.stdin.on('end', () => {
  process.stderr.write('server-deaf: stdin ended, staying alive anyway\n');
});
setInterval(() => {}, 1 << 30);
