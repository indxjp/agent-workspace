# Running this project (for coding agents)

Run these in the project directory. Nothing here asks a question.

1. `npm install`
2. Start the runtime in the background, its screen going to `.aw/dev.out`; `npm run dev` does not
   exit, so never run it in the foreground. Set the variables from "Keys" in the same command
   (a tool call may start a fresh shell), before the start. Append to the log (`>>`): truncating it blanks a running start's screen.
   - Linux and WSL: `mkdir -p .aw && setsid npm run dev >> .aw/dev.out 2>&1 < /dev/null &`
     (`setsid` keeps it running when the shell or session ends)
   - macOS: `mkdir -p .aw && nohup npm run dev >> .aw/dev.out 2>&1 < /dev/null &`
   - PowerShell: `New-Item -ItemType Directory -Force .aw | Out-Null; Start-Process npm.cmd -ArgumentList 'run','dev' -WindowStyle Hidden -RedirectStandardOutput .aw/dev.out -RedirectStandardError .aw/dev.err`
3. Wait until `npx aw dev status` exits 0: it prints the URL once the runtime is ready (add
   `--json` for `{"running":true,"url":…}`). The ready screen is in `.aw/dev.out` (its `try`
   row is the URL, normally `http://127.0.0.1:3000/p/s/main/try`); the runtime's own log is
   `.aw/logs/runtime.log`. Stop it with `npx aw dev stop`, never by killing `npm`.
4. Check it works: `npx aw chat -p "hi"` answers, or open the try URL. Report the try URL.

## Keys

`aw dev` reads `ANTHROPIC_API_KEY` from its environment: `ANTHROPIC_API_KEY` is the model key. Ask the user for any value you do not have, or ask them to set it in the shell that launches
you.

- bash/zsh (the user types it, not echoed): `read -rs ANTHROPIC_API_KEY && export ANTHROPIC_API_KEY`
- PowerShell: `$env:ANTHROPIC_API_KEY = '<your key>'`

Never write a key into a file, and never commit one. Before committing, make sure `.gitignore`
lists `.env` and `.aw/`, and add them if it does not.

Edit `agents/` and `surfaces/`; each save syncs by itself while `npm run dev` runs.
