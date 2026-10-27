import { AsyncLocalStorage } from 'node:async_hooks'
import { MemoryError } from '../memory/v2/contracts.js'

const facades = new WeakMap()
const fail = () => { throw new MemoryError('SESSION_PREPARED_CALL_REQUIRED') }

/** Decorates only the public rc.3 prepareCall method and its public handle. */
export function installPreparedCallFacade(llm, isCurrent) {
  if (facades.has(llm)) return facades.get(llm)
  if (typeof llm?.prepareCall !== 'function' || !Object.isExtensible(llm) || typeof isCurrent !== 'function') fail()
  const previous = llm.prepareCall, local = new AsyncLocalStorage()
  const prepare = async function (...args) {
    if (!isCurrent()) fail()
    const handle = await Reflect.apply(previous, this, args)
    if (!isCurrent()) fail()
    if (!handle || typeof handle.stream !== 'function') fail()
    const descriptors = Object.getOwnPropertyDescriptors(handle)
    descriptors.stream = { ...descriptors.stream, value(options) {
      if (!isCurrent()) fail()
      const token = { llm, options, claimed: false }
      const iterable = local.run(token, () => handle.stream(options))
      if (!iterable || typeof iterable[Symbol.asyncIterator] !== 'function') fail()
      const iterator = local.run(token, () => iterable[Symbol.asyncIterator]())
      const scoped = (method, value) => { if (method !== 'return' && !isCurrent()) fail(); return local.run(token, () => iterator[method](value)) }
      return { [Symbol.asyncIterator]() { return this }, next(value) { return scoped('next', value) },
        ...(typeof iterator.return === 'function' ? { return(value) { return scoped('return', value) } } : {}),
        ...(typeof iterator.throw === 'function' ? { throw(value) { return scoped('throw', value) } } : {}) }
    } }
    return Object.freeze(Object.defineProperties({}, descriptors))
  }
  try { Object.defineProperty(llm, 'prepareCall', { value: prepare, writable: true, configurable: true }) } catch { fail() }
  const facade = Object.freeze({
    claim(options) {
      if (llm.prepareCall !== prepare) fail()
      const token = local.getStore()
      if (!token || token.llm !== llm || token.options !== options || token.claimed) fail()
      token.claimed = true
    },
  })
  facades.set(llm, facade); return facade
}
