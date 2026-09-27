import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {starterFiles} from '../dist/scaffold.js';
const pins=JSON.parse(await readFile(new URL('../compatibility.json',import.meta.url),'utf8'));
const files=await starterFiles(pins);const p=JSON.parse(files['package.json']);
assert.equal(p.dependencies['@nylorun/agents'],pins.agents);assert.equal(p.dependencies['@nylorun/cli'],undefined);assert.equal(p.devDependencies['@nylorun/cli'],pins.cli);
assert.equal(p.dependencies['@nylorun/runtime'],undefined);assert.equal(p.devDependencies['@nylorun/runtime'],undefined);
assert.equal(p.dependencies.hono,undefined);assert.equal(p.dependencies['@nylorun/harness'],undefined);
assert.equal(files['src/index.ts'],undefined);assert.ok(files['src/main.ts']);assert.match(files['agents/assistant/agent.ts'],/lookup_order/);
assert.equal(p.scripts.dev,'nylorun dev');
// Studio runs in the local Docker stack (ghcr.io/nylorun/studio); the starter never depends on it.
assert.equal(p.dependencies['@nylorun/studio'],undefined);assert.equal(p.devDependencies['@nylorun/studio'],undefined);
assert.equal(p.scripts.studio,undefined);assert.ok(!JSON.stringify(p).includes('nylorun-studio'));
assert.match(files['.gitignore'],/\.nylorun\//);
assert.equal(p.scripts.start,'node dist/src/main.js');
assert.ok(!files['agents/assistant/agent.ts'].match(/\bmodel\s*:/));
// Admin is for CLI/desktop/CI — starter apps must not depend on it.
assert.equal(p.dependencies['@nylorun/admin'],undefined);
assert.equal(p.devDependencies?.['@nylorun/admin'],undefined);
assert.match(pins.admin,/^\d+\.\d+\.\d+-beta$/);
// The prerequisites are Node and Docker; the global Runtime launcher is gone.
assert.ok(!files['README.md'].includes('npm install --global @nylorun/runtime'));
assert.match(files['README.md'],/Docker/);
console.log('SDK registry starter contract passed: Studio and the Runtime come from the Docker stack.');
