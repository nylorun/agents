/**
 * Model settings' inputs (protocol 12), in Chromium: a connected catalog model shows its
 * catalog's inputs checked and fixed and what the operator may add as checkboxes that call
 * `PUT /v1/tenant/models/inputs`; the custom endpoint form writes `settings.inputs`.
 *
 * Run with `npm run test:e2e` (builds first). Not part of `npm run check`:
 * it needs Playwright's Chromium (`npx playwright install chromium`).
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { PROTOCOL_FEATURES, PROTOCOL_VERSION } from "@nylorun/agents";
import { startStudioServer } from "../dist/server.js";

const ADMIN_KEY = "e".repeat(64);
const TENANT = "tn_00000000000000000000000001";
const WEB_ROOT = fileURLToPath(new URL("../dist/web", import.meta.url));
const time = "2026-10-14T00:00:00.000Z";

type Put = { path: string; body: Record<string, any> };

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return address.port;
}

/**
 * A Runtime with OpenAI connected: `gpt-test` reads text and images and may add PDFs and Office
 * documents. It records model PUTs and applies them like the real one.
 */
async function fakeRuntime() {
  const puts: Put[] = [];
  let added: string[] = [];
  let custom: Record<string, any> | undefined;
  const inputs = () => ["text", "image", ...added];
  const protocol = { min: PROTOCOL_VERSION, max: PROTOCOL_VERSION, features: [...PROTOCOL_FEATURES] };
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const [path = ""] = (req.url ?? "").split("?");
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (path === "/health") return send(200, { status: "ok", protocol });
    if (path === "/v1/tenant") return send(200, { tenant: { id: TENANT, name: "orders" } });
    if (path === "/v1/agents") return send(200, { agents: [] });
    if (path === "/v1/sessions") return send(200, { sessions: [] });
    if (path === "/v1/agent-manifests") return send(200, { manifests: [] });
    if (path === "/v1/tenant/models/inputs" && req.method === "PUT") {
      const body = JSON.parse(raw);
      puts.push({ path, body });
      added = body.inputs.filter((input: string) => input === "pdf" || input === "office");
      return send(200, { provider: body.provider, model: body.model, inputs: inputs() });
    }
    if (path === "/v1/tenant/model" && req.method === "PUT") {
      const body = JSON.parse(raw);
      puts.push({ path, body });
      custom = body;
      return send(200, { configured: true, provider: body.provider, model: body.model, baseUrl: body.baseUrl, settings: body.settings });
    }
    if (path === "/v1/tenant/providers")
      return send(200, {
        providers: [
          { id: "openai", name: "OpenAI", model: "gpt-test", authType: "api_key", inputs: inputs(), lastUpdated: time, active: true },
          ...(custom
            ? [{
                id: "custom",
                name: "Custom endpoint",
                model: custom.model,
                authType: "api_key",
                baseUrl: custom.baseUrl,
                settings: custom.settings,
                inputs: ["text", ...(custom.settings?.inputs ?? [])],
                lastUpdated: time,
                active: false,
              }]
            : []),
        ],
      });
    if (path === "/v1/tenant/models")
      return send(200, {
        providers: [
          {
            id: "openai",
            name: "OpenAI",
            models: [{ id: "gpt-test", name: "GPT Test", inputs: inputs(), addableInputs: ["pdf", "office"] }],
          },
        ],
      });
    if (path === "/v1/tenant/model")
      return send(200, { configured: true, provider: "openai", model: "gpt-test" });
    send(200, {});
  });
  const port = await listen(server);
  return { url: `http://127.0.0.1:${port}`, puts, close: () => (server.closeAllConnections(), server.close()) };
}

async function withModels(run: (context: { page: Page; puts: Put[] }) => Promise<void>) {
  const runtime = await fakeRuntime();
  const studio = await startStudioServer({
    runtimeUrl: runtime.url,
    adminKey: ADMIN_KEY,
    port: 0,
    webRoot: WEB_ROOT,
    log: () => {},
  });
  const browser: Browser = await chromium.launch();
  try {
    const minted = await fetch(`${studio.url}/_studio/login-tokens`, {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
    });
    const { url } = (await minted.json()) as { url: string };
    const page = await browser.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(url);
    // The Tenant's root opens its Agents.
    await page.waitForURL(new RegExp(`/tenants/${TENANT}(?:/agents)?$`, "u"));
    await page.goto(`${studio.url}/tenants/${TENANT}/settings/models`);
    await run({ page, puts: runtime.puts });
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser.close();
    await studio.close();
    runtime.close();
  }
}

test("a connected model's inputs: its catalog's are checked and fixed, an addable one toggles through the Runtime", async () => {
  await withModels(async ({ page, puts }) => {
    const group = page.getByRole("group", { name: "OpenAI inputs" });
    const box = (name: string) => group.getByRole("checkbox", { name, exact: true });
    await box("Images").waitFor();
    assert.equal(await box("Images").isChecked(), true);
    assert.equal(await box("Images").isDisabled(), true);
    assert.equal(await box("PDF").isChecked(), false);
    assert.equal(await box("PDF").isEnabled(), true);
    assert.equal(await box("Office documents").isEnabled(), true);
    // Neither read nor addable: not shown.
    assert.equal(await box("Audio").count(), 0);
    assert.equal(await box("Video").count(), 0);

    await box("PDF").click();
    await page.waitForFunction(() =>
      [...document.querySelectorAll<HTMLInputElement>("input[type=checkbox]")].some(
        (input) => input.parentElement?.textContent === "PDF" && input.checked && !input.disabled,
      ),
    );
    assert.equal(puts.length, 1);
    assert.equal(puts[0]!.path, "/v1/tenant/models/inputs");
    assert.deepEqual(
      { provider: puts[0]!.body.provider, model: puts[0]!.body.model, inputs: puts[0]!.body.inputs },
      { provider: "openai", model: "gpt-test", inputs: ["text", "image", "pdf"] },
    );

    await box("PDF").click();
    await page.waitForFunction(() =>
      [...document.querySelectorAll<HTMLInputElement>("input[type=checkbox]")].some(
        (input) => input.parentElement?.textContent === "PDF" && !input.checked && !input.disabled,
      ),
    );
    assert.equal(puts.length, 2);
    assert.deepEqual(puts[1]!.body.inputs, ["text", "image"]);
  });
});

test("the custom endpoint form writes settings.inputs and restores them on open", async () => {
  await withModels(async ({ page, puts }) => {
    await page.getByRole("group", { name: "OpenAI inputs" }).waitFor();
    await page.getByRole("button", { name: "Add Provider" }).click();
    await page.getByRole("menuitem", { name: "Custom OpenAI-compatible" }).click();
    const sheet = page.getByRole("dialog");
    // An OpenAI-compatible endpoint carries no Office documents.
    assert.equal(await sheet.getByRole("checkbox", { name: "Office documents" }).count(), 0);
    await sheet.getByLabel("Base URL").fill("http://127.0.0.1:1/v1");
    await sheet.getByLabel("Model id").fill("local-vl");
    await sheet.getByRole("checkbox", { name: "Images", exact: true }).check();
    await sheet.getByRole("checkbox", { name: "Audio", exact: true }).check();
    await sheet.getByLabel("API key").fill("sk-test-custom");
    await sheet.getByRole("button", { name: "Save provider" }).click();
    await page.getByRole("group", { name: "Custom endpoint inputs" }).waitFor();
    const put = puts.find((each) => each.path === "/v1/tenant/model");
    assert.ok(put);
    assert.deepEqual(put.body.settings, { inputs: ["image", "audio"] });

    // Its row shows what it reads; the form is where they change.
    const row = page.getByRole("group", { name: "Custom endpoint inputs" });
    assert.equal(await row.getByRole("checkbox", { name: "Audio" }).isChecked(), true);
    assert.equal(await row.getByRole("checkbox", { name: "Audio" }).isDisabled(), true);

    await page.getByRole("button", { name: "Custom endpoint actions" }).click();
    await page.getByRole("menuitem", { name: "Update credentials" }).click();
    const reopened = page.getByRole("dialog");
    await reopened.getByLabel("Base URL").waitFor();
    assert.equal(await reopened.getByRole("checkbox", { name: "Images", exact: true }).isChecked(), true);
    assert.equal(await reopened.getByRole("checkbox", { name: "Audio", exact: true }).isChecked(), true);
    assert.equal(await reopened.getByRole("checkbox", { name: "PDF", exact: true }).isChecked(), false);
    assert.equal(await reopened.getByRole("checkbox", { name: "Video", exact: true }).isChecked(), false);
  });
});
