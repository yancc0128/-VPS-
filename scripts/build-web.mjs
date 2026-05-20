import { copyFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "dist", "web");
const files = ["index.html", "styles.css", "app.js"];

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

await Promise.all(
  files.map((file) => copyFile(path.join(root, file), path.join(outDir, file)))
);

console.log(`Web frontend built to ${path.relative(root, outDir)}`);
