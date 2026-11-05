// Validates every file in a registry folder. Usage: node validate-registry.js <registry-dir>
// Exits non-zero on any problem, so it can run in CI on pull requests.

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { CategoriesFileSchema, ListSchema, ProfileSchema } from "./profile.js";

const root = process.argv[2] ?? "registry";
const errors: string[] = [];

function load<T>(file: string, schema: z.ZodType<T>): T | undefined {
  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    errors.push(`${file}: ${(err as Error).message}`);
    return undefined;
  }
  const result = schema.safeParse(data);
  if (!result.success) {
    for (const issue of result.error.issues) {
      errors.push(`${file}: ${issue.path.join(".") || "(root)"}: ${issue.message}`);
    }
    return undefined;
  }
  return result.data;
}

const categories = load(path.join(root, "categories.json"), CategoriesFileSchema);
const categoryIds = new Set(categories?.categories.map((c) => c.id));

const profileIds = new Set<string>();
const sitesDir = path.join(root, "sites");
for (const dir of fs.existsSync(sitesDir) ? fs.readdirSync(sitesDir) : []) {
  const file = path.join(sitesDir, dir, "profile.json");
  const profile = load(file, ProfileSchema);
  if (!profile) continue;
  if (profile.id !== dir) errors.push(`${file}: id "${profile.id}" must match folder name "${dir}"`);
  for (const c of profile.categories) {
    if (!categoryIds.has(c)) errors.push(`${file}: unknown category "${c}"`);
  }
  profileIds.add(profile.id);
}

const listsDir = path.join(root, "lists");
for (const name of fs.existsSync(listsDir) ? fs.readdirSync(listsDir) : []) {
  if (!name.endsWith(".json")) continue;
  const file = path.join(listsDir, name);
  const list = load(file, ListSchema);
  if (!list) continue;
  for (const p of list.profiles) {
    if (!profileIds.has(p)) errors.push(`${file}: unknown profile "${p}"`);
  }
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log(`Registry OK: ${profileIds.size} profile(s), ${categoryIds.size} categories.`);
