// R-06 probe fixture — not an MCP server at all. It reports, on stderr, what environment it was
// actually given, then exits. Used to establish whether StdioServerParameters.env REPLACES the
// child's environment or overlays it, which decides whether a connector that sets one credential
// silently loses PATH.
const line = [
  'PATH=' + (process.env.PATH === undefined ? '(absent)' : 'present'),
  'API_KEY=' + (process.env.API_KEY ?? '(absent)'),
  'keys=' + Object.keys(process.env).length,
].join(' ');
process.stderr.write(line + '\n');
process.exit(3);
