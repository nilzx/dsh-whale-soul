import { basename, extname, isAbsolute } from 'node:path'

export const name = 'whale-soul-file-image'
export const inject = ['tools', 'fs', 'attachments', 'llm', 'workingDirectory']
export const MAX_FILE_IMAGE_BYTES = 20 * 1024 * 1024
const original = (value) => value?.[Symbol.for('cordis.original')] ?? value
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }
const CODES = new Set(['INVALID_ARGUMENTS', 'SCOPE_DENIED', 'REVOKED', 'CANCELLED', 'TIMEOUT', 'ROUTE_UNAVAILABLE',
  'NOT_FOUND', 'NOT_REGULAR_FILE', 'PROTECTED_PATH', 'TOO_LARGE', 'INVALID_IMAGE', 'UNSUPPORTED_IMAGE', 'ATTACHMENT_UNAVAILABLE'])
const failure = (code) => Object.assign(new Error(`FILE_IMAGE_${CODES.has(code) ? code : 'ATTACHMENT_UNAVAILABLE'}`), { code })
const escape = (text) => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
function sniff(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png'
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg'
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif'
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  return null
}
function imageReference(ref) {
  if (!ref || !/^sha256:[a-f0-9]{64}$/.test(ref.attachmentId) || !Object.values(MIME).includes(ref.mediaType) ||
    ![ref.bytes, ref.width, ref.height].every((value) => Number.isSafeInteger(value) && value > 0) || ref.bytes > MAX_FILE_IMAGE_BYTES) throw failure('ATTACHMENT_UNAVAILABLE')
  const value = Object.fromEntries(['attachmentId', 'mediaType', 'bytes', 'width', 'height'].map((key) => [key, ref[key]]))
  if (typeof ref.name === 'string' && !/[\/\\\0]/.test(ref.name)) value.name = ref.name
  if (ref.originalDimensions && [ref.originalDimensions.width, ref.originalDimensions.height].every((n) => Number.isSafeInteger(n) && n > 0)) {
    value.originalDimensions = { width: ref.originalDimensions.width, height: ref.originalDimensions.height }
  }
  return value
}
function waitFor(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(failure(signal.reason?.name === 'TimeoutError' ? 'TIMEOUT' : 'CANCELLED'))
    if (signal.aborted) { abort(); Promise.resolve(promise).catch(() => {}); return }
    signal.addEventListener('abort', abort, { once: true })
    Promise.resolve(promise).then((value) => { signal.removeEventListener('abort', abort); resolve(value) },
      (error) => { signal.removeEventListener('abort', abort); reject(error) })
  })
}
function safeFailure(error) {
  if (CODES.has(error?.code)) return failure(error.code)
  if (['PROTECTED_READ_DENIED', 'PROTECTED_READ_FAILED', 'HOST_PRIVATE_ROOTS_CHANGED', 'PROTECTED_BACKEND_REPLACED', 'PROTECTED_ROOT_CHANGED'].includes(error?.code)) return failure('PROTECTED_PATH')
  if (error?.code === 'FS_NOT_FOUND') return failure('NOT_FOUND')
  if (['FS_TOO_LARGE', 'IMAGE_TOO_LARGE', 'IMAGE_DIMENSION_TOO_LARGE', 'IMAGE_TOO_MANY_PIXELS'].includes(error?.code)) return failure('TOO_LARGE')
  if (['INVALID_IMAGE', 'IMAGE_TYPE_MISMATCH', 'ATTACHMENT_WRITE_FAILED'].includes(error?.code)) return failure('INVALID_IMAGE')
  if (['FS_ABORTED', 'ABORT_ERR'].includes(error?.code) || error?.name === 'AbortError') return failure('CANCELLED')
  return failure('ATTACHMENT_UNAVAILABLE')
}

/** A role-local adapter over the protected fs, never a host-path exception.
 * ownsAgent and captureBoundary are trusted host functions, not tool arguments.
 * captureBoundary(exec) returns a current authorization check for this call.
 */
export function createFileImageAdapter(ctx, { ownsAgent, captureBoundary, maxImageBytes = MAX_FILE_IMAGE_BYTES, timeoutMs = 10000 } = {}) {
  if (typeof ownsAgent !== 'function' || typeof captureBoundary !== 'function' || !Number.isSafeInteger(maxImageBytes) ||
    maxImageBytes < 1 || maxImageBytes > MAX_FILE_IMAGE_BYTES || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw failure('INVALID_ARGUMENTS')
  const lifetime = new AbortController(), pending = new Set()
  let disposed = false
  const tool = {
    name: 'read_image', description: 'Read a PNG/JPEG/WebP/GIF file and return the image itself. Large images are normalized automatically.',
    parameters: { type: 'object', additionalProperties: false, properties: { file_path: { type: 'string', description: 'Path to the image file, resolved in the current Agent working directory.' } }, required: ['file_path'] },
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      path: { type: 'string' }, image: { type: 'object', additionalProperties: true },
    }, required: ['path', 'image'] }, render: (_args, value) => [{ type: 'text', text: `<path>${escape(value.path)}</path>\n<type>image</type>\n<content>\n${value.image.mediaType} image, ${value.image.width}x${value.image.height} px, ${value.image.bytes} bytes\n</content>` },
    { type: 'image', attachment: value.image }], presentationMeta: (_args, value) => ({ path: value.path }) },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const task = (async () => {
        try {
          if (!args || typeof args !== 'object' || Object.keys(args).some((key) => key !== 'file_path') || typeof args.file_path !== 'string' ||
            !args.file_path.trim() || args.file_path.length > 4096 || args.file_path.includes('\0') || !args.file_path.isWellFormed()) throw failure('INVALID_ARGUMENTS')
          const agent = exec?.agent, session = agent?.session
          if (disposed || !session || ownsAgent(agent) !== true) throw failure('SCOPE_DENIED')
          const fs = ctx.get('fs'), attachments = ctx.get('attachments'), llm = ctx.get('llm'), directory = ctx.get('workingDirectory')
          if (typeof fs?.resolve !== 'function' || typeof fs?.stat !== 'function' || typeof fs?.readBytes !== 'function' ||
            typeof attachments?.saveImage !== 'function' || typeof llm?.resolveModelInfo !== 'function' || typeof directory?.ensure !== 'function') throw failure('ATTACHMENT_UNAVAILABLE')
          const boundary = captureBoundary(exec)
          if (typeof boundary !== 'function') throw failure('REVOKED')
          const route = () => {
            const config = agent.session.requestHeader?.()?.config
            return { provider: config?.provider ?? agent.options?.provider, model: config?.model ?? agent.options?.model }
          }
          const selected = route(), signal = AbortSignal.any([lifetime.signal, ...(exec.signal ? [exec.signal] : []), AbortSignal.timeout(timeoutMs)])
          const check = () => {
            if (signal.aborted) throw failure(signal.reason?.name === 'TimeoutError' ? 'TIMEOUT' : 'CANCELLED')
            if (disposed || agent.session !== session || ownsAgent(agent) !== true || boundary() !== true ||
              original(ctx.get('fs')) !== original(fs) || original(ctx.get('attachments')) !== original(attachments) ||
              original(ctx.get('llm')) !== original(llm) || original(ctx.get('workingDirectory')) !== original(directory) ||
              JSON.stringify(route()) !== JSON.stringify(selected)) throw failure('REVOKED')
          }
          check()
          if (!selected.provider || !selected.model) throw failure('ROUTE_UNAVAILABLE')
          let info
          try { info = await waitFor(llm.resolveModelInfo(selected.provider, selected.model, signal), signal) }
          catch (error) { if (signal.aborted) throw error; throw failure('ROUTE_UNAVAILABLE') }
          check()
          if (!info?.inputModalities?.includes('image')) throw failure('ROUTE_UNAVAILABLE')
          const cwd = await waitFor(directory.ensure(agent, signal), signal); check()
          if (typeof cwd !== 'string' || !isAbsolute(cwd)) throw failure('SCOPE_DENIED')
          const target = await waitFor(fs.resolve(args.file_path, { cwd, signal }), signal); check()
          const stat = await waitFor(fs.stat(target, signal), signal); check()
          if (!stat) throw failure('NOT_FOUND')
          if (stat.type !== 'file') throw failure('NOT_REGULAR_FILE')
          const limits = [maxImageBytes, attachments.imageLimits?.maxImageBytes, attachments.imageLimits?.maxMessageImageBytes]
          if (!limits.every((value) => Number.isSafeInteger(value) && value > 0)) throw failure('ATTACHMENT_UNAVAILABLE')
          const cap = Math.min(...limits)
          if (stat.size !== undefined && stat.size > cap) throw failure('TOO_LARGE')
          const extension = extname(args.file_path).toLowerCase(), declared = MIME[extension]
          if (extension && !declared) throw failure('UNSUPPORTED_IMAGE')
          const data = Buffer.from(await waitFor(fs.readBytes(target, signal, cap), signal)); check()
          if (!data.length || data.length > cap) throw failure('TOO_LARGE')
          const mediaType = sniff(data)
          if (!mediaType || declared && declared !== mediaType) throw failure('INVALID_IMAGE')
          if (!attachments.imageLimits.mediaTypes?.includes(mediaType)) throw failure('UNSUPPORTED_IMAGE')
          const ref = await waitFor(attachments.saveImage({ data, mediaType, name: basename(fs.processPath(target)) }), signal); check()
          const image = imageReference(ref), path = fs.processPath(target)
          if (typeof path !== 'string' || !isAbsolute(path)) throw failure('REVOKED')
          ctx.emit('fs/observed', target, { kind: 'present', version: stat.version }, exec)
          check()
          return { path, image }
        } catch (error) { throw safeFailure(error) }
      })()
      pending.add(task)
      try { return await task } finally { pending.delete(task) }
    },
  }
  return { tool, async dispose() { if (disposed) return; disposed = true; lifetime.abort(); await Promise.allSettled([...pending]) } }
}

export function apply(ctx, config) {
  const adapter = createFileImageAdapter(ctx, config)
  ctx.tools.register(adapter.tool)
  ctx.effect(() => () => adapter.dispose(), 'whale-soul.file-image()')
}
export default { name, inject, apply }
