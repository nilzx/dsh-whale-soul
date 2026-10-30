import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { acquireRootLock, atomicWrite } from '../src/memory/v2/transactions.js'
import { MemoryError } from '../src/memory/v2/contracts.js'

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'dsh-whale-soul-transactions-'))
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true })
}

// Any of these left behind means a lock attempt either leaked or failed to retire.
function coordinationEntries(root) {
  return readdirSync(root).filter((name) => /^(?:\.writer(?:-recovery)?\.lock|\.(?:lock-candidate|retired-lock)-)/.test(name))
}

test('atomic writes publish the file where a directory fsync is refused', () => {
  const root = tempRoot()
  try {
    const path = join(root, 'root', 'spaces', 'owner', 'manifest.json')
    atomicWrite(path, JSON.stringify({ format_version: 2 }))
    assert.equal(readFileSync(path, 'utf8'), '{"format_version":2}')
    assert.deepEqual(readdirSync(dirname(path)).filter((name) => name.includes('.tmp-')), [])
  } finally { cleanup(root) }
})

test('a released lock leaves neither a writer lock nor a candidate directory', async () => {
  const root = tempRoot()
  try {
    const lock = join(root, 'memory.repair-lock')
    const release = await acquireRootLock(lock, { waitMs: 2000 })
    release()
    assert.deepEqual(coordinationEntries(lock), [])
  } finally { cleanup(root) }
})

test('a contended acquisition fails closed without leaking its candidate', async () => {
  const root = tempRoot()
  try {
    const lock = join(root, 'memory.repair-lock')
    const release = await acquireRootLock(lock, { waitMs: 2000 })
    try {
      await assert.rejects(() => acquireRootLock(lock, { waitMs: 50 }),
        (error) => error instanceof MemoryError && error.code === 'WRITER_BUSY')
      assert.deepEqual(coordinationEntries(lock), ['.writer.lock'])
    } finally { release() }
    assert.deepEqual(coordinationEntries(lock), [])
  } finally { cleanup(root) }
})
