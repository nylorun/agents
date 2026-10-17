import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * Run the built `nylorun` in an empty directory, with an empty home directory (`HOME`, so
 * `~/.nylorun` is empty too) and without Docker on PATH.
 */
function nylorun(args: string[], env: Record<string, string> = {}, entry = "dist/cli.js") {
  const cwd = mkdtempSync(join(tmpdir(), "nylorun-cli-"));
  dirs.push(cwd);
  const result = spawnSync(process.execPath, [join(process.cwd(), entry), ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: join(cwd, "user"),
      PATH: dirname(process.execPath),
      NYLORUN_HOME: "",
      NYLORUN_TENANT: "",
      ...env,
    },
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("nylorun", () => {
  it("lists the installation's commands and the groups", () => {
    const { code, stdout } = nylorun(["--help"]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/up\|start \[--tenant <name>\]/);
    expect(stdout).toMatch(/down\|stop/);
    expect(stdout).toMatch(/^ {2}doctor sandbox \[--tenant <name>\] \[--json\]/m);
    expect(stdout).toMatch(/^ {2}apply \[<dir>\.\.\.\] \[--dry-run\] \[--if-match <n>\]$/m);
    expect(stdout).toMatch(
      /^ {2}migrate v8 <agent\.json> \[--runtime <environment-manifest\.json>\] \[--name <name>\] \[--out <dir>\]$/m,
    );
    expect(stdout).toMatch(/^ {2}agent-manifests {2}list \| get \| versions \| rm$/m);
    expect(stdout).toMatch(/^ {2}agents {8}list \| get \| put \| pin \| track \| restart \| fork \| stop /m);
    expect(stdout).toMatch(/^ {2}sessions {6}list \| create \| get \| send/m);
    expect(stdout).not.toMatch(/^ {2}environments/m);
    expect(stdout).toMatch(/^ {2}artifacts {5}list \| get \| upload/m);
    expect(stdout).toMatch(
      /^ {2}tenant {8}reset \| keys \| signing-keys \| models \| usage \| calls \| budgets \| tool-policy \|\n {16}settings \| coverage \| mcp$/m,
    );
    expect(stdout).toMatch(/^ {2}local {9}ls \| delete \| logs \| reset \| sandbox \| telemetry/m);
    expect(stdout).not.toMatch(/\bnylo\b|legacy|\bdev\b|configure/i);
    expect(stdout).not.toMatch(/^ {2}(up|down|status|studio)\b.*--name/m);
  });

  it("lists every agents command the agents group's help names", () => {
    const top = nylorun(["--help"]).stdout;
    const group = top.match(/^ {2}agents {8}.*(\n {16}.*)*/m)![0];
    const commands = [...nylorun(["agents", "--help"]).stdout.matchAll(/^ {2}([a-z][a-z-]*)\b/gm)].map((m) => m[1]!);
    expect(commands).toEqual(expect.arrayContaining(["pin", "track", "restart", "triggers", "runs", "memories"]));
    for (const command of new Set([...commands, "reset"]))
      expect(group).toMatch(new RegExp(`(^|[ |])${command}( |$)`, "m"));
  });

  it.each([
    [["migrate", "v8"], /^Usage: nylorun migrate v8 <agent\.json>.*--name <name>/],
    [["apply", "agent"], /^Usage: nylorun apply /],
    [["agents", "get"], /^Usage: nylorun agents get <id>\n\nEvery command takes --tenant <name>/],
    [["agents", "pin", "a1"], /^Usage: nylorun agents pin <id> <version>/],
    [["agents", "secrets"], /^Usage:\n {2}secrets list <id>/],
    [["agents", "triggers"], /^Usage:\n {2}triggers list <id>/],
    [["agents", "memories", "ls"], /^Usage: nylorun agents memories ls <id>/],
    [["sessions", "exec", "s1"], /^Usage: nylorun sessions exec <id>/],
    [["artifacts", "zip"], /^Usage: nylorun artifacts zip/],
    [["agent-manifests", "get"], /^Usage: nylorun agent-manifests get/],
    [["tenant", "reset"], /^Usage: nylorun tenant reset /],
    [["tenant", "keys"], /^Usage:\n {2}keys put <id>/],
    [["tenant", "keys", "put"], /^Usage: nylorun tenant keys put <id>/],
    [["tenant", "signing-keys"], /^Usage:\n {2}signing-keys list/],
    [["tenant", "models"], /^Usage:\n {2}models catalog/],
    [["tenant", "models", "set"], /^Usage: nylorun tenant models set/],
    [["tenant", "budgets"], /^Usage: nylorun tenant budgets \[get \| put <file\|->\]/],
    [["tenant", "settings"], /^Usage:\n {2}settings sandbox [^]*settings limits/],
    [["tenant", "settings", "limits"], /^Usage: nylorun tenant settings limits/],
    [["tenant", "coverage"], /^Usage: nylorun tenant coverage --agent <id>/],
    [["tenant", "mcp"], /^Usage:\n {2}mcp inspect <url>/],
    [["tenant", "usage"], /^Usage: nylorun tenant usage /],
    [["up"], /^Usage: nylorun (up|start) /],
    [["status"], /^Usage: nylorun status /],
    [["doctor"], /^Usage: nylorun doctor \[--json\]/],
    [["doctor", "sandbox"], /^Usage: nylorun doctor sandbox /],
    [["local", "logs"], /^Usage: nylorun local logs /],
    [["local", "sandbox", "status"], /^Usage: nylorun local sandbox status /],
    [["local", "telemetry", "enable"], /^Usage: nylorun local telemetry /],
  ])("%j --help prints its own usage (exit 0)", (args, usage) => {
    for (const help of ["--help", "-h"]) {
      const { code, stdout, stderr } = nylorun([...args, help]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      expect(stdout).toMatch(usage);
    }
    expect(nylorun(["tenant", "settings", "--help"]).stdout).not.toMatch(/budgets|tool-policy|coverage/);
  });

  it("each group has its own help", () => {
    expect(nylorun(["local", "--help"]).stdout).toMatch(/^ {2}delete <tenant> --yes/m);
    expect(nylorun(["tenant", "--help"]).stdout).toMatch(/^ {2}keys put <id> \[--management\] \[--tenant <name>\]/m);
    expect(nylorun(["agents", "--help"]).stdout).toMatch(/^ {2}secrets put <id> <name> <secret\.json\|->/m);
    expect(nylorun(["agents", "--help"]).stdout).toMatch(/^ {2}put <id> --manifest <name\[@n\]> \[--owner <user>\]/m);
    expect(nylorun(["sessions", "--help"]).stdout).toMatch(/^ {2}exec <id> \[--timeout <s>\] -- <command>/m);
    expect(nylorun(["artifacts", "--help"]).stdout).toMatch(/^ {2}upload <file\|->/m);
    expect(nylorun(["local", "sandbox", "--help"]).stdout).toMatch(/sandbox enable --context <name>/);
  });

  it("the agent manifest commands have their own help", () => {
    expect(nylorun(["agent-manifests", "--help"]).stdout).toMatch(/^ {2}get <name>\[@<n>\]/m);
    expect(nylorun(["apply", "--help"]).stdout).toMatch(/^ {2}--if-match <n> /m);
    expect(nylorun(["migrate", "--help"]).stdout).toMatch(/^ {2}--runtime <file> /m);
  });

  it.each([
    [["dev"], /npx nylorun start/],
    [["dev", "--ephemeral"], /npx nylorun start/],
    [["legacy", "stop"], /^nylorun <command>/],
    [["stack", "start"], /^nylorun <command>/],
    [["doctor", "stack"], /Usage: nylorun doctor \[--json\]/],
    [["logs"], /^nylorun logs moved: nylorun local logs$/m],
    [["ls"], /^nylorun ls moved: nylorun local ls$/m],
    [["delete", "x", "--yes"], /^nylorun delete moved: nylorun local delete$/m],
    [["telemetry"], /^nylorun telemetry moved: nylorun local telemetry$/m],
    [["reset", "--yes"], /nylorun local reset deletes a local Tenant's volumes; nylorun tenant reset/],
    [["key", "put", "x"], /^nylorun key moved: nylorun tenant keys put\|list\|rm$/m],
    [["mcp", "inspect", "x"], /^nylorun mcp moved: nylorun tenant mcp inspect <url>$/m],
    [["configure"], /^nylorun configure is nylorun tenant models set$/m],
    [["access", "signing-keys", "list"], /nylorun tenant signing-keys/],
    [["env"], /nylorun env was removed: the SDKs read the Project link themselves/],
    [["status", "--env"], /nylorun env was removed/],
    [["sandbox", "ls"], /^nylorun sandbox ls moved: nylorun agents list$/m],
    [["sandbox", "rm", "x"], /^nylorun sandbox rm moved: nylorun agents rm <id>$/m],
    [["sandbox", "enable"], /^nylorun sandbox moved: nylorun local sandbox enable$/m],
    [["local", "sandbox", "ls"], /^nylorun sandbox ls moved: nylorun agents list$/m],
    [["local", "nothing"], /^Unknown local command nothing\./m],
    [["tenant"], /^nylorun tenant <command>/m],
    [["tenant", "list"], /^Unknown tenant command list\./m],
    [["tenant", "keys"], /keys put <id>/],
    [["tenant", "keys", "put"], /Usage: nylorun tenant keys put <id>/],
    [["tenant", "models"], /^ {2}models set --provider <id> --model <id>/m],
    [["tenant", "models", "set", "--provider", "openai"], /Pass both --provider and --model/],
    [["tenant", "budgets", "put"], /Usage: nylorun tenant budgets \[get \| put <file\|->\]/],
    [["tenant", "reset", "--sessions", "--all"], /Pass only one of --sessions, --agents, --all/],
    [["tenant", "reset", "--environments"], /--environments is --agents in protocol 16/],
    [["environments"], /^nylorun environments is nylorun agents in protocol 16/m],
    [["environments", "list"], /^nylorun environments is nylorun agents in protocol 16/m],
    [["agents"], /^nylorun agents <command>/m],
    [["agents", "save", "agent.json"], /nylorun agents save was removed in protocol 16: .*nylorun apply <dir>/],
    [["agents", "put", "a1"], /Usage: nylorun agents put <id> --manifest <name\[@n\]>/],
    [["agents", "put", "a1", "--manifest", "box", "--kind", "pod"], /--kind was removed in protocol 16/],
    [["agent-manifests"], /^nylorun agent-manifests <command>/m],
    [["agent-manifests", "get", "bad name"], /is not an agent manifest's name/],
    [["migrate"], /^nylorun migrate v8 <agent\.json>/m],
    [["migrate", "v7", "a.json"], /nylorun migrate knows v8 only/],
    [["sessions", "create", "--agent", "a", "--owner", "u", "--environment", "e"], /--environment was removed in protocol 16/],
    [["sessions", "nope"], /^Unknown sessions command nope\./m],
    [["artifacts"], /^nylorun artifacts <command>/m],
    [["sessions", "send", "s1"], /Nothing to send/],
    [["sessions", "send", "s1", "hi", "--data", "1"], /--data is a message of its own/],
    [["sessions", "exec", "s1", "ls"], /Usage: nylorun sessions exec <id>/],
    [["sessions", "list", "--scope", "sessions:own"], /--scope needs --as <subject>/],
    [["sessions", "list", "--as", "u1", "--scope", "everything"], /Unknown scope everything/],
    [["sessions", "send", "s1", "--file", "a@x"], /the version must be a positive number/],
    [["agents", "restore", "a1", "v2"], /The version is a positive number or latest/],
    [["agents", "list", "--label", "nokey"], /--label must be key=value/],
    [["artifacts", "upload", "-"], /Name the file with --name/],
    [["artifacts", "zip", "a1"], /Usage: nylorun artifacts zip/],
    [["doctor", "sandbox", "--tenant"], /Usage: nylorun doctor sandbox \[--tenant <name>\] \[--json\]/],
  ])("%j names its replacement (exit 2)", (args, message) => {
    const { code, stderr } = nylorun(args);
    expect(code).toBe(2);
    expect(stderr).toMatch(message);
  });

  it("acts on the default Tenant outside a project, and lists none on an empty machine", () => {
    const status = nylorun(["status"]);
    expect(status.code).toBe(3);
    expect(status.stdout).toMatch(/^Tenant {6}default absent \(nothing under .*user\/\.nylorun\/tenants\/default; run "nylorun start"\)/);
    expect(nylorun(["start"]).stderr).toMatch(/docker command was not found/);
    expect(nylorun(["status", "--tenant", "tn_x"]).stderr).toMatch(/not a Tenant id/);
    const ls = nylorun(["local", "ls"]);
    expect(ls.code).toBe(0);
    expect(ls.stdout).toMatch(/^No Tenants on this machine\./);
    const deleted = nylorun(["local", "delete", "nothing", "--yes"]);
    expect(deleted.code).toBe(3);
  });

  it("the tenant and agents groups need a running local Tenant, or a remote installation", () => {
    const keys = nylorun(["tenant", "signing-keys", "list"]);
    expect(keys.code).toBe(3);
    expect(keys.stderr).toMatch(/No Tenant default under .*Run "nylorun start" first/);
    // NYLORUN_RUNTIME_URL alone is an app's: it names no installation for the Management API.
    expect(nylorun(["tenant", "reset"], { NYLORUN_RUNTIME_URL: "http://127.0.0.1:9" }).code).toBe(3);
    const remote = nylorun(["status"], {
      NYLORUN_RUNTIME_URL: "http://127.0.0.1:9",
      NYLORUN_MANAGEMENT_KEY: "cd".repeat(32),
    });
    expect(remote.code).toBe(1);
    expect(remote.stderr).toMatch(/The installation at http:\/\/127\.0\.0\.1:9 did not answer/);
  });
});

describe("nylo (part of nylorun now)", () => {
  it.each([
    [["status"], /^nylo is part of nylorun now: nylo status is nylorun status\. nylorun 0\.19 removes nylo\.$/m],
    [["reset", "--all"], /nylo reset is nylorun tenant reset\./],
    [["access", "signing-keys", "list"], /nylo access is nylorun tenant signing-keys list\|rotate\|revoke\./],
    [["configure"], /nylo configure is nylorun tenant models set\./],
    [["doctor", "sandbox"], /nylo doctor is nylorun doctor sandbox\./],
    [["env"], /nylo env is nothing: the SDKs read the Project link themselves/],
    [[], /^nylo is part of nylorun now: run nylorun --help\. nylorun 0\.19 removes nylo\.$/m],
  ])("%j names the nylorun command (exit 2)", (args, message) => {
    const { code, stdout, stderr } = nylorun(args, {}, "dist/nylo.js");
    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toMatch(message);
  });
});
