# Use aliases

Register reusable message prefixes for sessions and worktrees.

## Requirements

- `cola` is installed.
- The alias name contains only letters, numbers, dots, underscores, and hyphens.
- The alias prefix is not empty.

## Procedure

1. Add an alias:

   ```sh
   cola alias add fix "Fix: "
   ```

2. List aliases:

   ```sh
   cola alias list
   ```

3. Use the alias in `cola create`:

   ```sh
   cola create fix "handle empty config"
   ```

4. Use the alias in `cola worktree`:

   ```sh
   cola worktree cola fix "handle empty config"
   ```

5. Remove an alias:

   ```sh
   cola alias remove fix
   ```

## Expectations

- `cola alias add` prints `Registered alias <name>: <prefix>`.
- `cola alias list` prints each alias name and prefix separated by a tab.
- `cola create fix "handle empty config"` sends `Fix: handle empty config` as the first message.
- `cola worktree cola fix "handle empty config"` sends `Fix: handle empty config` as the first
  message in the new worktree session.
- `cola alias remove` prints `Removed alias <name>`.
