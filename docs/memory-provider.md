# Memory provider composition

The bundle installs `dsh-whale-soul/memory-provider` once at host level. Both persona presets consume the `whaleMemory` service. Removing a persona role leaves the provider and data intact. Removing the provider revokes all stores it issued; reads and new commits then fail with `MEMORY_PROVIDER_UNAVAILABLE`. Revocation does not delete memory files.

The trusted host port is versioned independently as `MEMORY_PROVIDER_PROTOCOL = 1.0.0`. A provider declares the exact neutral API and format versions and implements `createStore(options)`, `assertAvailable()`, and `dispose()`. The current port is file based: it includes the documented V2 directory layout and host transaction/authorization methods. It is not a remote database protocol. A replacement must preserve context authenticity, atomic commits, evidence bindings, final authorization, and revocation checks. Merely returning the required method names is not a security audit.

`createStore` is synchronous and returns an uninitialized store for the requested absolute root and memory space. Persona composition checks those bindings before initializing state. Root, context, callbacks, and the provider itself are trusted host inputs; model tools cannot choose a provider or construct host contexts. The default local provider does not share records across its stores beyond the normal visibility rules.

`PersonaRuntime({memoryProvider})`, exported from `dsh-whale-soul/persona`, supports explicit composition for tests and embedders. A direct standalone runtime creates a local provider when none is supplied. The installed persona plugin requires the host service and refuses when it is missing or incompatible; it does not silently create a replacement service or claim that unavailable memory has been saved. A global provider can be replaced through the host plugin configuration, which must recreate dependent persona roles.

Provider withdrawal is checked before initialization, when issuing contexts, on every authorization, and again at the existing transaction COMMIT authorization point. A committed operation still follows the existing durable recovery rules. This port does not add a new source of memory authority, alter the data schema, or turn imported prose into trusted persona evidence.

The package remains a single distribution. A split-package installation is a separate acceptance exercise; the presence of this port alone does not establish that two separately installed packages are compatible.

中文说明见 [memory-provider.zh-CN.md](memory-provider.zh-CN.md)。
