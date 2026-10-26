import { realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

const MUTATION_TOOLS = ['write', 'edit']
const EXECUTION_TOOLS = ['bash', 'pwsh', 'run_code']
const READ_TOOLS = ['read', 'read_image', 'glob', 'grep', 'web_search', 'web_fetch', 'job_output']
const MODES = new Set(['read-only', 'workspace-write', 'danger-full-access'])
const PREFIX = 'persona protection'

function error(code) {
  const value = new Error(`${PREFIX}: ${code}`)
  value.code = code
  return value
}
function denied(code) {
  return Object.freeze({ allowed: false, code, reason: `${PREFIX}: ${code}` })
}
const allowed = () => Object.freeze({ allowed: true, code: 'ALLOWED' })
function object(value) { return value !== null && typeof value === 'object' }
function names(values) {
  if (!Array.isArray(values) || values.some((name) => typeof name !== 'string' || !name.trim())) throw error('INVALID_TOOL_SET')
  return new Set(values)
}

/** Resolve existing symlinks before normalizing missing suffixes. */
export function canonicalProtectionPath(input) {
  if (typeof input !== 'string' || !isAbsolute(input) || input.includes('\0')) throw error('ABSOLUTE_PATH_REQUIRED')
  let parent = input
  const suffix = []
  while (true) {
    try { return resolve(realpathSync.native(parent), ...suffix) }
    catch (cause) {
      if (cause.code !== 'ENOENT' && cause.code !== 'ENOTDIR') throw error('CANONICAL_PATH_UNAVAILABLE')
      const next = dirname(parent)
      if (next === parent) throw error('CANONICAL_PATH_UNAVAILABLE')
      suffix.unshift(parent.slice(next.length).replace(new RegExp(`^${sep === '\\' ? '\\\\' : sep}+`), ''))
      parent = next
    }
  }
}

function contains(parent, child) {
  const rel = relative(parent, child)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}
export function protectionRootsOverlap(left, right) {
  const a = canonicalProtectionPath(left)
  const b = canonicalProtectionPath(right)
  return contains(a, b) || contains(b, a)
}

/**
 * Host-owned write protection. Resolvers must inspect actual session policy,
 * writableRoots and backend objects, never execution.arguments declarations.
 * Async preparation belongs on tools/pre-execute; guard() is the monotonic
 * synchronous dispatch check. A full provider wrap is not a successful runner
 * probe: the real executor must still fail closed if its runner cannot start.
 * This module deliberately does not provide read-scope isolation.
 * serviceTools is a trusted adapter allow-list, not a model-configurable list;
 * those definitions must implement their own structured capability checks.
 */
export class PersonaProtection {
  #protectedRoots
  #resolve
  #read
  #mutations
  #executions
  #reads
  #services
  #requireAgent
  #prepared = new Map()
  #disposed = false

  constructor({ protectedRoots, resolveHostCapabilities, readHostCapabilities,
    mutationTools = MUTATION_TOOLS, executionTools = EXECUTION_TOOLS,
    readTools = READ_TOOLS, serviceTools = [], requireAgent = true } = {}) {
    if (!Array.isArray(protectedRoots) || protectedRoots.length === 0) throw error('PROTECTED_ROOTS_REQUIRED')
    this.#protectedRoots = [...protectedRoots]
    this.#protectedRoots.forEach(canonicalProtectionPath)
    if (typeof resolveHostCapabilities !== 'function' || typeof readHostCapabilities !== 'function') {
      throw error('TRUSTED_HOST_RESOLVERS_REQUIRED')
    }
    this.#resolve = resolveHostCapabilities
    this.#read = readHostCapabilities
    this.#mutations = names(mutationTools)
    this.#executions = names(executionTools)
    this.#reads = names(readTools)
    this.#services = names(serviceTools)
    this.#requireAgent = requireAgent
    const all = [...this.#mutations, ...this.#executions, ...this.#reads, ...this.#services]
    if (new Set(all).size !== all.length) throw error('OVERLAPPING_TOOL_CLASSIFICATION')
  }

  #effect(exec) {
    if (this.#mutations.has(exec.name)) return 'mutation'
    if (this.#executions.has(exec.name)) return 'execution'
    if (this.#reads.has(exec.name)) return 'read'
    if (this.#services.has(exec.name)) return 'service'
    return 'unknown'
  }

  #request(exec, effect) {
    if (this.#disposed) return denied('DISPOSED')
    if (effect === 'unknown') return denied('UNCLASSIFIED_TOOL')
    if (effect === 'read' || effect === 'service') return allowed()
    if (this.#requireAgent && !exec.agent?.session?.id) return denied('AGENT_SESSION_REQUIRED')
    if (object(exec.arguments) && (Object.hasOwn(exec.arguments, 'sandbox_permissions') || Object.hasOwn(exec.arguments, 'enforcement'))) {
      return denied('MODEL_CAPABILITY_OVERRIDE_FORBIDDEN')
    }
    return allowed()
  }

  #normalize(exec, effect, capabilities, { requireEnforcement = false } = {}) {
    if (!object(capabilities) || typeof capabilities.then === 'function') throw error('HOST_CAPABILITY_UNAVAILABLE')
    const policy = capabilities.policy
    if (!object(policy) || !MODES.has(policy.mode)) throw error('INVALID_HOST_POLICY')
    if (policy.mode === 'danger-full-access') throw error('UNCONFINED_POLICY_FORBIDDEN')
    if (effect === 'mutation' && policy.mode === 'read-only') throw error('READ_ONLY_POLICY')
    const sessionId = exec.agent?.session?.id
    if (sessionId && policy.sessionId !== sessionId) throw error('POLICY_SESSION_MISMATCH')
    const workspace = canonicalProtectionPath(policy.workspaceRoot)
    if (!Array.isArray(capabilities.writableRoots)) throw error('WRITABLE_ROOTS_REQUIRED')
    const writable = [...new Set(capabilities.writableRoots.map(canonicalProtectionPath))].sort()
    if (policy.mode === 'workspace-write' && !writable.includes(workspace)) throw error('INCOMPLETE_WRITABLE_ROOTS')
    if (policy.mode === 'read-only' && writable.length !== 0) throw error('INVALID_READ_ONLY_ROOTS')
    const protectedRoots = this.#protectedRoots.map(canonicalProtectionPath).sort()
    for (const root of writable) for (const protectedRoot of protectedRoots) {
      if (contains(root, protectedRoot) || contains(protectedRoot, root)) throw error('PROTECTED_ROOT_WRITABLE')
    }
    if (effect === 'mutation' && (!object(capabilities.fs?.backend) || capabilities.fs.confined !== true)) {
      throw error('CONFINING_FILESYSTEM_REQUIRED')
    }
    if (effect === 'execution') {
      if (!object(capabilities.execution?.backend) || !object(capabilities.execution?.provider) || capabilities.execution.confined !== true) {
        throw error('CONFINING_EXECUTOR_REQUIRED')
      }
      if (requireEnforcement && capabilities.execution.enforcement !== 'full') throw error('FULL_ENFORCEMENT_REQUIRED')
    }
    return {
      effect, mode: policy.mode, sessionId, workspace,
      writable: JSON.stringify(writable), protectedRoots: JSON.stringify(protectedRoots),
      fsBackend: capabilities.fs?.backend,
      executionBackend: capabilities.execution?.backend,
      provider: capabilities.execution?.provider,
      enforcement: effect === 'execution' ? capabilities.execution?.enforcement : undefined,
    }
  }

  async prepare(exec) {
    const effect = this.#effect(exec)
    const request = this.#request(exec, effect)
    if (!request.allowed || effect === 'read' || effect === 'service') return request
    if (typeof exec.token !== 'symbol') return denied('EXECUTION_TOKEN_REQUIRED')
    try {
      const capabilities = await this.#resolve(exec)
      if (this.#disposed || exec.signal?.aborted) return denied('EXECUTION_CANCELLED')
      const normalized = this.#normalize(exec, effect, capabilities, { requireEnforcement: true })
      this.#prepared.set(exec.token, normalized)
      return allowed()
    } catch (cause) { return denied(cause.code || 'HOST_CAPABILITY_UNAVAILABLE') }
  }

  guard(exec) {
    const effect = this.#effect(exec)
    const request = this.#request(exec, effect)
    if (!request.allowed) return request.reason
    if (effect === 'read' || effect === 'service') return undefined
    const prepared = this.#prepared.get(exec.token)
    if (!prepared) return denied('PREPARATION_REQUIRED').reason
    try {
      const current = this.#normalize(exec, effect, this.#read(exec), { requireEnforcement: true })
      for (const key of Object.keys(prepared)) if (current[key] !== prepared[key]) return denied('HOST_POLICY_CHANGED').reason
      return undefined
    } catch (cause) { return denied(cause.code || 'HOST_CAPABILITY_UNAVAILABLE').reason }
  }

  release(exec) { this.#prepared.delete(exec.token) }
  dispose() { this.#disposed = true; this.#prepared.clear() }
}

export const createProtectionPolicy = (options) => new PersonaProtection(options)

/** Install in the role's own Cordis scope, not the management scope. */
export function installProtectionGuard(ctx, policy) {
  if (typeof ctx.on !== 'function' || typeof ctx.tools?.guard !== 'function') throw error('HOST_GUARD_API_REQUIRED')
  const disposePre = ctx.on('tools/pre-execute', async (exec, next) => {
    const result = await policy.prepare(exec)
    return result.allowed ? next() : { kind: 'deny', reason: result.reason }
  })
  const disposeGuard = ctx.tools.guard((exec) => policy.guard(exec))
  const disposeResult = ctx.on('tools/result', (exec) => { policy.release(exec) })
  return () => {
    policy.dispose()
    disposePre()
    disposeGuard()
    disposeResult()
  }
}
