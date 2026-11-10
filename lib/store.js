/**
 * Minimal JSON file store.
 *
 * Two safety rules learned the hard way on this host:
 *   1. Never write a UTF-8 BOM — DSH's profile reader (and several JSON.parse
 *      call sites here) reject `\uFEFF ` outright.
 *   2. Write through a temp file + rename so a crash mid-write cannot leave a
 *      truncated file behind.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

const NO_BOM = new TextEncoder().encode('\uFEFF')

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

export async function readJson(file, fallback = null) {
  try {
    const raw = await fs.readFile(file, 'utf8')
    const text = stripBom(raw).trim()
    if (text.length === 0) return fallback
    return JSON.parse(text)
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback
    throw error
  }
}

export async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const body = JSON.stringify(value, null, 2) + '\n'
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`)
  await fs.writeFile(tmp, body, { encoding: 'utf8' })
  await fs.rename(tmp, file)
  return file
}

export async function readText(file, fallback = null) {
  try {
    return stripBom(await fs.readFile(file, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback
    throw error
  }
}

export async function appendLine(file, line) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.appendFile(file, line.endsWith('\n') ? line : line + '\n', 'utf8')
}

/** Append an NDJSON journal record; failures never break the caller's flow. */
export async function journal(file, record) {
  try {
    await appendLine(file, JSON.stringify({ ts: new Date().toISOString(), ...record }))
  } catch {
    /* journaling is best-effort */
  }
}

export function noBomBytes(text) {
  return Buffer.from(text, 'utf8').subarray(0, NO_BOM.length).equals(Buffer.from(NO_BOM))
}
