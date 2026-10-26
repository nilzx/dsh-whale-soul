import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { normalizeTags, nowIso, summarize } from './schema.js'
import { assetPath } from './asset-route.js'

const MAX_BYTES = 8 * 1024 * 1024
const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

function assetId(hash) {
  return `a-${hash.slice(0, 20)}`
}

function metadataPath(store, id) {
  return join(store.paths.assets, `${id}.json`)
}

function findFileFor(store, id) {
  try {
    for (const file of readdirSync(store.paths.assets)) {
      if (file.startsWith(`${id.replace(/^a-/, '')}.`) || file.startsWith(`${id}.`)) {
        return join(store.paths.assets, file)
      }
    }
  } catch {
    // no assets yet
  }
  return null
}

export function readAsset(store, id) {
  if (!id || typeof id !== 'string') return null
  const path = metadataPath(store, id)
  if (!existsSync(path)) return null
  try {
    const meta = JSON.parse(readFileSync(path, 'utf8'))
    return { ...meta, path: meta.file ? join(store.paths.assets, meta.file) : findFileFor(store, meta.id) }
  } catch {
    return null
  }
}

export function listAssets(store) {
  try {
    return readdirSync(store.paths.assets)
      .filter((file) => file.endsWith('.json'))
      .map((file) => {
        try {
          return JSON.parse(readFileSync(join(store.paths.assets, file), 'utf8'))
        } catch {
          return null
        }
      })
      .filter(Boolean)
  } catch {
    return []
  }
}

export function findAsset(store, { id, tag, query } = {}) {
  if (id) return readAsset(store, id)
  const assets = listAssets(store)
  const wantedTag = typeof tag === 'string' ? tag.trim().toLowerCase() : ''
  const q = String(query ?? '').trim().toLowerCase()
  return (
    assets.find((asset) => wantedTag && asset.tags?.includes(wantedTag)) ??
    assets.find((asset) => q && `${asset.description} ${asset.tags?.join(' ')}`.toLowerCase().includes(q)) ??
    null
  )
}

export async function saveAsset(store, input = {}) {
  let bytes
  let extension = ''
  let source = input.source || 'file'
  if (input.bytes) {
    bytes = Buffer.from(input.bytes)
    if (bytes.byteLength > MAX_BYTES) throw new Error('image is larger than 8 MiB')
    extension = input.extension || Object.entries(MIME).find(([, mime]) => mime === input.mediaType)?.[0] || ''
  } else if (input.filePath) {
    const path = String(input.filePath)
    const stat = statSync(path)
    if (stat.size > MAX_BYTES) throw new Error('image is larger than 8 MiB')
    bytes = readFileSync(path)
    extension = extname(path).toLowerCase()
    source = path
  } else if (input.url) {
    const url = new URL(String(input.url))
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('only http(s) image URLs are supported')
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) })
    if (!response.ok) throw new Error(`image download failed: HTTP ${response.status}`)
    const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim() ?? ''
    extension = Object.entries(MIME).find(([, mime]) => mime === contentType)?.[0] ?? extname(url.pathname).toLowerCase()
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.byteLength > MAX_BYTES) throw new Error('image is larger than 8 MiB')
    bytes = buffer
    source = url.href
  } else {
    throw new Error('filePath, url, or bytes is required')
  }
  if (!MIME[extension]) throw new Error('supported image types: png, jpg, jpeg, webp, gif')
  const hash = createHash('sha256').update(bytes).digest('hex')
  const id = assetId(hash)
  mkdirSync(store.paths.assets, { recursive: true, mode: 0o700 })
  const existing = readAsset(store, id)
  const target = join(store.paths.assets, `${hash}${extension}`)
  if (!existsSync(target)) writeFileSync(target, bytes, { mode: 0o600 })
  const tags = normalizeTags(input.tags, 'meme')
  const description = summarize(input.description ?? existing?.description ?? '一张主人发来的图', 240)
  const meta = {
    schema_version: 1,
    id,
    file: `${hash}${extension}`,
    mime: input.mediaType || MIME[extension],
    bytes: bytes.byteLength,
    description,
    tags,
    source,
    created_at: existing?.created_at ?? nowIso(),
    updated_at: nowIso(),
    uses: existing?.uses ?? 0,
  }
  writeFileSync(metadataPath(store, id), JSON.stringify(meta, null, 2), { encoding: 'utf8', mode: 0o600 })
  return meta
}

export function markAssetUsed(store, id) {
  const asset = readAsset(store, id)
  if (!asset) return null
  const meta = { ...asset, uses: (asset.uses ?? 0) + 1, last_used_at: nowIso() }
  delete meta.path
  writeFileSync(metadataPath(store, id), JSON.stringify(meta, null, 2), { encoding: 'utf8', mode: 0o600 })
  return meta
}

export function deleteAsset(store, id) {
  const asset = readAsset(store, id)
  if (!asset) return false
  if (asset.path) rmSync(asset.path, { force: true })
  rmSync(metadataPath(store, id), { force: true })
  return true
}

export function assetUrl(baseUrl, asset, root) {
  if (!baseUrl || !asset?.file || !root) return null
  const path = assetPath(root, asset.file)
  return path ? `${String(baseUrl).replace(/\/+$/, '')}${path}` : null
}
