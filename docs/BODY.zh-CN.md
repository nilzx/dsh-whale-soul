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
| `petId` | `main` | 驱动哪只 dsh-pet。 |
| `surface` | `any` | `web` / `desktop` / `both` / `any`。 |
| `maxBubbleChars` | `100` | 气泡最长字符数。 |
| `rateLimitMs` | `4000` | 主动反应的最小间隔。 |
| `minSleepMs` | `8000` | 睡眠表演最短时长。 |

## 失败时的行为

探测失败时，适配器不注册身体工具，也不向用户输出错误。记忆、人格和其他预设部分照常工作；之后的会话可以重新连接，不需要重装。

## 范围

这是单向的展示联动：灵魂可以请身体做反应，但身体不能写记忆、改人格，也不能把消息送回对话。
