#!/usr/bin/env node
// Coverage that counts what is missing.
//
// `node --test --experimental-test-coverage` reports only the files a test
// actually loaded. A module no test imports does not appear as 0% — it does not
// appear at all, and the summary percentage is computed as though it did not
// exist. That is how this project once read 91.8% while roughly a quarter of
// its lines were exercised: the untested files were invisible to the measure,
// so the number went *up* as the untested surface grew.
//
// This gate enumerates the source tree itself, matches it against the lcov
// output, and scores anything unmatched as zero.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const SOURCE_DIRS = ["worker", "app", "db"];
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx"]);

// Minimum line coverage across all source files, counting unloaded files as
// zero. Raise this as coverage improves; never lower it to make a build pass.
const LINE_THRESHOLD = Number(process.env.COVERAGE_THRESHOLD ?? 55);

// Files that cannot be loaded by `node --test` at all, with the reason. These
// are excluded from the denominator because no test could cover them without a
// bundler or a Workers runtime — not because they are unimportant. Keep this
// list short and justified; anything added here stops being measured.
const UNINSTRUMENTABLE = new Map([
  ["db/index.ts", "imports cloudflare:workers, which only resolves inside a Worker"],
  ["app/api/scan-now/route.ts", "imports cloudflare:workers for the env bindings"],
  ["worker/index.ts", "Worker entry point; imports cloudflare:workers and vinext/server"],
  ["app/page.tsx", "JSX, which node's type stripping does not compile"],
  ["app/layout.tsx", "JSX, which node's type stripping does not compile"],
  ["build/sites-vite-plugin.ts", "build tooling, not application code"],
  ["app/chatgpt-auth.ts", "imports next/headers, which only resolves through the bundler"],
]);

async function sourceFiles(dir) {
  const found = [];
  const walk = async (current) => {
    for (const entry of await readdir(path.join(ROOT, current), { withFileTypes: true })) {
      const relative = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(relative);
      else if (SOURCE_EXTENSIONS.has(path.extname(entry.name)) && !entry.name.endsWith(".d.ts")) found.push(relative);
    }
  };
  if (existsSync(path.join(ROOT, dir))) await walk(dir);
  return found;
}

// lcov gives DA:<line>,<hits> records per file, which is exactly the
// executable-line detail needed to aggregate honestly across files.
function parseLcov(lcov) {
  const files = new Map();
  let current = null;
  for (const line of lcov.split("\n")) {
    if (line.startsWith("SF:")) {
      current = { total: 0, covered: 0 };
      files.set(path.normalize(line.slice(3).trim()), current);
    } else if (line.startsWith("DA:") && current) {
      const [, hits] = line.slice(3).split(",");
      current.total += 1;
      if (Number(hits) > 0) current.covered += 1;
    }
  }
  return files;
}

const scratch = mkdtempSync(path.join(tmpdir(), "atlas-coverage-"));
const lcovPath = path.join(scratch, "coverage.lcov");

try {
  execFileSync(process.execPath, [
    "--test",
    "--experimental-test-coverage",
    "--test-reporter=lcov", `--test-reporter-destination=${lcovPath}`,
    "--test-reporter=spec", "--test-reporter-destination=stdout",
    "tests/**/*.test.mjs",
  ], { cwd: ROOT, stdio: "inherit" });
} catch {
  console.error("\nTests failed; coverage not evaluated.");
  rmSync(scratch, { recursive: true, force: true });
  process.exit(1);
}

const measured = parseLcov(readFileSync(lcovPath, "utf8"));
rmSync(scratch, { recursive: true, force: true });

const all = (await Promise.all(SOURCE_DIRS.map(sourceFiles))).flat().sort();
const rows = [];
let totalLines = 0;
let coveredLines = 0;

for (const file of all) {
  if (UNINSTRUMENTABLE.has(file)) continue;
  const stats = measured.get(file);
  // An unmeasured file is zero, not absent. Its line count still has to enter
  // the denominator or the gate rewards leaving code untested.
  const total = stats?.total ?? readFileSync(path.join(ROOT, file), "utf8").split("\n").filter((line) => line.trim()).length;
  const covered = stats?.covered ?? 0;
  totalLines += total;
  coveredLines += covered;
  rows.push({ file, total, covered, pct: total ? (covered / total) * 100 : 100, loaded: Boolean(stats) });
}

const overall = totalLines ? (coveredLines / totalLines) * 100 : 100;

console.log("\nCoverage across all source files (unloaded files counted as zero)\n");
for (const row of rows.sort((a, b) => a.pct - b.pct || a.file.localeCompare(b.file))) {
  const pct = row.loaded ? `${row.pct.toFixed(1).padStart(5)}%` : "  none";
  console.log(`  ${pct}  ${String(row.covered).padStart(4)}/${String(row.total).padEnd(4)}  ${row.file}`);
}

const skipped = all.filter((file) => UNINSTRUMENTABLE.has(file));
if (skipped.length) {
  console.log("\nNot instrumentable under node --test:");
  for (const file of skipped) console.log(`  ${file} — ${UNINSTRUMENTABLE.get(file)}`);
}

console.log(`\n  overall: ${overall.toFixed(2)}% of ${totalLines} lines (threshold ${LINE_THRESHOLD}%)`);

if (overall < LINE_THRESHOLD) {
  console.error(`\nCoverage ${overall.toFixed(2)}% is below the ${LINE_THRESHOLD}% threshold.`);
  process.exit(1);
}
console.log("Coverage gate passed.\n");
