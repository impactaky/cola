const decoder = new TextDecoder();

Deno.test("repo list uses cola server and writes audit JSONL", async () => {
  const fixture = await makeFixture({ resnet8: { path: "/repos/resnet8", branch: "main" } });
  const server = await startServer(fixture);
  try {
    const result = await runCola(["repo", "list"], fixture);
    assertEquals(result.code, 0, result.stderr);
    assertEquals(result.stdout, "resnet8\t/repos/resnet8\tmain\n");

    const audit = await readAudit(fixture.auditLog);
    assertEquals(audit.method, "repo/list");
    assertEquals(audit.ok, true);
  } finally {
    await stopServer(server);
  }
});

Deno.test("configured unavailable cola server fails unless local fallback is explicit", async () => {
  const fixture = await makeFixture({ resnet8: { path: "/repos/resnet8", branch: "main" } });
  fixture.serverUrl = `unix://${fixture.tempDir}/missing.sock`;

  const failed = await runCola(["repo", "list"], fixture);
  assertEquals(failed.code, 1);
  assertIncludes(failed.stderr, "COLA_SERVER_URL is configured but unavailable");
  assertEquals(failed.stdout, "");

  const fallback = await runCola(["repo", "list"], fixture, {
    COLA_ALLOW_LOCAL_FALLBACK: "1",
  });
  assertEquals(fallback.code, 0, fallback.stderr);
  assertEquals(fallback.stdout, "resnet8\t/repos/resnet8\tmain\n");
});

Deno.test("repo list discovers server from XDG_RUNTIME_DIR by default", async () => {
  const fixture = await makeFixture({ resnet8: { path: "/repos/resnet8", branch: "main" } });
  const runtimeDir = `${fixture.tempDir}/runtime`;
  fixture.serverUrl = `unix://${runtimeDir}/cola/server.sock`;
  const server = await startServer(fixture);
  try {
    const result = await runCola(["repo", "list"], fixture, {
      COLA_SERVER_URL: "",
      XDG_RUNTIME_DIR: runtimeDir,
    });
    assertEquals(result.code, 0, result.stderr);
    assertEquals(result.stdout, "resnet8\t/repos/resnet8\tmain\n");

    const audit = await readAudit(fixture.auditLog);
    assertEquals(audit.method, "repo/list");
    assertEquals(audit.ok, true);
  } finally {
    await stopServer(server);
  }
});

Deno.test("unavailable default cola server socket fails instead of local fallback", async () => {
  const fixture = await makeFixture({ resnet8: { path: "/repos/resnet8", branch: "main" } });
  await Deno.mkdir(`${fixture.tempDir}/runtime/cola`, { recursive: true });
  await Deno.writeTextFile(`${fixture.tempDir}/runtime/cola/server.sock`, "stale");
  fixture.serverUrl = "";

  const failed = await runCola(["repo", "list"], fixture, {
    XDG_RUNTIME_DIR: `${fixture.tempDir}/runtime`,
  });
  assertEquals(failed.code, 1);
  assertIncludes(failed.stderr, "default cola server socket is configured but unavailable");

  const fallback = await runCola(["repo", "list"], fixture, {
    XDG_RUNTIME_DIR: `${fixture.tempDir}/runtime`,
    COLA_ALLOW_LOCAL_FALLBACK: "1",
  });
  assertEquals(fallback.code, 0, fallback.stderr);
  assertEquals(fallback.stdout, "resnet8\t/repos/resnet8\tmain\n");
});

Deno.test("server rejects worktree repo outside repo allowlist", async () => {
  const fixture = await makeFixture({ resnet8: { path: "/repos/resnet8", branch: "main" } });
  const server = await startServer(fixture);
  try {
    const result = await runCola(["worktree", "unknown", "task"], fixture);
    assertEquals(result.code, 1);
    assertIncludes(result.stderr, "Repo unknown is not allowed by the cola server repo allowlist");

    const audit = await readAudit(fixture.auditLog);
    assertEquals(audit.method, "worktree/create-session");
    assertEquals(audit.ok, false);
  } finally {
    await stopServer(server);
  }
});

type Fixture = {
  tempDir: string;
  xdgConfigHome: string;
  serverUrl: string;
  auditLog: string;
};

type CommandResult = {
  code: number;
  stdout: string;
  stderr: string;
};

async function makeFixture(
  repos: Record<string, { path: string; branch: string }>,
): Promise<Fixture> {
  const tempDir = await Deno.makeTempDir({ prefix: "cola-server-test-" });
  const xdgConfigHome = `${tempDir}/config`;
  await Deno.mkdir(`${xdgConfigHome}/cola`, { recursive: true });
  await Deno.writeTextFile(
    `${xdgConfigHome}/cola/config.json`,
    `${JSON.stringify({ repos }, null, 2)}\n`,
  );

  return {
    tempDir,
    xdgConfigHome,
    serverUrl: `unix://${tempDir}/server.sock`,
    auditLog: `${tempDir}/audit.jsonl`,
  };
}

async function startServer(fixture: Fixture): Promise<Deno.ChildProcess> {
  const command = new Deno.Command("deno", {
    args: [
      "run",
      "--allow-all",
      "src/main.ts",
      "server",
      "--listen",
      fixture.serverUrl,
      "--audit-log",
      fixture.auditLog,
    ],
    env: commandEnv(fixture),
    stdin: "null",
    stdout: "null",
    stderr: "null",
  });
  const child = command.spawn();
  await waitForSocket(fixture.serverUrl);
  return child;
}

async function stopServer(child: Deno.ChildProcess) {
  child.kill("SIGTERM");
  await child.status.catch(() => undefined);
}

async function runCola(
  args: string[],
  fixture: Fixture,
  extraEnv: Record<string, string> = {},
): Promise<CommandResult> {
  const command = new Deno.Command("deno", {
    args: ["run", "--allow-all", "src/main.ts", ...args],
    env: commandEnv(fixture, extraEnv),
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  return {
    code: output.code,
    stdout: decoder.decode(output.stdout),
    stderr: decoder.decode(output.stderr),
  };
}

function commandEnv(
  fixture: Fixture,
  extraEnv: Record<string, string> = {},
): Record<string, string> {
  return {
    ...Deno.env.toObject(),
    XDG_CONFIG_HOME: fixture.xdgConfigHome,
    HOME: fixture.tempDir,
    CODEX_HOME: `${fixture.tempDir}/codex`,
    COLA_SERVER_URL: fixture.serverUrl,
    ...extraEnv,
  };
}

async function waitForSocket(url: string) {
  const path = new URL(url).pathname;
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const conn = await Deno.connect({ transport: "unix", path }).catch(() => undefined);
    if (conn) {
      conn.close();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function readAudit(path: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const text = await Deno.readTextFile(path).catch(() => "");
    const line = text.trim().split("\n").find(Boolean);
    if (line) return JSON.parse(line);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for audit log ${path}`);
}

function assertEquals(actual: unknown, expected: unknown, message?: string) {
  if (actual !== expected) {
    throw new Error(
      message ?? `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function assertIncludes(actual: string, expected: string) {
  if (!actual.includes(expected)) {
    throw new Error(`Expected ${JSON.stringify(actual)} to include ${JSON.stringify(expected)}`);
  }
}
