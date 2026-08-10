# Install shell completions

Generate shell completion scripts for the installed `cola` command.

## Requirements

- `cola` is installed.
- The target shell is bash, zsh, or fish.
- The shell startup file exists or can be created.

## Procedure

1. For bash, add this line to `~/.bashrc`:

   ```sh
   source <(cola completions bash)
   ```

2. For zsh, add this line to `~/.zshrc`:

   ```sh
   source <(cola completions zsh)
   ```

3. For fish, add this line to `~/.config/fish/config.fish`:

   ```fish
   cola completions fish | source
   ```

4. Restart the shell.
5. Type `cola` and press the shell completion key.

## Expectations

- The shell suggests `create`, `worktree`, `repo`, `server`, `config`, `alias`, and `completions`.
- Command options appear after the command name.
- Unknown completion targets print an error from the completions command.
