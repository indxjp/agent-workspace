/* global process */ // The root ESLint config declares no environment globals.
// file-finder: the file search behind the excel-consolidation agent, as an MCP server.
//
// It stands in for the search your company already has (SharePoint, Box, a file server's index):
// one tool that finds files by name under one root and returns their paths and modified dates.
//
//   find_files { query, extension?, folder? } → [{ path, localPath, size, modified }]
//
// `path` is relative to FILE_ROOT (a plan names files by it); `localPath` is the same file's absolute
// path on this host, for a run that reads it from the same filesystem. Neither leaves the root: a
// `folder` that resolves outside the root,
// through `..` or a symbolic link, is refused rather than searched.
import { readdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

import { refuse, serveTools, text } from '../../shared/mcp-server.mjs';

if (process.env.FILE_ROOT === undefined) {
  process.stderr.write('file-finder: set FILE_ROOT to the folder to search\n');
  process.exit(2);
}
const ROOT = realpathSync(process.env.FILE_ROOT);
const MAX_RESULTS = 50;

const normalize = (value) => value.normalize('NFKC').toLowerCase();

/** `folder` resolved inside the root, or a refusal. Symbolic links are resolved before the check. */
function insideRoot(folder) {
  const candidate = path.resolve(ROOT, folder);
  let real;
  try {
    real = realpathSync(candidate);
  } catch {
    refuse(`no folder named ${folder}`);
  }
  const relative = path.relative(ROOT, real);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    refuse('folder must be inside the file root');
  return real;
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.isFile() ? [full] : [];
  });
}

serveTools({
  name: 'file-finder',
  tools: [
    {
      name: 'find_files',
      description:
        'ファイルサーバーをファイル名で検索する。query の語（空白区切り）をすべて含むパスを返す。' +
        'extension（例: xlsx）で絞り込める。結果は path, localPath, size, modified（ISO 8601）。' +
        'ファイルを開くときは localPath を使う。マッピング計画には path をそのまま書く。',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          extension: { type: 'string' },
          folder: { type: 'string', description: 'ルートからの相対フォルダ。省略時はルート全体。' },
        },
        required: ['query'],
      },
      handler: (args) => {
        const terms = normalize(text(args, 'query')).split(/\s+/u);
        const extension =
          args.extension === undefined
            ? null
            : `.${normalize(text(args, 'extension')).replace(/^\./u, '')}`;
        const base = args.folder === undefined ? ROOT : insideRoot(text(args, 'folder'));
        return walk(base)
          .map((file) => path.relative(ROOT, file).split(path.sep).join('/'))
          .filter((relative) => {
            const name = normalize(relative);
            return (
              terms.every((term) => name.includes(term)) &&
              (extension === null || name.endsWith(extension))
            );
          })
          .sort()
          .slice(0, MAX_RESULTS)
          .map((relative) => {
            const stats = statSync(path.join(ROOT, relative));
            return {
              path: relative,
              localPath: path.join(ROOT, relative),
              size: stats.size,
              modified: stats.mtime.toISOString(),
            };
          });
      },
    },
  ],
});
