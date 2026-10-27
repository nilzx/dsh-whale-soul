import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { TextDecoder } from 'node:util'
import { canonicalProtectionPath, createProtectionPolicy, installProtectionGuard, protectionRootsOverlap } from './protection.js'

const ORIGINAL = Symbol.for('cordis.original')
const original = (value) => value?.[ORIGINAL] ?? value
const LOCAL_READS = ['read', 'read_image', 'glob', 'grep']
const READS = [...LOCAL_READS, 'web_search', 'web_fetch', 'job_output']
const MUTATIONS = ['write', 'edit']
const EXECUTIONS = ['bash']
const fail = (code) => Object.assign(new Error(`persona host protection: ${code}`), { code })
const denied = (code) => ({ allowed: false, code, reason: `persona host protection: ${code}` })
const quoted = (value) => JSON.stringify(value)
const lexicalContains = (parent, child) => {
  const value = relative(resolve(parent), resolve(child))
  return value === '' || value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value)
}

/** A fixed host-generated profile; command text is never inspected. */
export function macosProtectedProfile(protectedRoots) {
  const roots = [...new Map(protectedRoots.map((value) => {
    const root = typeof value === 'string' ? { path: value, kind: 'directory' } : value
    if (!root || !['directory', 'file'].includes(root.kind)) throw fail('INVALID_PROTECTED_ROOT')
    const normalized = { path: canonicalProtectionPath(root.path), kind: root.kind }
    return [`${normalized.kind}:${normalized.path}`, normalized]
  })).values()]
  if (!roots.length) throw fail('PROTECTED_ROOTS_REQUIRED')
  const filters = roots.map((root) => `(${root.kind === 'file' ? 'literal' : 'subpath'} ${quoted(root.path)})`).join(' ')
  return `(version 1) (allow default) (deny file-read* ${filters}) (deny file-write* ${filters})`
}

// This helper is fixed trusted code. Paths/ranges are JSON argv data, never code.
// Content opens happen in the kernel-confined child, including ancestor races.
// Absent paths retain their fixed denial rule. At least one existing root must
// produce an actual permission denial so an unenforced runner cannot pass.
const FS_READER = `
const fs=require('node:fs');
const a=JSON.parse(process.argv[1]);
try {
 if(a.op==='probe') {
  let denied=0;
  for(const root of a.roots) { let refused=false; try {if(root.kind==='file'){const fd=fs.openSync(root.path,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);fs.closeSync(fd)}else fs.readdirSync(root.path)} catch(e) {if(e.code==='EPERM'||e.code==='EACCES'){refused=true;denied++}else if(e.code==='ENOENT')refused=true;else throw e} if(!refused) process.exit(73) }
  if(!denied)process.exit(73);
  process.stdout.write('protected-read-denied');
 } else if(a.op==='list') {
  process.stdout.write(JSON.stringify(fs.readdirSync(a.path,{withFileTypes:true}).map(e=>({name:e.name,type:e.isFile()?'file':e.isDirectory()?'directory':'other'}))));
 } else if(a.op==='stat') { fs.statSync(a.path); process.stdout.write('ok');
 } else {
  const fd=fs.openSync(a.path,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  const st=fs.fstatSync(fd); if(!st.isFile()) throw Object.assign(new Error(),{code:'NOT_REGULAR'});
  if(a.op==='bytes'&&st.size>a.maximum) throw Object.assign(new Error(),{code:'TOO_LARGE'});
  const start=a.op==='range'?a.offset:0; const end=a.op==='range'?a.offset+a.length:st.size;
  const b=Buffer.alloc(Math.min(65536,Math.max(1,end-start))); let pos=start;
  while(pos<end) {const n=fs.readSync(fd,b,0,Math.min(b.length,end-pos),pos);if(!n)break;fs.writeSync(1,b.subarray(0,n));pos+=n}
  fs.closeSync(fd);
 }
} catch(e) {process.stderr.write(['EPERM','EACCES','ENOENT','ENOTDIR','TOO_LARGE','NOT_REGULAR','ELOOP'].includes(e.code)?e.code:'READ_FAILED');process.exitCode=74}
`

/**
 * Create a role-local execution world before mounting its fs/bash/search tools.
 * `writableRoots` MUST be the official dsh-sandbox export supplied by the host.
 * The returned context isolates fs, subprocess, sandbox and shell. Mount the official
 * dsh-bash-sandbox and all generic tools on capabilityContext, not the old ctx.
 * The ordinary official sandbox provider remains responsible for write policy;
 * its exact Seatbelt profile is retained with additional read/write denials.
 * macOS refuses nested sandbox_apply, so the trusted provider appends fixed
 * denial rules to that profile without removing or interpreting its rules.
 * No model parameters, shell parsing, token credentials or global monkeypatches
 * participate. macOS is the only implemented platform; others fail closed.
 */
export function createHostProtection(ctx, { protectedRoots, resolvePrivateRoots, writableRoots,
  mutationTools = MUTATIONS, executionTools = EXECUTIONS, readTools = READS,
  localReadTools = LOCAL_READS, serviceTools = [], probeTimeoutMs = 5000,
  fsReadTimeoutMs = 10000, maxReadBytes = 64 * 1024 * 1024 } = {}) {
  if (!ctx || typeof ctx.get !== 'function' || typeof ctx.isolate !== 'function' || typeof writableRoots !== 'function') throw fail('OFFICIAL_HOST_BINDINGS_REQUIRED')
  if (!Array.isArray(protectedRoots) || !protectedRoots.length) throw fail('PROTECTED_ROOTS_REQUIRED')
  if (![probeTimeoutMs, fsReadTimeoutMs, maxReadBytes].every((n) => Number.isSafeInteger(n) && n > 0)) throw fail('INVALID_LIMIT')
  if (resolvePrivateRoots !== undefined && typeof resolvePrivateRoots !== 'function') throw fail('TRUSTED_PRIVATE_ROOT_RESOLVER_REQUIRED')
  const staticRoots = protectedRoots.map((path) => ({ path, kind: 'directory' }))
  const privateHistory = new Map()
  let rootSpecs = staticRoots, roots = rootSpecs.map((root) => canonicalProtectionPath(root.path)), profile, denyRules, privateSnapshot
  const baseFs = ctx.get('fs'), baseSubprocess = ctx.get('subprocess'), baseSandbox = ctx.get('sandbox')
  if (!baseFs || !baseSubprocess || typeof baseSubprocess.spawn !== 'function' || typeof baseSandbox?.confine !== 'function') throw fail('HOST_SERVICES_REQUIRED')
  const capabilityContext = ctx.isolate('fs').isolate('subprocess').isolate('sandbox').isolate('shell')
  const status = { platform: process.platform, initialized: false, readIsolation: false, writeGuard: false,
    boundary: 'macos-seatbelt-layer', error: null, initializationAttempts: 0 }
  const lifetime = new AbortController(), processes = new Set(), attestations = new Map(), signedArgv = new WeakMap()
  const localReads = new Set(localReadTools), executions = new Set(executionTools)
  let disposed = false, uninstall, initPromise, unsubscribe, generation = 0, probing = false, initializing = false, hasBeenReady = false
  const invalidate = () => {
    generation++; status.initialized = false; status.readIsolation = false; status.error = 'HOST_PRIVATE_ROOTS_CHANGED'
    if (!initializing) initPromise = undefined
    attestations.clear()
    for (const process of processes) process.terminate()
  }
  const configureRoots = () => {
    privateSnapshot = resolvePrivateRoots?.()
    if (resolvePrivateRoots && (!Array.isArray(privateSnapshot?.roots) || typeof privateSnapshot?.isCurrent !== 'function' || !privateSnapshot.isCurrent())) throw fail('PRIVATE_ROOT_SNAPSHOT_REQUIRED')
    for (const root of privateSnapshot?.roots ?? []) privateHistory.set(`${root.kind}:${root.path}:${root.anchor ?? ''}`, root)
    // Old private files remain private after a provider moves; revalidation
    // adds the new location without exposing the old on-disk data.
    rootSpecs = [...staticRoots, ...privateHistory.values()]
    roots = rootSpecs.map((root) => canonicalProtectionPath(root.path))
    profile = macosProtectedProfile(rootSpecs)
    denyRules = profile.slice(profile.indexOf('(deny file-read*'))
  }
  configureRoots()
  const assertRoots = () => {
    if (disposed) throw fail('DISPOSED')
    if (process.platform !== 'darwin') throw fail('READ_ISOLATION_PLATFORM_UNSUPPORTED')
    if (privateSnapshot && !privateSnapshot.isCurrent()) { invalidate(); throw fail('HOST_PRIVATE_ROOTS_CHANGED') }
    if (rootSpecs.some((root, i) => canonicalProtectionPath(root.path) !== roots[i])) { invalidate(); throw fail('PROTECTED_ROOT_CHANGED') }
  }
  const wrap = (spec) => {
    assertRoots()
    if (!probing && !status.initialized) throw fail(status.error || 'READ_ISOLATION_NOT_INITIALIZED')
    if (!spec || !Array.isArray(spec.argv) || !spec.argv.length) throw fail('INVALID_SUBPROCESS_SPEC')
    if (signedArgv.has(spec.argv)) {
      if (signedArgv.get(spec.argv) !== generation) throw fail('HOST_PRIVATE_ROOTS_CHANGED')
      return spec
    }
    return { ...spec, argv: ['/usr/bin/sandbox-exec', '-p', profile, '--', ...spec.argv] }
  }
  const sandbox = {
    async confine(argv, policy, signal) {
      assertRoots()
      const started = generation
      const result = await baseSandbox.confine(argv, policy, signal)
      signal?.throwIfAborted()
      assertRoots()
      if (started !== generation) throw fail('HOST_PRIVATE_ROOTS_CHANGED')
      if (result?.enforcement !== 'full' || !Array.isArray(result.argv) || !['sandbox-exec', '/usr/bin/sandbox-exec'].includes(result.argv[0]) ||
        result.argv[1] !== '-p' || typeof result.argv[2] !== 'string' || result.argv[2].length > 262144 || result.argv[3] !== '--') {
        throw fail('SEATBELT_PROVIDER_REQUIRED')
      }
      const runner = await baseSubprocess.resolveExecutable(result.argv[0], undefined, signal)
      signal?.throwIfAborted(); assertRoots()
      if (started !== generation) throw fail('HOST_PRIVATE_ROOTS_CHANGED')
      if (canonicalProtectionPath(runner) !== '/usr/bin/sandbox-exec') throw fail('SEATBELT_PROVIDER_REQUIRED')
      const combined = [...result.argv]
      combined[0] = '/usr/bin/sandbox-exec'
      combined[2] += ` ${denyRules}`
      Object.freeze(combined)
      signedArgv.set(combined, generation)
      return { ...result, argv: combined }
    },
  }
  const subprocess = new Proxy({}, { get(_target, key) {
    if (key === ORIGINAL) return subprocess
    if (key === 'spawn') return (spec) => {
      const started = generation
      const process = baseSubprocess.spawn(wrap(spec))
      processes.add(process)
      process.done.then(async () => {
        try { if (await process.waitForExit(AbortSignal.timeout(100))) processes.delete(process) } catch {}
      }, () => processes.delete(process))
      const check = () => { assertRoots(); if (started !== generation) throw fail('HOST_PRIVATE_ROOTS_CHANGED') }
      const streams = new Map(), rings = new Map()
      const done = process.done.then((outcome) => { check(); return outcome })
      // Attach a rejection consumer even if a caller only reads a stream.
      done.catch(() => {})
      return new Proxy(process, { get(target, property) {
        if (property === 'done') return done
        if (property === 'stdout' || property === 'stderr') {
          const stream = target[property]
          if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') return stream
          if (!streams.has(property)) streams.set(property, (async function* () { for await (const chunk of stream) { check(); yield chunk } })())
          return streams.get(property)
        }
        if (property === 'collected') return new Proxy(target.collected, { get(collected, name) {
          const ring = collected[name]
          if (!ring || typeof ring.readFrom !== 'function') return ring
          if (!rings.has(name)) rings.set(name, new Proxy(ring, { get(value, key) {
            if (key === 'readFrom') return (...args) => { check(); return value.readFrom(...args) }
            const member = value[key]; return typeof member === 'function' ? member.bind(value) : member
          } }))
          return rings.get(name)
        } })
        const value = target[property]; return typeof value === 'function' ? value.bind(target) : value
      } })
    }
    if (key === 'spawnTerminal') return async (spec) => {
      // No terminal tool is classified by default. A future terminal adapter
      // must additionally preserve that consumer's original write confinement.
      throw fail('TERMINAL_ADAPTER_NOT_IMPLEMENTED')
    }
    const value = baseSubprocess[key]
    return typeof value === 'function' ? value.bind(baseSubprocess) : value
  } })
  const safePath = (target) => {
    assertRoots()
    if (!probing && !status.initialized) throw fail(status.error || 'READ_ISOLATION_NOT_INITIALIZED')
    const path = baseFs.processPath(target)
    if (!isAbsolute(path) || baseFs.processPathFromHostPath?.(path) !== resolve(path)) throw fail('LOCAL_FILESYSTEM_REQUIRED')
    const canonical = canonicalProtectionPath(path)
    if (roots.some((root) => protectionRootsOverlap(root, canonical))) {
      // Ancestors cannot be enumerated: that would reveal protected entries.
      throw fail('PROTECTED_READ_DENIED')
    }
    return canonical
  }
  const child = (args, signal, timeout = fsReadTimeoutMs) => {
    assertRoots()
    const signals = [lifetime.signal, AbortSignal.timeout(timeout), ...(signal ? [signal] : [])]
    const joinedSignal = AbortSignal.any(signals)
    joinedSignal.throwIfAborted()
    return subprocess.spawn({ argv: [process.execPath, '-e', FS_READER, JSON.stringify(args)], cwd: '/',
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: { maxBytes: 1024 } }, graceMs: 100,
      signal: joinedSignal, env: { NODE_OPTIONS: undefined } })
  }
  const collect = async (args, signal, maximum = maxReadBytes, timeout) => {
    const started = generation
    const handle = child(args, signal, timeout)
    const buffers = []; let size = 0
    try {
      for await (const chunk of handle.stdout) {
        if (started !== generation) throw fail('HOST_PRIVATE_ROOTS_CHANGED')
        size += chunk.length
        if (size > maximum) throw fail('FS_TOO_LARGE')
        buffers.push(chunk)
      }
      const outcome = await handle.done
      if (outcome.exitCode !== 0) {
        const code = handle.collected.stderr?.readFrom(0).text
        throw fail(code === 'ENOENT' ? 'FS_NOT_FOUND' : code === 'TOO_LARGE' ? 'FS_TOO_LARGE' : 'PROTECTED_READ_FAILED')
      }
      signal?.throwIfAborted(); lifetime.signal.throwIfAborted()
      assertRoots()
      if (started !== generation) throw fail('HOST_PRIVATE_ROOTS_CHANGED')
      return Buffer.concat(buffers)
    } catch (error) { handle.terminate(); throw error }
  }
  const decode = (bytes) => {
    let text
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { throw fail('FS_NOT_TEXT') }
    if (text.includes('\0')) throw fail('FS_NOT_TEXT')
    return text
  }
  const fs = new Proxy({}, { get(_target, key) {
    if (key === ORIGINAL) return fs
    if (key === 'readText') return async (target, signal) => decode(await collect({ op: 'bytes', path: safePath(target), maximum: maxReadBytes }, signal))
    if (key === 'readBytes') return async (target, signal, maximum) => {
      if (!Number.isSafeInteger(maximum) || maximum < 0 || maximum > maxReadBytes) throw fail('FS_TOO_LARGE')
      return collect({ op: 'bytes', path: safePath(target), maximum }, signal, maximum)
    }
    if (key === 'readByteRange') return async (target, range, signal) => {
      if (![range?.offset, range?.length].every((n) => Number.isSafeInteger(n) && n >= 0) || range.length > maxReadBytes) throw fail('FS_TOO_LARGE')
      return collect({ op: 'range', path: safePath(target), ...range }, signal, range.length)
    }
    if (key === 'streamText') return async (target, signal) => {
      const started = generation
      const handle = child({ op: 'bytes', path: safePath(target), maximum: maxReadBytes }, signal)
      return (async function* () {
        const decoder = new TextDecoder('utf-8', { fatal: true }); let size = 0
        try {
          for await (const chunk of handle.stdout) {
            assertRoots(); if (started !== generation) throw fail('HOST_PRIVATE_ROOTS_CHANGED')
            size += chunk.length
            if (size > maxReadBytes) throw fail('FS_TOO_LARGE')
            const text = decoder.decode(chunk, { stream: true })
            if (text.includes('\0')) throw fail('FS_NOT_TEXT')
            if (text) yield text
          }
          const outcome = await handle.done
          if (outcome.exitCode !== 0) throw fail('PROTECTED_READ_FAILED')
          const tail = decoder.decode(); if (tail) yield tail
          signal?.throwIfAborted(); lifetime.signal.throwIfAborted()
        } finally { handle.terminate() }
      })()
    }
    if (key === 'stat') return async (target, signal) => {
      const path = safePath(target)
      try { await collect({ op: 'stat', path }, signal, 1024) }
      catch (error) { if (error.code === 'FS_NOT_FOUND') return undefined; throw error }
      safePath(target)
      return baseFs.stat(target, signal)
    }
    if (key === 'listDir') return async (target, signal) => {
      const path = safePath(target)
      const entries = JSON.parse((await collect({ op: 'list', path }, signal)).toString('utf8'))
      const result = []
      for (const entry of entries) {
        const childTarget = await baseFs.resolve(join(path, entry.name), { signal })
        try { safePath(childTarget) } catch { continue }
        result.push({ name: entry.name, type: entry.type, target: childTarget })
      }
      return result
    }
    if (['writeText', 'editText', 'watch'].includes(key)) return (target, ...args) => { safePath(target); return baseFs[key](target, ...args) }
    if (key === 'lstat') return async (path, options, signal) => {
      const target = await baseFs.resolve(path, { ...options, signal })
      safePath(target)
      return baseFs.lstat(path, options, signal)
    }
    const value = baseFs[key]
    return typeof value === 'function' ? value.bind(baseFs) : value
  } })
  // A dedicated active provider fiber owns the isolated labels. Providing on
  // a still-loading parent's fiber would notify the parent's service labels
  // and leave child fs/bash/search consumers waiting indefinitely.
  const providerFiber = capabilityContext.plugin((child) => {
    child.provide('fs', fs)
    child.provide('subprocess', subprocess)
    child.provide('sandbox', sandbox)
  })
  const readCapabilities = (exec) => {
    assertRoots()
    const service = capabilityContext.get('sandboxPolicy')
    if (typeof service?.resolve !== 'function') throw fail('SANDBOX_POLICY_REQUIRED')
    const policy = service.resolve({ session: exec.agent?.session })
    const writable = writableRoots(policy)
    // A writable symlink entry could redirect the trusted provider to a new
    // location even while its old canonical target remains protected.
    for (const root of rootSpecs) if (root.anchor && root.anchor !== root.path) {
      if (writable.some((path) => lexicalContains(path, root.anchor) || lexicalContains(root.anchor, path))) throw fail('PROTECTED_ALIAS_WRITABLE')
    }
    const currentFs = capabilityContext.get('fs'), shell = capabilityContext.get('shell'), provider = capabilityContext.get('sandbox')
    if (original(currentFs) !== fs || original(capabilityContext.get('subprocess')) !== subprocess || original(provider) !== sandbox ||
      original(ctx.get('sandbox')) !== original(baseSandbox) || original(ctx.get('fs')) !== original(baseFs) ||
      original(ctx.get('subprocess')) !== original(baseSubprocess)) throw fail('PROTECTED_BACKEND_REPLACED')
    const capabilities = { policy, writableRoots: writable, readBoundary: subprocess,
      fs: { backend: original(currentFs), confined: baseFs.sandboxMode !== undefined },
      execution: { backend: original(shell), provider: original(provider), subprocess, confined: shell?.sandboxMode !== undefined } }
    const prepared = attestations.get(exec.token)
    if (prepared && prepared.provider === capabilities.execution.provider && prepared.backend === capabilities.execution.backend &&
      prepared.policy === JSON.stringify(policy)) capabilities.execution.enforcement = prepared.enforcement
    return capabilities
  }
  const makePolicy = () => createProtectionPolicy({ protectedRoots: roots, mutationTools, executionTools, readTools, serviceTools,
    readHostCapabilities: readCapabilities,
    resolveHostCapabilities: async (exec) => {
      const capabilities = readCapabilities(exec)
      if (executions.has(exec.name) && capabilities.policy.mode !== 'danger-full-access') {
        const prepared = await capabilities.execution.provider?.confine(['/usr/bin/true'], capabilities.policy, exec.signal)
        capabilities.execution.enforcement = prepared?.enforcement
        attestations.set(exec.token, { provider: capabilities.execution.provider, backend: capabilities.execution.backend,
          policy: JSON.stringify(capabilities.policy), enforcement: prepared?.enforcement })
      }
      return capabilities
    } })
  let basePolicy = makePolicy()
  const check = (exec) => {
    try {
      assertRoots()
      if (!status.initialized || !status.readIsolation) throw fail('READ_ISOLATION_NOT_INITIALIZED')
      if ((localReads.has(exec.name) || executions.has(exec.name)) && !exec.agent?.session?.id) throw fail('AGENT_SESSION_REQUIRED')
      if (localReads.has(exec.name) || executions.has(exec.name)) {
        const capabilities = readCapabilities(exec)
        if (capabilities.policy.sessionId !== exec.agent.session.id) throw fail('POLICY_SESSION_MISMATCH')
        if (capabilities.policy.mode === 'danger-full-access') throw fail('UNCONFINED_POLICY_FORBIDDEN')
      }
      return null
    } catch (error) { return denied(error.code || 'HOST_CAPABILITY_UNAVAILABLE') }
  }
  const policy = {
    async prepare(exec) { return check(exec) ?? basePolicy.prepare(exec) },
    guard(exec) { return check(exec)?.reason ?? basePolicy.guard(exec) },
    release(exec) { attestations.delete(exec.token); basePolicy.release(exec) },
    dispose() { basePolicy.dispose(); attestations.clear() },
  }
  return {
    capabilityContext, policy,
    get status() { if (privateSnapshot && !privateSnapshot.isCurrent()) invalidate(); return Object.freeze({ ...status }) },
    initialize() {
      if (disposed) return Promise.reject(fail('DISPOSED'))
      if (initializing) return initPromise
      if (privateSnapshot && !privateSnapshot.isCurrent()) invalidate()
      if (initPromise) return initPromise
      initializing = true
      const deadline = performance.now() + 10000
      const budget = AbortSignal.timeout(10000)
      // Publish the shared promise before awaiting any provider or probe.
      return initPromise = Promise.resolve().then(async () => {
        // Profile services activate concurrently. Before the first ready state
        // only, a changed trusted snapshot may restart the complete probes.
        // Three attempts share one ten-second budget, not ten seconds each.
        const attemptLimit = hasBeenReady ? 1 : 3
        const budgeted = (promise) => new Promise((resolve, reject) => {
          const abort = () => reject(fail('READ_ISOLATION_PROBE_TIMEOUT'))
          if (budget.aborted) { abort(); Promise.resolve(promise).catch(() => {}); return }
          budget.addEventListener('abort', abort, { once: true })
          Promise.resolve(promise).then((value) => { budget.removeEventListener('abort', abort); resolve(value) },
            (error) => { budget.removeEventListener('abort', abort); reject(error) })
        })
        status.initializationAttempts = 0
        try {
          await budgeted(providerFiber.await())
          for (let attempt = 1; attempt <= attemptLimit; attempt++) {
            status.initializationAttempts = attempt
            try {
              if (budget.aborted || performance.now() >= deadline) throw fail('READ_ISOLATION_PROBE_TIMEOUT')
              configureRoots()
              basePolicy.dispose(); basePolicy = makePolicy()
              if (!unsubscribe && typeof resolvePrivateRoots?.subscribe === 'function') unsubscribe = resolvePrivateRoots.subscribe(invalidate, () => privateSnapshot?.isCurrent() === true)
              const started = generation
              probing = true
              assertRoots()
              const result = await budgeted(collect({ op: 'probe', roots: rootSpecs }, budget, 1024, probeTimeoutMs))
              if (result.toString('utf8') !== 'protected-read-denied') throw fail('READ_ISOLATION_PROBE_FAILED')
              const policy = ctx.get('sandboxPolicy')?.resolve()
              if (!policy || policy.mode === 'danger-full-access') throw fail('UNCONFINED_POLICY_FORBIDDEN')
              const step = AbortSignal.any([budget, AbortSignal.timeout(probeTimeoutMs)])
              const combined = await budgeted(sandbox.confine(['/usr/bin/true'], policy, step))
              const test = subprocess.spawn({ argv: combined.argv, cwd: '/', stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } }, graceMs: 100, signal: step })
              if ((await budgeted(test.done)).exitCode !== 0) throw fail('COMBINED_CONFINEMENT_PROBE_FAILED')
              assertRoots(); if (started !== generation) throw fail('HOST_PRIVATE_ROOTS_CHANGED')
              if (budget.aborted || performance.now() >= deadline) throw fail('READ_ISOLATION_PROBE_TIMEOUT')
              status.initialized = true; status.readIsolation = true; status.error = null; hasBeenReady = true
              return Object.freeze({ ...status })
            } catch (error) {
              if (error.code !== 'HOST_PRIVATE_ROOTS_CHANGED' || attempt === attemptLimit || budget.aborted || disposed) throw error
              status.initialized = false; status.readIsolation = false
              for (const process of processes) process.terminate()
            } finally { probing = false }
          }
        } catch (error) {
          status.initialized = false; status.readIsolation = false; status.error = error.code || 'READ_ISOLATION_PROBE_FAILED'
          for (const process of processes) process.terminate()
          throw fail(status.error)
        }
        finally { probing = false; initializing = false; if (!status.initialized) initPromise = undefined }
      })
    },
    install() {
      if (disposed) throw fail('DISPOSED')
      if (!uninstall) uninstall = installProtectionGuard(capabilityContext, policy)
      status.writeGuard = true
      return () => this.dispose()
    },
    async dispose() {
      if (disposed) return
      disposed = true; status.initialized = false; status.readIsolation = false; status.writeGuard = false
      unsubscribe?.()
      lifetime.abort(fail('DISPOSED'))
      uninstall?.(); policy.dispose()
      for (const process of processes) process.terminate()
      await Promise.allSettled([...processes].map((process) => process.waitForExit(AbortSignal.timeout(5000))))
      await providerFiber.dispose()
    },
  }
}
