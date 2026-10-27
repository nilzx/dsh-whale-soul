# 可选的身体适配器

预设会挂载包的 `./body` 入口，但只有本机 loopback 上有兼容的陪伴应用应答时，适配器才会启用。它不是依赖，不导入对方，也不会修改对方的配置。

## 当前桥接

参考实现对接 [`dsh-pet`](https://www.npmjs.com/package/dsh-pet) 已有的 HTTP 路由：

1. 通过 `webApp`、`webServer` 或 `DSH_WEB_URL` 发现 DSH 本地 origin。
2. 在 loopback 上探测 `GET /dsh-pet-7340/state` 和 `GET /dsh-pet-7340/config`。
3. 只使用已有路由：
   - `POST /dsh-pet-7340/broadcast?pet=main&surface=any`
   - `POST /dsh-pet-7340/anim?pet=main&surface=any`
   - `POST /dsh-pet-7340/lock` / `lock/release`
   - `POST /dsh-pet-7340/bubble/clear`
4. 梦境维护时播放短睡眠序列（`哈欠连天` → `原地小憩沉眠` → `打瞌睡被惊醒`），结束后释放 lock。

适配器**不会**调用 dsh-pet 的 `/chat` 或 `/whisper`，因为那两处使用 dsh-pet 自己的人设和模型。如果 dsh-pet 自己的碎碎念还开着，可能会出现两个声音；想要单一声音，请在 dsh-pet 设置里关掉它的 AI。

## 配置项

body 行传入：

| 选项 | 默认 | 含义 |
|---|---:|---|
| `baseUrl` | 自动 | 覆盖 dsh-pet 的 origin。 |
| `petId` | 自动 | 显式指定时必须精确匹配；不存在或非法会停用桥接。省略时优先 `main`，否则选首个已配置实例。内置预设显式选择 `main`。 |
| `surface` | `any` | `web` / `desktop` / `both` / `any`。 |
| `maxBubbleChars` | `100` | 气泡最长字符数。 |
| `rateLimitMs` | `4000` | 主动反应的最小间隔。 |
| `minSleepMs` | `8000` | 睡眠表演最短时长。 |
| `playbackWaitMs` | `15000` | 唤醒动画的异步回执等待上限，最多 15 秒；旧宿主不返回 playbackId 时立即兼容退化。 |

## 失败时的行为

探测失败时，适配器不注册身体工具，也不向用户输出错误。记忆、人格和其他预设部分照常工作；之后的会话可以重新连接，不需要重装。

## 范围

这是单向的展示联动：灵魂可以请身体做反应，但身体不能写记忆、改人格，也不能把消息送回对话。

适配器取得占用锁后，会给动画、气泡和清空气泡请求附上当前 `lock` 查询参数，遵守 dsh-pet 的租约门禁；不使用 `force` 抢占。锁只隔离同一实例上的联动，不能把用户主宠物当作无影响的测试对象。测试应使用独立服务中的专用实例，并显式选择对应 `petId` 与 `surface`。

唤醒阶段保留租约，直到渲染端返回终态回执或达到有界超时，避免解锁回 idle 覆盖刚受理的唤醒动画。事件监听不会等待表演，因此聊天可继续；销毁会取消回执等待，再做有界释放。每次官方长轮询不超过 10 秒，总预算内最多请求三次。
