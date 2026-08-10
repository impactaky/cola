# Install cola

Install the `cola` command with Deno.

## Requirements

- Deno is installed.
- Codex CLI is installed as `codex`.
- You are in the `cola` repository.
- `$VISUAL` or `$EDITOR` is set if you want `cola create` to open a specific editor.

## Procedure

1. Run:

   ```sh
   deno install --global --config deno.json --allow-run=codex,ps,git,"$EDITOR" --allow-read --allow-write --allow-env --allow-net=127.0.0.1,localhost --name cola ./src/main.ts
   ```

2. If Codex is not named `codex`, install with the executable name allowed by Deno and pass
   `--codex-command` when you create sessions.
3. Run:

   ```sh
   cola --version
   ```

4. Run:

   ```sh
   cola --help
   ```

## Expectations

- `cola --version` prints `0.1.0`.
- `cola --help` lists `create`, `worktree`, `repo`, `server`, `config`, `alias`, and `completions`.
- The installed command can read and write cola config under `$XDG_CONFIG_HOME/cola` or
  `~/.config/cola`.
