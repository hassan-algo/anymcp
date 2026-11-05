// Validates the registry folder and writes registry/index.json, the file clients download.
// Usage: node scripts/build-registry.mjs [registry-dir] [--check]
//   --check  fail if index.json is missing or out of date instead of writing it (for CI)
//
// generatedAt only changes when the content changes, so rebuilding is a no-op in git.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CategoriesFileSchema, ListSchema, ProfileSchema, RegistryIndexSchema } from "../packages/shared/dist/index.js";

const root = path.resolve(process.argv.slice(2).find((a) => !a.startsWith("--")) ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "registry"));
const check = process.argv.includes("--check");
const errors = [];

function load(file, schema) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    errors.push(`${file}: ${err.message}`);
    return undefined;
  }
  const r = schema.safeParse(data);
  if (!r.success) {
    for (const i of r.error.issues) errors.push(`${file}: ${i.path.join(".") || "(root)"}: ${i.message}`);
    return undefined;
  }
  return r.data;
}

const categoriesFile = load(path.join(root, "categories.json"), CategoriesFileSchema);
const categories = categoriesFile?.categories ?? [];
const categoryIds = new Set(categories.map((c) => c.id));

const profiles = [];
const sitesDir = path.join(root, "sites");
for (const dir of fs.existsSync(sitesDir) ? fs.readdirSync(sitesDir).sort() : []) {
  if (dir.startsWith(".")) continue;
  const file = path.join(sitesDir, dir, "profile.json");
  const p = load(file, ProfileSchema);
  if (!p) continue;
  if (p.id !== dir) errors.push(`${file}: id "${p.id}" must match folder name "${dir}"`);
  for (const c of p.categories) if (!categoryIds.has(c)) errors.push(`${file}: unknown category "${c}"`);
  profiles.push(p);
}
const profileIds = new Set(profiles.map((p) => p.id));

const lists = [];
const listsDir = path.join(root, "lists");
for (const name of fs.existsSync(listsDir) ? fs.readdirSync(listsDir).sort() : []) {
  if (!name.endsWith(".json")) continue;
  const file = path.join(listsDir, name);
  const l = load(file, ListSchema);
  if (!l) continue;
  if (`${l.id}.json` !== name) errors.push(`${file}: id "${l.id}" must match file name`);
  for (const p of l.profiles) if (!profileIds.has(p)) errors.push(`${file}: unknown profile "${p}"`);
  lists.push(l);
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}

const indexFile = path.join(root, "index.json");
let previous;
try {
  previous = JSON.parse(fs.readFileSync(indexFile, "utf8"));
} catch {
  previous = undefined;
}
const content = { categories, lists, profiles };
const same =
  previous &&
  JSON.stringify({ categories: previous.categories, lists: previous.lists, profiles: previous.profiles }) === JSON.stringify(content);
const index = RegistryIndexSchema.parse({
  schemaVersion: 1,
  generatedAt: same ? previous.generatedAt : new Date().toISOString(),
  ...content,
});
const text = JSON.stringify(index, null, 2) + "\n";

if (check) {
  const current = fs.existsSync(indexFile) ? fs.readFileSync(indexFile, "utf8") : "";
  if (current !== text) {
    console.error("registry/index.json is out of date. Run `npm run build:registry` and commit the result.");
    process.exit(1);
  }
  console.log("registry/index.json is up to date.");
} else {
  if (!same || !previous) fs.writeFileSync(indexFile, text);
  console.log(`Registry OK: ${profiles.length} profiles, ${lists.length} lists, ${categories.length} categories → ${path.relative(process.cwd(), indexFile)}`);
}
