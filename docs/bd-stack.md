# Stack bd tasks

Start one Codex session per bd task and arrange the branches as a stacked PR chain.

## Requirements

- `cola` is installed.
- `bd` is installed and can find the repository's bead database.
- The repository is registered with `cola repo register`, or the repo argument is a local git path.
- The requested base branch exists.

## Procedure

1. Preview the stack:

   ```sh
   cola bd stack cola --tasks task-1,task-2 --base main --dry-run
   ```

2. Start the stack:

   ```sh
   cola bd stack cola --tasks task-1,task-2 --base main
   ```

3. Limit a longer task list to the first task:

   ```sh
   cola bd stack cola --tasks task-1,task-2,task-3 --limit 1 --dry-run
   ```

## Expectations

- Dry-run prints `TASK`, `BRANCH`, and `BASE` columns and does not create worktrees, sessions, or bd
  updates.
- The first task branch starts from `--base`.
- Later task branches start from the previous task branch.
- Non-dry-run claims each task, creates one worktree branch per task, starts one Codex session per
  task, and stores `cola.session_id`, `cola.worktree`, `cola.branch`, `cola.base_branch`, and
  `cola.state`.
- Before starting a later task, `cola` waits until the previous task has `cola.state=pr-opened` or
  `cola.pr_url`.
- The generated prompt tells the session to push, create a PR, update bd metadata, and not merge.
