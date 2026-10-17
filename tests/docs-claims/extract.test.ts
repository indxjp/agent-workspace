import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  ClaimError,
  claimPages,
  extractClaims,
  extractRepositoryClaims,
  parseFenceInfo,
  shellCommands,
} from './extract.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function failureOf(action: () => unknown): ClaimError {
  try {
    action();
  } catch (error) {
    if (error instanceof ClaimError) return error;
    throw error;
  }
  throw new Error('expected a ClaimError');
}

describe('the fence meta', () => {
  it('reads the claim next to Mintlify’s title, quoted or bare', () => {
    expect(parseFenceInfo('sh title="aw" claim=run')).toEqual({
      lang: 'sh',
      title: 'aw',
      claim: 'run',
      file: undefined,
    });
    expect(parseFenceInfo('yaml title="agent-workspace.yaml (excerpt)" file=tests/a.yaml')).toEqual(
      {
        lang: 'yaml',
        title: 'agent-workspace.yaml (excerpt)',
        claim: undefined,
        file: 'tests/a.yaml',
      },
    );
    expect(parseFenceInfo('sh aw claim=illustrative').title).toBe('aw');
  });
});

describe('regression: an unmarked code block fails the extractor (issue #880)', () => {
  it('names the page and line of an unmarked fence', () => {
    const error = failureOf(() =>
      extractClaims('docs/sdk/site/x.mdx', 'intro\n\n```ts\nlet a = 1;\n```\n'),
    );
    expect(error.message).toMatch(/^docs\/sdk\/site\/x\.mdx:3: unmarked code block/u);
  });

  it('names the page and line of an unmarked <pre> on the landing page', () => {
    const html = '<p>x</p>\n<div>\n<pre>$ npm run dev</pre>\n';
    expect(failureOf(() => extractClaims('sites/lp/x.html', html)).message).toMatch(
      /^sites\/lp\/x\.html:3: unmarked code block/u,
    );
  });

  it('names an unmarked one-line command element', () => {
    const html = '<div class="cmd">docker compose up -d</div>';
    expect(failureOf(() => extractClaims('sites/lp/x.html', html)).message).toMatch(
      /^sites\/lp\/x\.html:1: unmarked/u,
    );
    expect(
      extractClaims('sites/lp/x.html', '<div class="cmd"><a href="/x">Guide</a></div>'),
    ).toEqual([]);
  });

  it('exempts diagrams and plain text, and every block of a generated reference page', () => {
    expect(
      extractClaims('a.mdx', '```mermaid\ngraph TD\n```\n\n```text\nok\n  aw chat · /help\n```\n'),
    ).toEqual([]);
    const [generated] = extractClaims(
      'docs/sdk/site/reference/x.mdx',
      '```ts\nexport type A = 1;\n```\n',
    );
    expect(generated?.state).toBe('generated');
  });

  it('fails a fence with no language like any unmarked block', () => {
    expect(failureOf(() => extractClaims('a.mdx', 'x\n\n```\nbare\n```\n')).message).toMatch(
      /^a\.mdx:3: unmarked code block/u,
    );
  });

  it('fails a text fence holding a shell prompt or a known command, and accepts it marked', () => {
    for (const line of [
      '$ aw eval',
      '% ls',
      'npm run dev',
      'npx aw chat',
      'pnpm i',
      'aw check',
      'docker compose up',
      'helm install x',
      'curl -s x',
      'git clone x',
    ]) {
      expect(
        failureOf(() => extractClaims('a.mdx', `\`\`\`text\nout\n${line}\n\`\`\`\n`)).message,
      ).toMatch(/^a\.mdx:1: unmarked code block/u);
    }
    const [claim] = extractClaims(
      'a.mdx',
      '```text title="Example output (illustrative)" claim="illustrative"\n$ aw eval\n```\n',
    );
    expect(claim?.state).toBe('illustrative');
  });

  it('fails an unquoted marker, which Mintlify would show as the title of a block without one', () => {
    for (const meta of [
      'sh claim=run',
      'ts title="x" file=tests/x.ts',
      'tsx React claim=compile',
    ]) {
      expect(failureOf(() => extractClaims('a.mdx', `\`\`\`${meta}\nx\n\`\`\`\n`)).message).toMatch(
        /^a\.mdx:1: Mintlify shows an unquoted claim= or file=/u,
      );
    }
    expect(extractClaims('a.mdx', '```tsx React claim="compile"\nx\n```\n')[0]?.title).toBe(
      'React',
    );
  });

  it('rejects an unknown claim and a block that claims both', () => {
    expect(
      failureOf(() => extractClaims('a.mdx', '```ts claim="maybe"\nx\n```\n')).message,
    ).toMatch(/a\.mdx:1: unknown claim "maybe"/u);
    expect(
      failureOf(() => extractClaims('a.mdx', '```ts claim="run" file="x.ts"\nx\n```\n')).message,
    ).toMatch(/not both/u);
  });
});

describe('the illustrative label', () => {
  it('is required in the block’s title, so the reader sees it', () => {
    expect(
      failureOf(() => extractClaims('a.mdx', '```sh claim="illustrative"\nx\n```\n')).message,
    ).toMatch(/a\.mdx:1: an illustrative block must say so/u);
    const [claim] = extractClaims(
      'a.mdx',
      '```sh title="aw (illustrative)" claim="illustrative"\naw x\n```\n',
    );
    expect(claim).toMatchObject({ state: 'illustrative', lang: 'sh', title: 'aw (illustrative)' });
  });

  it('is shown on the landing page by the stylesheet, so data-claim alone is enough there', () => {
    const [claim] = extractClaims('sites/lp/x.html', '<pre data-claim="illustrative">aw x</pre>');
    expect(claim?.state).toBe('illustrative');
  });
});

describe('the claims of a page', () => {
  it('reads indented fences inside JSX, dedented, with the line of the opening fence', () => {
    const mdx =
      '<Steps>\n  <Step title="a">\n    ```sh claim="run"\n    npm install x\n      indented\n    ```\n  </Step>\n</Steps>\n';
    expect(extractClaims('a.mdx', mdx)).toEqual([
      {
        page: 'a.mdx',
        line: 3,
        state: 'run',
        lang: 'sh',
        body: 'npm install x\n  indented',
        title: '',
      },
    ]);
  });

  it('keeps a longer fence’s inner fences as body', () => {
    const [claim] = extractClaims('a.md', '````md claim="compile"\n```ts\nx\n```\n````\n');
    expect(claim?.body).toBe('```ts\nx\n```');
  });

  it('reads a file= claim and the landing page’s data-file', () => {
    const [fence] = extractClaims(
      'a.mdx',
      '```ts title="x.ts" file="tests/gallery/x.ts"\nlet a;\n```\n',
    );
    expect(fence).toMatchObject({ state: 'file', file: 'tests/gallery/x.ts' });
    const [pre] = extractClaims(
      'sites/lp/x.html',
      '<pre data-file="tests/gallery/x/agents/a.ts"><span class="kw">const</span> a = 1 &lt; 2;</pre>',
    );
    expect(pre).toMatchObject({ state: 'file', lang: 'ts', body: 'const a = 1 < 2;' });
  });

  it('decodes landing-page markup and keeps the $ prompt', () => {
    const html =
      '<pre data-claim="run"><span class="p">$ </span>npm create x -- --yes &amp;&amp; echo &quot;ok&quot;\n<span class="cm"># note</span></pre>';
    const [claim] = extractClaims('sites/lp/x.html', html);
    expect(claim?.body).toBe('$ npm create x -- --yes && echo "ok"\n# note');
    expect(claim?.lang).toBe('sh');
  });

  it('skips an empty <pre> a script fills in', () => {
    expect(extractClaims('sites/lp/x.html', '<pre id="stack-yaml" hidden></pre>')).toEqual([]);
  });
});

describe('the shell a block is written for', () => {
  it('is any shell unless the fence meta, a PowerShell fence or data-shell says otherwise', () => {
    const shellOfFence = (info: string) =>
      extractClaims('a.mdx', `\`\`\`${info}\nx\n\`\`\`\n`)[0]?.shell;
    expect(shellOfFence('sh claim="run"')).toBeUndefined();
    expect(shellOfFence('sh claim="run" shell="posix"')).toBe('posix');
    expect(shellOfFence('sh claim="run" shell="powershell"')).toBe('powershell');
    for (const lang of ['powershell', 'pwsh', 'ps1']) {
      expect(shellOfFence(`${lang} claim="run"`)).toBe('powershell');
    }
    expect(
      extractClaims('sites/lp/x.html', '<pre data-claim="run" data-shell="powershell">x</pre>')[0]
        ?.shell,
    ).toBe('powershell');
    expect(parseFenceInfo('sh claim="run" shell="posix"').shell).toBe('posix');
  });

  it('names the page and line of an unknown shell', () => {
    expect(
      failureOf(() => extractClaims('a.mdx', '\n```sh claim="run" shell="fish"\nx\n```\n')).message,
    ).toMatch(/^a\.mdx:2: unknown shell "fish"/u);
  });
});

describe('the commands of a shell block', () => {
  it('drops comments and placeholder exports, joins continuations, splits &&', () => {
    expect(
      shellCommands(
        'export ANTHROPIC_API_KEY=sk-ant-...\n# c\nnpm create x my-agent -- --yes \\\n  --engine pi   # d\ncd my-agent && npm install && npm run dev\nexport A=1',
      ),
    ).toEqual([
      'npm create x my-agent -- --yes --engine pi',
      'cd my-agent',
      'npm install',
      'npm run dev',
      'export A=1',
    ]);
  });

  it('takes only the $ lines of a transcript, and keeps && inside quotes', () => {
    expect(shellCommands('$ echo "a && b"\noutput\n$ ls && pwd')).toEqual([
      'echo "a && b"',
      'ls',
      'pwd',
    ]);
  });
});

describe('the repository', () => {
  it('has a marker on every block of the docs, the landing page and the READMEs', () => {
    const claims = extractRepositoryClaims(ROOT);
    expect(claims.length).toBeGreaterThan(0);
    expect(claimPages(ROOT)).toContain('README.md');
    expect(claimPages(ROOT)).toContain('sites/lp/index.html');
    expect(claimPages(ROOT)).toContain('docs/sdk/site/getting-started/quickstart.mdx');
  });
});
