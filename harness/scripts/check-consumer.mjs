import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, cpSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import ts from "typescript";

/** Validate the actual tarball without reaching the registry or running install scripts. */
export function checkPackedConsumer(cache) {
  const npm = "npm";
  const run = (args, cwd) =>
    execFileSync(npm, args, {
      cwd,
      encoding: "utf8",
      env: { ...process.env, npm_config_cache: cache },
    });
  const pack = (cwd) =>
    join(
      cache,
      JSON.parse(run(["pack", "--ignore-scripts", "--json", "--pack-destination", cache], cwd))[0]
        .filename,
    );
  const harness = pack(process.cwd());
  const core = pack(join(process.cwd(), "../core"));
  const require = createRequire(import.meta.url);
  const zod = pack(dirname(require.resolve("zod/package.json")));
  const hashes = pack(dirname(require.resolve("@noble/hashes/sha2.js")));
  const consumer = join(cache, "consumer");
  mkdirSync(consumer);
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({ name: "interface-consumer", private: true, type: "module" }),
  );
  run(
    [
      "install",
      "--offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      harness,
      core,
      zod,
      hashes,
    ],
    consumer,
  );
  cpSync(
    join(consumer, "node_modules/@nylorun/core"),
    join(consumer, "node_modules/@nylorun/core-copy"),
    { recursive: true },
  );
  const usage = readFileSync("test/types/usage.ts", "utf8").replaceAll(
    "../../src/index.js",
    "@nylorun/harness",
  );
  const migratedUsage = usage.replaceAll("../../src/run/index.js", "@nylorun/harness/run");
  const file = join(consumer, "usage.ts");
  writeFileSync(
    file,
    migratedUsage +
      '\n// @ts-expect-error Compiled definition pieces are not exported.\nimport type { AgentDefinition } from "@nylorun/harness/definition/agent-definition.js";\n',
  );
  const program = ts.createProgram([file], {
    noEmit: true,
    strict: true,
    skipLibCheck: false,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    types: [],
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length)
    throw new Error(
      ts.formatDiagnosticsWithColorAndContext(diagnostics, {
        getCurrentDirectory: () => consumer,
        getCanonicalFileName: (path) => path,
        getNewLine: () => "\n",
      }),
    );
  writeFileSync(
    join(consumer, "check.mjs"),
    `
    import assert from 'node:assert/strict';
    import * as api from '@nylorun/core/define';
    import { z } from 'zod';
    assert.equal('BuiltAgent' in api, false);
    // Manifest v3 omits empty capabilities; compose one so type is projected.
    const agent = api.Agent({ id: 'packed', name: 'Packed', outputSchema: z.object({ count: z.number() }) })
      .use({ id: 'agent' })
      .build();
    assert.deepEqual(Object.keys(agent).sort(), ['id', 'manifest', 'name', 'toJSON']);
    assert.equal(agent.hash, undefined);
    assert.equal(agent.toJSON().manifestSchemaVersion, 5);
    assert.equal(agent.toJSON().capabilities.length, 1);
    assert.equal(agent.toJSON().capabilities[0].id, 'agent');
    assert.equal(agent.toJSON().capabilities[0].type, 'agent');
    const bare = api.Agent({ id: 'bare', name: 'Bare', outputSchema: z.object({ count: z.number() }) }).build();
    assert.deepEqual(bare.toJSON().capabilities, []);
    const execution = await import('@nylorun/harness/run');
    const state = execution.createExecutionState(agent);
    const result = await execution.run({ binding: execution.bindingFromAgent(agent), state, input: 'go', onModelCall: async () => ({ output: [{type: 'json', value: {count: 1}}] }) });
    assert.equal(result.status, 'completed');
    assert.deepEqual(result.output, {count: 1});
    assert.throws(() => execution.createExecutionState({...agent}), /getBinding/);
    await assert.rejects(import('@nylorun/harness/definition/agent-definition.js'), {code: 'ERR_PACKAGE_PATH_NOT_EXPORTED'});
    const foreign = await import('./node_modules/@nylorun/core-copy/dist/define.js');
    assert.equal(api.isToolError(new foreign.ToolError('foreign', 'Foreign tool error')), true);
    const foreignAgent = foreign.Agent({id:'foreign',name:'Foreign',outputSchema:z.object({count:z.number()}).refine(v=>v.count===2)}).use({ id: 'agent' }).build();
    const foreignResult = await execution.run({binding:execution.bindingFromAgent(foreignAgent),input:'go',onModelCall:async()=>({output:[{type:'json',value:{count:2}}]})});
    assert.equal(foreignResult.status,'completed');
    assert.deepEqual(foreignResult.output,{count:2});
    const invalidOutput = await execution.run({binding:execution.bindingFromAgent(foreignAgent),input:'go',onModelCall:async()=>({output:[{type:'json',value:{count:3}}]})});
    assert.equal(invalidOutput.status,'failed');
    assert.equal(typeof execution.run, 'function');
    assert.equal(typeof execution.createRunState, 'function');
    assert.equal(typeof execution.runDurable, 'function');
    assert.equal(typeof execution.createDurableCheckpoint, 'function');
    for (const removed of ['runHosted', 'createHostedCheckpoint', 'createEngineState']) assert.equal(removed in execution, false);
    await assert.rejects(import('@nylorun/harness/engine'), {code: 'ERR_PACKAGE_PATH_NOT_EXPORTED'});
  `,
  );
  execFileSync(process.execPath, [join(consumer, "check.mjs")], { cwd: consumer, stdio: "pipe" });
  console.log("Packed consumer runtime and declaration checks passed.");
}
