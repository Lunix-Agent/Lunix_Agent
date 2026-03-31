/**
 * Runtime-agnostic utilities replacing Bun-only APIs.
 * Uses node:fs and node:crypto — both work on Bun and Node.js.
 */

import { readFile, access } from "node:fs/promises"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"

export async function readFileBuffer(filePath: string): Promise<Buffer> {
  return readFile(filePath)
}

export function sha256Hex(data: Buffer | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex")
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

export function isMainModule(importMetaUrl: string): boolean {
  try {
    return process.argv[1] === fileURLToPath(importMetaUrl)
  } catch {
    return false
  }
}
