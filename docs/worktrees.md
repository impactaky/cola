# Manage repositories and worktrees

Register repositories and create Codex sessions in new git worktrees.

## Requirements

- `cola` is installed.
- Git is installed.
- The repository path is a git repository.
- The base branch exists in the repository.

## Procedure

1. Register a repository:

   ```sh
   cola repo register cola /path/to/repo --branch main
   ```

2. List registered repositories:

   ```sh
   cola repo list
   ```

3. Create a new worktree and start a Codex session in it:

   ```sh
   cola worktree cola "Implement config-backed worktrees"
   ```

4. Override the base branch for one worktree:

   ```sh
   cola worktree cola "Test migration" --branch develop
   ```

5. Create and check out a named branch in the new worktree:

   ```sh
   cola worktree cola "Implement API cleanup" --branch main --new-branch api-cleanup
   ```

6. Create a branch stacked on top of another PR branch:

   ```sh
   cola worktree cola "Add follow-up UI" --branch api-cleanup --new-branch ui-follow-up
   ```

7. Create a worktree through `cola create`:

   ```sh
   cola create --worktree cola "Handle empty config"
   ```

8. Remove a registered repository when it is no longer needed:

   ```sh
   cola repo remove cola
   ```

## Expectations

- `cola repo register` prints `Registered repo <name>: <path>`.
- `cola repo list` prints each repository name, path, and branch separated by tabs.
- Without `--new-branch`, worktree commands keep the existing detached worktree behavior.
- With `--new-branch`, worktree commands run `git worktree add -b <newBranch> <path> <baseBranch>`,
  so the new branch starts at the requested base branch.
- Worktree commands print `Created worktree: <path>`, `Worktree id: <id>`, `Branch: <branch>`, and
  `Base branch: <branch>`.
- `--json` includes `worktree.path`, `worktree.branch`, and `worktree.baseBranch`. Detached
  worktrees report `worktree.branch` as `null`.
- Worktrees are created under `$CODEX_HOME/worktrees/<id>/<repo-name>`, or
  `~/.codex/worktrees/<id>/<repo-name>` when `CODEX_HOME` is unset.
- The Codex session working directory is the new worktree path.
