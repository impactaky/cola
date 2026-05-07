# Run the Docker command test

Run the containerized `cola` command test from the repository Dockerfile.

## Requirements

- Docker is installed.
- The Docker daemon is running.
- You are in the `cola` repository.
- The repository contains `Dockerfile` and `scripts/test-cola-command.sh`.

## Procedure

1. Build the test image:

   ```sh
   docker build -t cola-command-test .
   ```

2. Run the test container:

   ```sh
   docker run --rm cola-command-test
   ```

3. Run a single command inside the image when you need to inspect the installed CLI:

   ```sh
   docker run --rm --entrypoint cola cola-command-test --help
   ```

## Expectations

- `docker build` creates an image named `cola-command-test`.
- `docker run --rm cola-command-test` prints `cola command tests passed`.
- The test container exits with status `0`.
- The single-command form prints the installed `cola` help text.
