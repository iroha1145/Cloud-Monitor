import { readFile, writeFile } from "node:fs/promises";
const root = new URL("../dist-showcase/", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("manifest.json", root), "utf8"));
for (const key of ["id", "start_url", "scope"]) manifest[key] = "./";
await writeFile(new URL("manifest.json", root), JSON.stringify(manifest, null, 2) + "\n");
// Both files are compiled in showcase mode; use the explicitly marked demo entry.
await writeFile(new URL("index.html", root), await readFile(new URL("demo.html", root), "utf8"));
