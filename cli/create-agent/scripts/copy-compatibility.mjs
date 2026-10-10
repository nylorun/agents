import { cp, copyFile } from "node:fs/promises";
await copyFile("compatibility.json", "dist/compatibility.json");
await cp("starter", "dist/starter", { recursive: true });
