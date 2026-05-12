# Plan bd runs

Create and inspect ordered bd task-list runs without starting Codex sessions or creating worktrees.

## Requirements

- `cola` is installed.
- `bd` is installed and can find the repository's bead database.
- The repository is registered with `cola repo register`, or the repo argument is a local git path.
- The task list is explicit.

## Procedure

1. Create a run:

   ```sh
   cola bd run create cola --tasks task-1,task-2 --base main
   ```

2. Inspect the plan:

   ```sh
   cola bd run plan <run-id>
   ```

3. Inspect task status:

   ```sh
   cola bd run status <run-id>
   ```

## Expectations

- `create` stores one stable `cola.run_id` across every task in the run.
- The initial strategy is `stacked`.
- The first task branch starts from `--base`.
- Later task branches start from the previous task branch.
- `create` records `cola.run_id`, `cola.run_order`, `cola.strategy`, `cola.branch`,
  `cola.base_branch`, `cola.previous_task`, `cola.next_task`, and `cola.state`.
- `plan` prints task order, strategy, branch names, base branches, and previous/next links.
- `status` prints each task state plus known `cola.session_id`, `cola.pr_url`, and `cola.worktree`
  metadata when present.
- `create`, `plan`, and `status` do not start Codex sessions or create worktrees.
