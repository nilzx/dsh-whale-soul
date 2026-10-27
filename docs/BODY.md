# Optional body adapter

The preset mounts the package's `./body` entry, but the adapter is inert until a compatible local companion answers on loopback. It is not a dependency, does not import the companion, and never changes the companion's configuration.

## Current bridge

The reference bridge targets [`dsh-pet`](https://www.npmjs.com/package/dsh-pet)'s existing HTTP routes:

1. Discover the DSH local origin from `webApp`, `webServer`, or `DSH_WEB_URL`.
2. Probe `GET /dsh-pet-7340/state` and `GET /dsh-pet-7340/config` on loopback.
3. Use only the existing routes:
   - `POST /dsh-pet-7340/broadcast?pet=main&surface=any`
   - `POST /dsh-pet-7340/anim?pet=main&surface=any`
   - `POST /dsh-pet-7340/lock` / `lock/release`
   - `POST /dsh-pet-7340/bubble/clear`
4. For dream maintenance, play a short sleep sequence (`哈欠连天` → `原地小憩沉眠` → `打瞌睡被惊醒`) and release the lock.

The adapter never calls dsh-pet's `/chat` or `/whisper`; those use dsh-pet's own persona and model. If dsh-pet's own whisper is enabled, its voice may still be heard; disable it there if you want a single voice.

## Options

The body row accepts:

| Option | Default | Meaning |
|---|---:|---|
| `baseUrl` | auto | Override the dsh-pet origin. |
| `petId` | automatic | Exact dsh-pet instance to drive. An explicit missing/invalid ID disables the bridge. When omitted, prefer `main`, then the first configured instance. The bundled presets explicitly select `main`. |
| `surface` | `any` | `web`, `desktop`, `both`, or `any`. |
| `maxBubbleChars` | `100` | Maximum bubble text. |
| `rateLimitMs` | `4000` | Minimum gap between explicit reactions. |
| `minSleepMs` | `8000` | Minimum length of the sleep performance. |

## Failure behavior

If the probe fails, the adapter registers no body tools and logs nothing user-facing. The memory plugin, persona, and every other part of the preset keep working. A later session can reconnect without reinstalling.

## Scope

This is a one-way display integration. The soul can ask the body to react, but the body cannot write memories, change the persona, or send messages back into the conversation.

After acquiring a lease, the adapter includes its current `lock` query parameter on animation, bubble and bubble-clear requests. It never uses forceful takeover. A lease coordinates one instance; it does not make testing against a user's main pet harmless. Use a dedicated instance in an isolated service and explicitly configure its `petId` and `surface`.
