import { describe, expect, it, vi } from "vitest";
import { createProject, CreationError } from "../dist/project.js";
import { starterFiles } from "../dist/scaffold.js";
import type { Compatibility, CreatorDependencies } from "../src/contracts.js";

const compatibility: Compatibility = {
  core: "0.1.0-beta.1",
  harness: "1.2.3",
  agents: "2.3.4",
  admin: "0.1.0-beta",
  runtime: "7.8.9",
};

describe("starter template", () => {
  it("installs the known-good stack and contains no hosting implementation", async () => {
    const files = await starterFiles(compatibility);
    const manifest = JSON.parse(files["package.json"]!);
    expect(manifest.dependencies["@nylorun/agents"]).toBe("2.3.4");
    expect(manifest.dependencies["@nylorun/runtime"]).toBeUndefined();
    // The project depends only on the SDK: nylorun and the Runtime client run with npx.
    expect(Object.keys(manifest.dependencies).filter((name) => name.includes("nylorun"))).toEqual([
      "@nylorun/agents",
    ]);
    expect(
      Object.keys(manifest.devDependencies).filter((name) => name.includes("nylorun")),
    ).toEqual([]);
    expect(manifest.scripts.dev).toBe("tsx watch --env-file-if-exists=.env src/main.ts");
    expect(manifest.scripts.studio).toBeUndefined();
    expect(manifest.scripts.start).toBe("node dist/src/main.js");
    expect(manifest.scripts["dev:app"]).toBeUndefined();
    expect(files["scripts/dev.mjs"]).toBeUndefined();
    expect(files["tsconfig.build.json"]).toBeUndefined();
    expect(JSON.parse(files["tsconfig.json"]!).compilerOptions.outDir).toBe(
      "dist"
    );
    expect(
      Object.keys(files).some(
        (path) => path.startsWith("config/") || path.startsWith("scripts/")
      )
    ).toBe(false);
    expect(
      Object.keys(files)
        .filter((path) => path.endsWith(".ts"))
        .sort()
    ).toEqual([
      "agents/assistant/agent.ts",
      "agents/index.ts",
      "src/main.ts",
    ]);
    expect(files[".env/auth.json"]).toBeUndefined();
    expect(files["src/index.ts"]).toBeUndefined();
    expect(files["src/main.ts"]).toContain("client.saveAgent(agent)");
    expect(files["src/main.ts"]).not.toMatch(/createActionHandler|createServer|NYLORUN_ACTIONS_URL/);
    // No tools: a code tool would be refused on save, and an HTTP tool needs a service.
    expect(files["agents/assistant/agent.ts"]).not.toMatch(/^[^/\n]*\.tools\(/m);
    expect(files["agents/assistant/agent.ts"]).toContain("http({");
    expect(files["agents/assistant/agent.ts"]).toContain("@nylorun/agents");
    expect(files["agents/assistant/agent.ts"]).not.toMatch(/\bmodel\s*:/);
    expect(files["README.md"]).toContain("8787");
    expect(JSON.parse(files["package.json"]!).name).toBe("my-nylorun-agent");
    expect(files["README.md"]).toMatch(/^# My Nylorun agent\n/u);
  });
  it("names Docker, not a global Runtime, as the prerequisite", async () => {
    const files = await starterFiles(compatibility);
    expect(files["README.md"]).toContain("Docker");
    expect(files["README.md"]).not.toContain("npm install --global @nylorun/runtime");
    expect(files["README.md"]).not.toContain("nylorun-studio");
  });
  it("renders ignore files under their real names so npm cannot drop them", async () => {
    const files = await starterFiles(compatibility);
    expect(files[".gitignore"]).toContain("node_modules/");
    expect(files[".env.example"]).toContain("MODEL_PROVIDER=");
    expect(files[".env.example"]).toContain("MODEL=");
    expect(files[".env.example"]).toContain("MODEL_PROVIDER_API_KEY=");
    expect(files[".env.example"]).not.toContain("PORT=");
    expect(files[".gitignore"]).toContain(".nylorun/");
    expect(Object.keys(files).some((path) => path.includes("_gitignore"))).toBe(
      false
    );
  });
});

describe("project creation", () => {
  it("does not overwrite an existing target", async () => {
    const dependencies: CreatorDependencies = {
      currentDirectory: () => "/workspace",
      isInteractive: () => true,
      log: () => {},
      exists: async () => true,
      makeDirectory: async () => undefined,
      rename: async () => undefined,
      remove: async () => undefined,
      write: async () => undefined,
      run: async () => ({ status: 0 }),
      nodeVersion: "24.15.0",
      checkDocker: async () => ({ ok: true as const }),
    };
    await expect(
      createProject(
        { directory: "taken", yes: true },
        compatibility,
        dependencies
      )
    ).rejects.toThrow("already exists");
  });

  it("rejects a target outside the current directory", async () => {
    const dependencies: CreatorDependencies = {
      currentDirectory: () => "/workspace",
      isInteractive: () => true,
      log: () => {},
      exists: async () => false,
      makeDirectory: async () => undefined,
      rename: async () => undefined,
      remove: async () => undefined,
      write: async () => undefined,
      run: async () => ({ status: 0 }),
      nodeVersion: "24.15.0",
      checkDocker: async () => ({ ok: true as const }),
    };
    await expect(
      createProject(
        { directory: "../outside", yes: true },
        compatibility,
        dependencies
      )
    ).rejects.toThrow("new child");
  });
});

it("renders a fresh project before installation, then installs and starts nothing else", async () => {
  const files = new Map<string, string>();
  const commands: unknown[] = [];
  let renamed = false;
  await createProject(
    { directory: "demo", yes: true },
    compatibility,
    {
      currentDirectory: () => "/workspace",
      isInteractive: () => true,
      log: () => {},
      exists: async () => false,
      makeDirectory: async () => {},
      remove: async () => {},
      write: async (path, content) => {
        files.set(path, content);
      },
      rename: async () => {
        renamed = true;
      },
      run: async (command, args, directory) => {
        expect(renamed).toBe(true);
        commands.push([command, args, directory]);
        return { status: 0 };
      },
      nodeVersion: "24.15.0",
      checkDocker: async () => ({ ok: true as const }),
    }
  );
  expect([...files.keys()].some((path) => path.endsWith("/agents/index.ts"))).toBe(
    true
  );
  const packageJson = [...files.entries()].find(([path]) =>
    path.endsWith("/package.json")
  )![1];
  const readme = [...files.entries()].find(
    ([path]) => path.endsWith("/README.md") && !path.includes("/.env/")
  )![1];
  expect(JSON.parse(packageJson).name).toBe("demo");
  expect(readme.startsWith("# demo\n")).toBe(true);
  expect(commands).toEqual([["npm", ["install", "--yes"], "/workspace/demo"]]);
});

it("prints the next steps: the Tenant and its link, then development", async () => {
  const deps = fixture();
  await createProject({ ...options, yes: true }, compatibility, deps);
  const next = deps.log.mock.calls.at(-1)?.[0] as string;
  expect(next).toContain("cd '/workspace/my agent'");
  expect(next.indexOf("npx nylorun@beta start")).toBeGreaterThan(-1);
  expect(next.indexOf("npm run dev")).toBeGreaterThan(
    next.indexOf("npx nylorun@beta start"),
  );
  expect(next).not.toContain("tenant create");
  expect(next).not.toContain("nylorun@beta up");
});

function fixture() {
  return {
    currentDirectory: () => "/workspace",
    isInteractive: () => true,
    log: vi.fn(),
    exists: vi.fn(async () => false),
    makeDirectory: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    rename: vi.fn(async () => {}),
    write: vi.fn(async () => {}),
    run: vi.fn<CreatorDependencies["run"]>(async () => ({ status: 0 })),
    nodeVersion: "24.15.0",
    checkDocker: vi.fn<CreatorDependencies["checkDocker"]>(async () => ({
      ok: true,
    })),
  };
}
const options = { directory: "my agent", yes: false };

it("only installs for a noninteractive create", async () => {
  const deps = fixture();
  deps.isInteractive = () => false;
  await createProject(options, compatibility, deps);
  expect(deps.run.mock.calls.map((call) => call[1])).toEqual([["install"]]);
});

it("stamps package name and README title from a sanitized directory", async () => {
  const deps = fixture();
  const files = new Map<string, string>();
  deps.write = async (path, content) => {
    files.set(path, content);
  };
  await createProject({ ...options, yes: true }, compatibility, deps);
  const packageJson = [...files.entries()].find(([path]) =>
    path.endsWith("/package.json")
  )![1];
  const readme = [...files.entries()].find(
    ([path]) => path.endsWith("/README.md") && !path.includes("/.env/")
  )![1];
  expect(JSON.parse(packageJson).name).toBe("my-agent");
  expect(readme.startsWith("# my-agent\n")).toBe(true);
});

it.each([["installation", 0, ["install"]]])(
  "retains the project and does not advance after %s failure",
  async (_name, failAt, commands) => {
    const deps = fixture();
    let index = 0;
    deps.run.mockImplementation(async () => ({
      status: index++ === failAt ? 1 : 0,
    }));
    await expect(createProject(options, compatibility, deps)).rejects.toThrow(
      "cd '/workspace/my agent'\n"
    );
    expect(deps.run.mock.calls.map((call) => call[1].join(" "))).toEqual(
      commands
    );
    expect(deps.remove).not.toHaveBeenCalled();
  }
);

it.each([
  [{ status: 130 }, 130],
  [{ status: null, signal: "SIGTERM" as const }, 143],
])(
  "preserves cancellation status and does not start development",
  async (result, exitCode) => {
    const deps = fixture();
    deps.run.mockResolvedValueOnce(result);
    await expect(
      createProject(options, compatibility, deps)
    ).rejects.toMatchObject({ exitCode });
    expect(deps.run.mock.calls.map((call) => call[1])).toEqual([["install"]]);
    expect(deps.remove).not.toHaveBeenCalled();
  }
);

it("shows recovery instructions when installation fails to spawn", async () => {
  const deps = fixture();
  deps.run.mockRejectedValueOnce(new Error("spawn failed"));
  await expect(createProject(options, compatibility, deps)).rejects.toThrow(
    /npm install\n.*nylorun@beta start[\s\S]*npm run dev/
  );
  expect(deps.run).toHaveBeenCalledTimes(1);
});

it("stops before development and names missing prerequisites; installs nothing", async () => {
  const deps = fixture();
  deps.nodeVersion = "22.19.0";
  deps.checkDocker = vi.fn(async () => ({
    ok: false as const,
    problem: "Install Docker with Compose v2: Docker Desktop, OrbStack or Colima.",
  }));
  const error = await createProject(options, compatibility, deps).catch(
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(CreationError);
  const message = (error as CreationError).message;
  expect(message).toContain("Node.js 24 or newer (found 22.19.0)");
  expect(message).toContain("Install Docker with Compose v2");
  expect(message).not.toContain("@nylorun/runtime");
  expect(message).toContain("npx nylorun@beta start");
  expect(message).toContain("npm run dev");
  expect(deps.checkDocker).toHaveBeenCalled();
  // Only the project's own dependencies were installed.
  expect(deps.run.mock.calls.map((call) => call[1])).toEqual([["install"]]);
});

it("prints deprecation notes before creating", async () => {
  const deps = fixture();
  await createProject(
    { ...options, yes: true, notes: ["--no-studio is deprecated and ignored"] },
    compatibility,
    deps,
  );
  expect(deps.log.mock.calls[0]).toEqual(["--no-studio is deprecated and ignored"]);
});
