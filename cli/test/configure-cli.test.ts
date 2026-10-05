import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import {
  PROTOCOL_FEATURES,
  PROTOCOL_VERSION,
} from "@nylorun/core/compatibility";
import { link3, MANAGEMENT_KEY, project, writeProjectLink } from "./helpers/project.js";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const roots: string[] = [];
const servers: { close(): void }[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) server.close();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function startHost() {
  const catalog = {
    providers: [
      {
        id: "openai",
        name: "OpenAI",
        models: [{ id: "gpt-4.1", name: "GPT-4.1" }],
      },
    ],
  };
  const headers: IncomingHttpHeaders[] = [];
  const server = createServer(async (request, response) => {
    const url = request.url ?? "/";
    if (url !== "/health") headers.push(request.headers);
    if (url === "/health") {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          status: "ok",
          protocol: {
            min: PROTOCOL_VERSION,
            max: PROTOCOL_VERSION,
            features: [...PROTOCOL_FEATURES],
          },
          hostId: "host_01habcdefghijklmnopqrstuvw",
        }),
      );
      return;
    }
    if (url === "/v1/tenant/models" && request.method === "GET") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(catalog));
      return;
    }
    response.statusCode = 404;
    response.end("{}");
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, headers };
}

it(
  "F2-4: configure lists Tenant /models catalog then cancels cleanly",
  { timeout: 15_000 },
  async () => {
    const root = await project("configure-cli-");
    roots.push(root);
    const host = await startHost();
    await writeProjectLink(root, link3(host.url));
    const child = spawn(process.execPath, [cli, "configure"], {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        MODEL_PROVIDER_API_KEY: "",
        NYLORUN_RUNTIME_URL: "",
        NYLORUN_SERVER_KEY: "",
        NYLORUN_MANAGEMENT_KEY: "",
      },
    });
    let text = "";
    child.stdout!.on("data", (data) => {
      text += data;
      if (text.includes("Choose a provider:")) {
        child.kill("SIGINT");
      }
    });
    child.stderr!.on("data", (data) => {
      text += data;
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    expect(text).toContain("0. Custom OpenAI-compatible provider");
    expect(text).toContain("1. OpenAI (openai)");
    // The catalog request names no Tenant: the installation serves one. It carries the
    // Project's management key (the Management API's).
    expect(host.headers).toHaveLength(1);
    expect(host.headers[0]!.authorization).toBe(`Bearer ${MANAGEMENT_KEY}`);
    expect(host.headers[0]!["nylorun-tenant"]).toBeUndefined();
    // SIGINT may surface as 130, 143, null, or 1 depending on timing.
    expect([0, 1, 130, 143, null]).toContain(code);
  },
);
