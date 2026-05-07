# Manage config values

Read and write `cola` configuration values.

## Requirements

- `cola` is installed.
- The config key name is known.
- The value can be represented as a string.

## Procedure

1. Print the config file path:

   ```sh
   cola config path
   ```

2. List all config values:

   ```sh
   cola config list
   ```

3. Read a value:

   ```sh
   cola config get repos.cola.path
   ```

4. Set a value:

   ```sh
   cola config set repos.cola.branch trunk
   ```

## Expectations

- `cola config path` prints `$XDG_CONFIG_HOME/cola/config.json`, or `~/.config/cola/config.json`
  when `XDG_CONFIG_HOME` is unset.
- `cola config list` prints values as `key=value`.
- `cola config get <key>` prints the value and exits with status `0` when the key exists.
- `cola config get <key>` exits with status `1` when the key does not exist.
- `cola config set <key> <value>` creates nested objects for dotted keys.
