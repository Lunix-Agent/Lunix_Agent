#!/usr/bin/env bun
/**
 * prepublish-check.ts
 *
 * Run this before every npm publish. It exercises 12 checks that gate
 * the publish and prints a clear pass/fail report.
 *
 * Usage:
 *   bun run scripts/prepublish-check.ts
 *   bun run publish-check          (via package.json script)
 */

import { $ } from "bun"
import { readFile, access, rm, mkdir, readdir } from "node:fs/promises"
import path from "node:path"

const PKG_DIR = path.resolve(import.meta.dir, "..")
const PKG_JSON_PATH = path.join(PKG_DIR, "package.json")

// Derive tarball filename from scoped package name
// @scope/name → scope-name-version.tgz
function tarballName(name: string, version: string): string {
  const cleaned = name.replace(/^@/, "").replace(/\//g, "-")
  return `${cleaned}-${version}.tgz`
}

let passed = 0
let failed = false

function pass(msg: string) {
  console.log(`  \x1b[32m✓\x1b[0m ${msg}`)
  passed++
}

function fail(msg: string): never {
  console.log(`  \x1b[31m✗\x1b[0m ${msg}`)
  console.log(`\n\x1b[31mFailed at check ${passed + 1}. Fix the issue above and re-run.\x1b[0m`)
  process.exit(1)
}

const pkg = JSON.parse(await readFile(PKG_JSON_PATH, "utf-8"))

console.log(`\n${pkg.name} prepublish check\n`)

// ─── Check 1: package.json required fields ──────────────────────────────────
const requiredFields = [
  "name", "version", "description", "license", "author", "repository",
  "keywords", "main", "types", "exports", "bin", "files", "engines",
]
const missing = requiredFields.filter(f => !pkg[f])
if (missing.length > 0) {
  fail(`package.json missing fields: ${missing.join(", ")}`)
}
pass("package.json fields complete")

// ─── Check 2: LICENSE file exists ───────────────────────────────────────────

try {
  await access(path.join(PKG_DIR, "LICENSE"))
  pass("LICENSE exists")
} catch {
  fail("LICENSE file not found")
}

// ─── Check 3: README.md exists and is substantive ───────────────────────────

try {
  const readme = await readFile(path.join(PKG_DIR, "README.md"), "utf-8")
  const lines = readme.split("\n").length
  if (lines < 100) {
    fail(`README.md too short (${lines} lines, need >100)`)
  }
  pass(`README.md exists (${lines} lines)`)
} catch {
  fail("README.md not found")
}

// ─── Check 4: Typecheck passes ──────────────────────────────────────────────

{
  const result = await $`cd ${PKG_DIR} && bun run typecheck`.quiet().nothrow()
  if (result.exitCode !== 0) {
    console.log(result.stderr.toString())
    fail("typecheck failed")
  }
  pass("typecheck passed")
}

// ─── Check 5: Tests pass ────────────────────────────────────────────────────

{
  const result = await $`cd ${PKG_DIR} && bun test`.quiet().nothrow()
  const output = result.stderr.toString() + result.stdout.toString()
  const match = output.match(/(\d+) pass/)
  const count = match ? match[1] : "?"
  if (result.exitCode !== 0) {
    console.log(output)
    fail("tests failed")
  }
  pass(`${count} tests passed`)
}

// ─── Check 6: Build succeeds ────────────────────────────────────────────────

{
  await rm(path.join(PKG_DIR, "dist"), { recursive: true, force: true })
  const result = await $`cd ${PKG_DIR} && bun run build`.quiet().nothrow()
  if (result.exitCode !== 0) {
    console.log(result.stderr.toString())
    fail("build failed")
  }
  const requiredFiles = ["dist/index.js", "dist/index.d.ts", "dist/cli.js"]
  for (const f of requiredFiles) {
    try {
      await access(path.join(PKG_DIR, f))
    } catch {
      fail(`build output missing: ${f}`)
    }
  }
  pass(`build succeeded (${requiredFiles.join(", ")})`)
}

// ─── Check 7: No Bun-only APIs in dist ──────────────────────────────────────

{
  const result = await $`grep -r "Bun\\.file\\|Bun\\.CryptoHasher\\|Bun\\.stdin\\|import\\.meta\\.main\\|import\\.meta\\.dir" ${path.join(PKG_DIR, "dist")} --include="*.js"`.quiet().nothrow()
  const matches = result.stdout.toString().trim()
  if (matches.length > 0) {
    console.log(matches)
    fail("Bun-only APIs found in dist/")
  }
  pass("no Bun-only APIs in dist/")
}

// ─── Check 8: Pack dry run ──────────────────────────────────────────────────

{
  const result = await $`cd ${PKG_DIR} && bun pm pack --dry-run`.quiet().nothrow()
  const output = result.stdout.toString() + result.stderr.toString()

  // Extract only the "packed" lines (actual tarball contents)
  const packedLines = output.split("\n").filter(l => l.trimStart().startsWith("packed "))
  const packedPaths = packedLines.map(l => l.replace(/^\s*packed\s+[\d.]+\w+\s+/, "").trim())

  // Check for files that should NOT be in the tarball
  const banned = ["tests/", "node_modules/", ".env", "tsconfig.json", "tsconfig.build.json"]
  for (const b of banned) {
    if (packedPaths.some(p => p.includes(b))) {
      fail(`tarball contains banned path: ${b}`)
    }
  }

  // Check for files that MUST be in the tarball
  const required = ["package.json", "README.md", "src/index.ts", "dist/index.js"]
  for (const r of required) {
    if (!packedPaths.some(p => p.includes(r))) {
      fail(`tarball missing required file: ${r}`)
    }
  }

  const totalMatch = output.match(/Total files:\s*(\d+)/)
  const sizeMatch = output.match(/Packed size:\s*([\d.]+\s*\w+)/)
  const totalFiles = totalMatch ? totalMatch[1] : "?"
  const packedSize = sizeMatch ? sizeMatch[1] : "?"
  pass(`tarball contents clean (${totalFiles} files, ${packedSize})`)
}

// ─── Check 9: Isolated Bun install test ─────────────────────────────────────

{
  const tarball = path.join(PKG_DIR, `${tarballName(pkg.name, pkg.version)}`)
  const tmpDir = `/tmp/.fit-publish-bun-test-${Date.now()}`

  // Pack the tarball
  await $`cd ${PKG_DIR} && bun pm pack`.quiet().nothrow()

  try {
    await rm(tmpDir, { recursive: true, force: true })
    await mkdir(tmpDir, { recursive: true })

    const localTarball = path.join(tmpDir, `${tarballName(pkg.name, pkg.version)}`)
    await $`cp ${tarball} ${localTarball}`.quiet()

    await $`cd ${tmpDir} && bun init -y`.quiet().nothrow()
    const addResult = await $`cd ${tmpDir} && bun add ${localTarball}`.quiet().nothrow()
    if (addResult.exitCode !== 0) {
      fail(`Bun install failed: ${addResult.stderr.toString()}`)
    }

    // Test library import
    const importResult = await $`cd ${tmpDir} && bun -e "const m = await import('${pkg.name}'); if (typeof m.createClient !== 'function') throw new Error('createClient not a function')"`.quiet().nothrow()
    if (importResult.exitCode !== 0) {
      fail(`Bun import failed: ${importResult.stderr.toString()}`)
    }

    // Test CLI
    const cliResult = await $`cd ${tmpDir} && bunx fitui --help`.quiet().nothrow()
    if (cliResult.exitCode !== 0) {
      fail(`bunx fitui --help failed: ${cliResult.stderr.toString()}`)
    }

    pass("Bun install + import works")
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
    await rm(tarball, { force: true })
  }
}

// ─── Check 10: Isolated Node install test ───────────────────────────────────

{
  const tarball = path.join(PKG_DIR, `${tarballName(pkg.name, pkg.version)}`)
  // Use /tmp to avoid inheriting workspace config from parent directories
  const tmpDir = `/tmp/.fit-publish-node-test-${Date.now()}`

  await $`cd ${PKG_DIR} && bun pm pack`.quiet().nothrow()

  try {
    await rm(tmpDir, { recursive: true, force: true })
    await mkdir(tmpDir, { recursive: true })

    // Copy tarball into temp dir so npm doesn't resolve upward into the workspace
    const localTarball = path.join(tmpDir, `${tarballName(pkg.name, pkg.version)}`)
    await $`cp ${tarball} ${localTarball}`.quiet()

    await $`cd ${tmpDir} && npm init -y`.quiet().nothrow()
    const addResult = await $`cd ${tmpDir} && npm install ${localTarball} --no-fund --no-audit`.quiet().nothrow()
    if (addResult.exitCode !== 0) {
      fail(`Node install failed: ${addResult.stderr.toString()}`)
    }

    // Test library import
    const importResult = await $`cd ${tmpDir} && node -e "import('${pkg.name}').then(m => { if (typeof m.createClient !== 'function') { process.exit(1) } })"`.quiet().nothrow()
    if (importResult.exitCode !== 0) {
      fail(`Node import failed: ${importResult.stderr.toString()}`)
    }

    // Test CLI
    const cliResult = await $`cd ${tmpDir} && npx fitui --help`.quiet().nothrow()
    if (cliResult.exitCode !== 0) {
      fail(`npx fitui --help failed: ${cliResult.stderr.toString()}`)
    }

    pass("Node install + import works")
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
    await rm(tarball, { force: true })
  }
}

// ─── Check 11: Exports resolve correctly ────────────────────────────────────

{
  const tarball = path.join(PKG_DIR, `${tarballName(pkg.name, pkg.version)}`)
  const tmpDir = `/tmp/.fit-publish-exports-test-${Date.now()}`

  await $`cd ${PKG_DIR} && bun pm pack`.quiet().nothrow()

  try {
    await rm(tmpDir, { recursive: true, force: true })
    await mkdir(tmpDir, { recursive: true })

    const localTarball = path.join(tmpDir, `${tarballName(pkg.name, pkg.version)}`)
    await $`cp ${tarball} ${localTarball}`.quiet()

    await $`cd ${tmpDir} && npm init -y`.quiet().nothrow()
    await $`cd ${tmpDir} && npm install ${localTarball} --no-fund --no-audit`.quiet().nothrow()

    const exports = ["createClient", "setupDatabase", "listActivities", "weeklyLoad", "sessionDetail"]
    for (const name of exports) {
      const result = await $`cd ${tmpDir} && node -e "import('${pkg.name}').then(m => { if (typeof m.${name} !== 'function') { console.error('missing: ${name}'); process.exit(1) } })"`.quiet().nothrow()
      if (result.exitCode !== 0) {
        fail(`export '${name}' not found on Node`)
      }
    }

    pass(`exports resolve correctly (${exports.length} checked)`)
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
    await rm(tarball, { force: true })
  }
}

// ─── Check 12: Version not already published ────────────────────────────────

{
  const result = await $`npm view ${pkg.name}@${pkg.version} version`.quiet().nothrow()
  const published = result.stdout.toString().trim()
  if (published === pkg.version) {
    fail(`version ${pkg.version} is already published on npm — bump the version first`)
  }
  pass(`version ${pkg.version} not yet published`)
}

// ─── Summary ────────────────────────────────────────────────────────────────

console.log(`\n\x1b[32mAll ${passed} checks passed.\x1b[0m Ready to publish:\n`)
console.log(`  cd packages/fit-tui && npm publish --access public\n`)
