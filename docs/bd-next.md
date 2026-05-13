# Start the next ready bd task

Use `cola bd next` to turn the next ready bd task into one Codex session, one worktree branch, and
one PR.

## Requirements

- `cola` is installed.
- `bd` is installed and can find the repository's bead database.
- The repository is registered with `cola repo register`, or the repo argument is a local git path.
- The selected task is ready according to `bd ready`.
- The base branch exists.

## Procedure

1. Check which task bd considers ready:

   ```sh
   bd ready
   ```

2. Start the next ready task:

   ```sh
   cola bd next cola
   ```

3. Override the base branch for one task when needed:

   ```sh
   cola bd next cola --base develop
   ```

## Expectations

- `cola bd next` selects work with `bd ready --json --limit 1`.
- If no ready work exists, the command prints `No ready bd tasks found.` and exits without creating
  a worktree or Codex session.
- When ready work exists, the command claims the task, creates one worktree branch, starts one Codex
  session, and stores `cola.session_id`, `cola.turn_id`, `cola.worktree`, `cola.branch`,
  `cola.base_branch`, and `cola.state=session-started`.
- The generated prompt tells the Codex session to implement the task, run checks, commit, push, open
  a PR, set `cola.state=pr-opened` and `cola.pr_url`, and not merge.
