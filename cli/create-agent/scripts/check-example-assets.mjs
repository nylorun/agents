import assert from 'node:assert/strict';
import {access,readFile} from 'node:fs/promises';
const root=new URL('../../../examples/',import.meta.url);
assert.match(await readFile(new URL('agents/index.ts',root),'utf8'),/release\/index/);
await access(new URL('dist/agents/release/agent.js',root));
// Advanced examples remain preserved outside the supported default registry.
await access(new URL('agents/skills/catalog/structured-summary/SKILL.md',root));
console.log('Supported registry and preserved advanced assets passed.');
