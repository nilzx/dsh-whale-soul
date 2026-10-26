import { isAbsolute, join, resolve } from 'node:path'
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

/** A fixed host-generated profile; command text is never inspected. */
export function macosProtectedProfile(protectedRoots) {
  const roots = [...new Set(protectedRoots.map(canonicalProtectionPath))]
  if (!roots.length) throw fail('PROTECTED_ROOTS_REQUIRED')
  const filters = roots.map((root) => `(subpath ${quoted(root)})`).join(' ')
  return `(version 1) (allow default) (deny file-read* ${filters}) (deny file-write* ${filters})`
}

// This helper is fixed trusted code. Paths/ranges are JSON argv data, never code.
// Content opens happen in the kernel-confined child, including ancestor races.
const FS_READER = `
const fs=require('node:fs');
const a=JSON.parse(process.argv[1]);
try {
 if(a.op==='probe') {
  for(const p of a.roots) { let refused=false; try {fs.readdirSync(p)} catch(e) {if(e.code==='EPERM'||e.code==='EACCES') refused=true; else throw e} if(!refused) process.exit(73) }
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
export function createHostProtection(ctx, { protectedRoots, writableRoots,
  mutationTools = MUTATIONS, executionTools = EXECUTIONS, readTools = READS,
  localReadTools = LOCAL_READS, serviceTools = [], probeTimeoutMs = 5000,
  fsReadTimeoutMs = 10000, maxReadBytes = 64 * 1024 * 1024 } = {}) {
  if (!ctx || typeof ctx.get !== 'function' || typeof ctx.isolate !== 'function' || typeof writableRoots !== 'function') throw fail('OFFICIAL_HOST_BINDINGS_REQUIRED')
  if (!Array.isArray(protectedRoots) || !protectedRoots.length) throw fail('PROTECTED_ROOTS_REQUIRED')
  if (![probeTimeoutMs, fsReadTimeoutMs, maxReadBytes].every((n) => Number.isSafeInteger(n) && n > 0)) throw fail('INVALID_LIMIT')
  const rawRoots = [...protectedRoots]
  const roots = rawRoots.map(canonicalProtectionPath)
  const profile = macosProtectedProfile(roots)
  const denyRules = profile.slice(profile.indexOf('(deny file-read*'))
  const baseFs = ctx.get('fs'), baseSubprocess = ctx.get('subprocess'), baseSandbox = ctx.get('sandbox')
  if (!baseFs || !baseSubprocess || typeof baseSubprocess.spawn !== 'function' || typeof baseSandbox?.confine !== 'function') throw fail('HOST_SERVICES_REQUIRED')
  const capabilityContext = ctx.isolate('fs').isolate('subprocess').isolate('sandbox').isolate('shell')
  const status = { platform: process.platform, initialized: false, readIsolation: false, writeGuard: false,
    boundary: 'macos-seatbelt-layer', error: null }
  const lifetime = new AbortController(), processes = new Set(), attestations = new Map(), signedArgv = new WeakSet()
  const localReads = new Set(localReadTools), executions = new Set(executionTools)
  let disposed = false, uninstall, initPromise
  const assertRoots = () => {
    if (disposed) throw fail('DISPOSED')
    if (process.platform !== 'darwin') throw fail('READ_ISOLATION_PLATFORM_UNSUPPORTED')
    if (rawRoots.some((root, i) => canonicalProtectionPath(root) !== roots[i])) throw fail('PROTECTED_ROOT_CHANGED')
  }
  const wrap = (spec) => {
    assertRoots()
    if (!spec || !Array.isArray(spec.argv) || !spec.argv.length) throw fail('INVALID_SUBPROCESS_SPEC')
    if (signedArgv.has(spec.argv)) return spec
    return { ...spec, argv: ['/usr/bin/sandbox-exec', '-p', profile, '--', ...spec.argv] }
  }
  const sandbox = {
    async confine(argv, policy, signal) {
      assertRoots()
      const result = await baseSandbox.confine(argv, policy, signal)
      signal?.throwIfAborted()
      assertRoots()
      if (result?.enforcement !== 'full' || !Array.isArray(result.argv) || !['sandbox-exec', '/usr/bin/sandbox-exec'].includes(result.argv[0]) ||
        result.argv[1] !== '-p' || typeof result.argv[2] !== 'string' || result.argv[2].length > 262144 || result.argv[3] !== '--') {
        throw fail('SEATBELT_PROVIDER_REQUIRED')
      }
      const runner = await baseSubprocess.resolveExecutable(result.argv[0], undefined, signal)
      if (canonicalProtectionPath(runner) !== '/usr/bin/sandbox-exec') throw fail('SEATBELT_PROVIDER_REQUIRED')
      const combined = [...result.argv]
      combined[0] = '/usr/bin/sandbox-exec'
      combined[2] += ` ${denyRules}`
      Object.freeze(combined)
      signedArgv.add(combined)
      return { ...result, argv: combined }
    },
  }
  const subprocess = new Proxy({}, { get(_target, key) {
    if (key === ORIGINAL) return subprocess
    if (key === 'spawn') return (spec) => {
      const process = baseSubprocess.spawn(wrap(spec))
      processes.add(process)
      process.done.then(async () => {
        try { if (await process.waitForExit(AbortSignal.timeout(100))) processes.delete(process) } catch {}
      }, () => processes.delete(process))
      return process
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
    const handle = child(args, signal, timeout)
    const buffers = []; let size = 0
    try {
      for await (const chunk of handle.stdout) {
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
      const handle = child({ op: 'bytes', path: safePath(target), maximum: maxReadBytes }, signal)
      return (async function* () {
        const decoder = new TextDecoder('utf-8', { fatal: true }); let size = 0
        try {
          for await (const chunk of handle.stdout) {
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
    const currentFs = capabilityContext.get('fs'), shell = capabilityContext.get('shell'), provider = capabilityContext.get('sandbox')
    if (original(currentFs) !== fs || original(capabilityContext.get('subprocess')) !== subprocess || original(provider) !== sandbox ||
      original(ctx.get('sandbox')) !== original(baseSandbox) || original(ctx.get('fs')) !== original(baseFs) ||
      original(ctx.get('subprocess')) !== original(baseSubprocess)) throw fail('PROTECTED_BACKEND_REPLACED')
    const capabilities = { policy, writableRoots: writableRoots(policy), readBoundary: subprocess,
      fs: { backend: original(currentFs), confined: baseFs.sandboxMode !== undefined },
      execution: { backend: original(shell), provider: original(provider), subprocess, confined: shell?.sandboxMode !== undefined } }
    const prepared = attestations.get(exec.token)
    if (prepared && prepared.provider === capabilities.execution.provider && prepared.backend === capabilities.execution.backend &&
      prepared.policy === JSON.stringify(policy)) capabilities.execution.enforcement = prepared.enforcement
    return capabilities
  }
  const basePolicy = createProtectionPolicy({ protectedRoots: rawRoots, mutationTools, executionTools, readTools, serviceTools,
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
    get status() { return Object.freeze({ ...status }) },
    initialize() {
      if (disposed) return Promise.reject(fail('DISPOSED'))
      return initPromise ??= (async () => {
        try {
          await providerFiber.await()
          assertRoots()
          const result = await collect({ op: 'probe', roots }, undefined, 1024, probeTimeoutMs)
          if (result.toString('utf8') !== 'protected-read-denied') throw fail('READ_ISOLATION_PROBE_FAILED')
          const policy = ctx.get('sandboxPolicy')?.resolve()
          if (!policy || policy.mode === 'danger-full-access') throw fail('UNCONFINED_POLICY_FORBIDDEN')
          const combined = await sandbox.confine(['/usr/bin/true'], policy, AbortSignal.timeout(probeTimeoutMs))
          const test = subprocess.spawn({ argv: combined.argv, cwd: '/', stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } },
            graceMs: 100, signal: AbortSignal.timeout(probeTimeoutMs) })
          if ((await test.done).exitCode !== 0) throw fail('COMBINED_CONFINEMENT_PROBE_FAILED')
          status.initialized = true; status.readIsolation = true
          return Object.freeze({ ...status })
        } catch (error) { status.error = error.code || 'READ_ISOLATION_PROBE_FAILED'; throw fail(status.error) }
      })()
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
      lifetime.abort(fail('DISPOSED'))
      uninstall?.(); policy.dispose()
      for (const process of processes) process.terminate()
      await Promise.allSettled([...processes].map((process) => process.waitForExit(AbortSignal.timeout(5000))))
      await providerFiber.dispose()
    },
  }
}
