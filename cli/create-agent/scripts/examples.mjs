import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { examplesFiles, synchronize } from "../dist/sync.js";
const read = async (path) =>
  JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
const compatibility = await read("../compatibility.json");
const recipe = await read("../examples.recipe.json");
const manifest = await read("../package.json");
const check = process.argv.includes("--check");
const files = await examplesFiles(compatibility, recipe);
const changes = await synchronize(
  fileURLToPath(new URL("../../../examples", import.meta.url)),
  files,
  compatibility,
  {
    check,
    adopt: process.argv.includes("--adopt"),
    creatorVersion: manifest.version,
  },
);
if (changes.length) {
  console.log(
    `${check ? "Scaffold drift" : "Updated"}:\n${changes.join("\n")}`,
  );
  if (check) {
    console.error(
      "Run npm run examples:sync and commit the generated changes.",
    );
    process.exitCode = 1;
  }
} else console.log("Examples match the creator shell.");
