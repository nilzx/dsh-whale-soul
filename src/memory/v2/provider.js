import { MemoryStoreV2 } from './store.js'
import { API_VERSION, FORMAT_VERSION, MemoryError } from './contracts.js'
import { join, resolve } from 'node:path'

export const MEMORY_PROVIDER_PROTOCOL = '1.0.0'

/** Trusted host composition port; never expose a provider in model arguments. */
export function assertMemoryProvider(provider) {
  if (!provider || provider.protocol_version !== MEMORY_PROVIDER_PROTOCOL || provider.api_version !== API_VERSION ||
    provider.format_version !== FORMAT_VERSION || typeof provider.createStore !== 'function' || typeof provider.assertAvailable !== 'function' || typeof provider.dispose !== 'function') {
    throw new MemoryError('UNSUPPORTED_MEMORY_PROVIDER')
  }
  provider.assertAvailable()
  return provider
}

/** File-backed host storage is a versioned extension of the neutral API. */
export function assertProviderStore(store, { root, memory_space_id }) {
  const methods = ['initialize', 'issueContext', 'proposeMemory', 'reviseMemory', 'queryMemory', 'managedTransaction', 'managedRead',
    '_authorize', '_readRecord', '_records', '_manifest', '_commitChanges', '_visible']
  if (!store || store.root !== resolve(root) || store.memorySpaceId !== memory_space_id || store.spaceRoot !== join(resolve(root), 'spaces', memory_space_id) ||
    typeof store.engine?.resolvePath !== 'function' || methods.some((method) => typeof store[method] !== 'function')) {
    throw new MemoryError('UNSUPPORTED_MEMORY_STORAGE_PORT')
  }
  return store
}

/** One provider may serve multiple isolated stores without owning their data. */
export function createLocalMemoryProvider() {
  let active = true
  const assertAvailable = () => { if (!active) throw new MemoryError('MEMORY_PROVIDER_UNAVAILABLE') }
  return Object.freeze({
    protocol_version: MEMORY_PROVIDER_PROTOCOL,
    api_version: API_VERSION,
    format_version: FORMAT_VERSION,
    assertAvailable,
    createStore(options) {
      assertAvailable()
      return new MemoryStoreV2({ ...options, providerGuard: assertAvailable })
    },
    dispose() { active = false },
  })
}
