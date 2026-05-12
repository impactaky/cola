# Create a Codex session

Create a Codex app-server thread and optionally start its first turn.

## Requirements

- `cola` is installed, or you can run `deno task cola`.
- Codex CLI is installed as `codex`, or you know its executable path.
- The target working directory exists.
- `$VISUAL` or `$EDITOR` is set if you omit the message.

## Procedure

1. Create a session with an inline message:

   ```sh
   cola create "Run the tests and report failures"
   ```

2. Create a session in a specific directory:

   ```sh
   cola create --cwd /path/to/repo "Inspect the failing test"
   ```

3. Create a session and choose session options:

   ```sh
   cola create --model gpt-5.4 --approval-policy on-request --sandbox workspaceWrite "Fix the lint failure"
   ```

4. Create a session with a different Codex executable:

   ```sh
   cola create --codex-command /path/to/codex "Summarize this repo"
   ```

5. Print machine-readable output:

   ```sh
   cola create --json "Start a short investigation"
   ```

## Expectations

- A successful command prints `Created Codex session: <id>`.
- If the first message is provided, output also includes `Started turn: <id>`.
- `--json` prints an object with `thread`, `turn`, and `worktree` fields. When a worktree is
  created, `worktree` includes `path`, `branch`, and `baseBranch`.
- If no message is provided, the editor opens and the saved text becomes the first message.
- An empty editor buffer prints `Aborted: message is empty.`
