import { assertMemoryProvider, createLocalMemoryProvider } from './v2/provider.js'

export const name = 'whale-memory-provider'

/** Provider lifetime is independent from any persona role or Agent. */
export function installMemoryProvider(ctx, provider = createLocalMemoryProvider()) {
  assertMemoryProvider(provider)
  const disposeService = ctx.provide('whaleMemory', provider)
  ctx.effect(() => () => { provider.dispose?.(); return disposeService() }, 'whale-memory.provider()')
  return provider
}

export function apply(ctx) { installMemoryProvider(ctx) }
export default { name, apply }
