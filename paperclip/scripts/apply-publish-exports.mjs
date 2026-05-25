#!/usr/bin/env node
// Applies publishConfig.exports to each workspace package's exports field.
// Run after `pnpm build` and before tarballing for deployment. This bridges
// the gap between pnpm's dev-time .ts exports and the compiled .js output
// that `node` needs at runtime (where tsx is not available).

import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

function findWorkspacePackages(dir) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const pkgPath = join(full, "package.json");
      try {
        statSync(pkgPath);
        results.push(pkgPath);
      } catch {}
      results.push(...findWorkspacePackages(full));
    }
  }
  return results;
}

let patched = 0;
let skipped = 0;

for (const pkgPath of findWorkspacePackages(repoRoot)) {
  if (pkgPath.includes("node_modules")) continue;

  const raw = readFileSync(pkgPath, "utf8");
  const pkg = JSON.parse(raw);

  if (!pkg.publishConfig?.exports) {
    skipped++;
    continue;
  }

  const before = JSON.stringify(pkg.exports);
  pkg.exports = pkg.publishConfig.exports;
  const after = JSON.stringify(pkg.exports);

  if (before === after) {
    skipped++;
    continue;
  }

  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  const rel = pkgPath.slice(repoRoot.length + 1);
  console.log(`  patched ${rel}`);
  patched++;
}

console.log(`apply-publish-exports: ${patched} patched, ${skipped} skipped`);
if (patched === 0) {
  console.warn("warning: no packages were patched — are publishConfig.exports fields present?");
}
