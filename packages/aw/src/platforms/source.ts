import { readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import type { PortableProjectSource } from '@indx-workspace/sdk/portable';

import { CommandRefusedError } from '../io.js';
import { errorCode } from '../local-runtime/project.js';
import { escapes } from '../project/load.js';

function byCodeUnit(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * The project's files for `loadPortableProject` (ADR-0133 D3): project-relative POSIX paths in, the
 * bytes of regular files out. A path that leaves the project, by name or through a link, is
 * refused; a link met while listing is skipped, because its target was never shown to the author.
 */
export function nodePortableProjectSource(root: string): PortableProjectSource {
  const base = path.resolve(root);

  function inside(posixPath: string): string {
    const absolute = path.resolve(base, ...posixPath.split('/'));
    if (escapes(path.relative(base, absolute))) {
      throw new CommandRefusedError(`${posixPath} is outside the project`);
    }
    return absolute;
  }

  return {
    async readFile(posixPath) {
      const absolute = inside(posixPath);
      let real: string;
      try {
        real = await realpath(absolute);
      } catch (error) {
        const code = errorCode(error);
        if (code === 'ENOENT' || code === 'ENOTDIR') return null;
        throw error;
      }
      if (escapes(path.relative(await realpath(base), real))) {
        throw new CommandRefusedError(`${posixPath} is outside the project`);
      }
      try {
        return new Uint8Array(await readFile(real));
      } catch (error) {
        if (errorCode(error) === 'EISDIR') return null;
        throw error;
      }
    },

    async listFiles(directory) {
      const found: string[] = [];
      const walk = async (relative: string): Promise<void> => {
        let entries;
        try {
          entries = await readdir(inside(relative), { withFileTypes: true });
        } catch (error) {
          const code = errorCode(error);
          if (code === 'ENOENT' || code === 'ENOTDIR') return;
          throw error;
        }
        for (const entry of entries) {
          const child = `${relative}/${entry.name}`;
          if (entry.isDirectory()) await walk(child);
          else if (entry.isFile()) found.push(child);
        }
      };
      await walk(directory);
      return found.sort(byCodeUnit);
    },
  };
}
