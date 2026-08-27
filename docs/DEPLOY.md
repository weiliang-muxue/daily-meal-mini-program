# 云开发部署与发布

## 安全边界

仓库和小程序前端不保存任何秘密。真实 AI Key 只由仓库所有者本人在云函数环境变量界面填写，不发给支持人员，也不提交 Git。AppID、云环境 ID、AI URL 和模型名不是秘密，但本机项目配置仍不提交。

- `project.config.json`：在本机填写真实 AppID。
- `miniprogram/config.js`：在本机填写真实云开发环境 ID。
- `cloudfunctions/aiPlanner/.env.example`：仅列出 AI Key 占位符和可选迁移参数，不是可部署配置。
- AppSecret 不进入小程序、云函数代码或仓库。微信云开发通过可信调用上下文提供用户身份。

提交或推送前运行：

```powershell
node scripts/validate.js
node scripts/check-staged-safety.js
```

## 首次初始化

1. 在微信开发者工具导入 `E:\CodeXWork\饮食小程序`，使用已注册小程序的管理员或开发者微信登录。
2. 开通一个云开发环境，并仅在本机配置环境 ID。
3. 创建集合：`meal_users`、`meal_user_states`、`meal_avatar_uploads`、`meal_members`、`meal_invites`、`health_daily`、`health_photo_uploads`、`meal_ai_tasks`、`meal_ai_shards`、`meal_ai_controls`。
4. 把 `database.rules.json` 配置到数据库安全规则，确认十个集合的客户端 `read`、`write` 都为 `false`。
5. 把 `storage.rules.json` 配置到云存储，并确认根规则为客户端 `read: false`、`write: false`。头像和健康照片由小程序使用微信 `wx.cloud.CDN` 临时传给已经校验有效成员身份的业务云函数；只有云函数可以校验并写入私有永久目录，客户端没有任何云存储直写或直读权限。规则修改通常需要 1–3 分钟生效，生效前不要开放测试账号。
6. 按 `database.indexes.json` 手工创建八个复合索引：`health_daily(owner, month, date)`、`health_daily(owner, date)`、`meal_invites(codeHash, active)`、`meal_members(memberRef, status)`、`meal_ai_tasks(owner, status, createdAt desc)`、`meal_ai_tasks(status, expiresAt)`、`meal_ai_shards(owner, taskId)`、`meal_ai_tasks(shardCleanupPending, shardCleanupUpdatedAtMs)`。
7. 为 `membership` 云函数设置非秘密配置 `INVITE_SLOTS=6`、`INVITE_TTL_HOURS=24`。它们分别表示管理员之外的 6 个受邀名额，以及一次性邀请码创建后 24 小时过期。
8. 按顺序部署 `membership`、`auth`、`userData`、`health`、`privacy`，均选择云端安装依赖。先不要部署 `mealAiMaintenance`，待第 6 步索引全部显示可用并完成 AI 云函数配置后再启用其定时触发器。
9. 在小程序尚未发布、成员库与邀请码库都为空时，临时部署 `ownerBootstrapOnce`。不要把 `SOURCE=wx_devtools` 当作管理员授权：官方只将 `SOURCE` 定义为调用链来源，它不能证明操作者是项目所有者。按以下两阶段流程初始化，不需要部署口令或其他密钥：

   1. 目标管理员使用自己的微信登录开发者工具，在调试器 Console 执行 `wx.cloud.callFunction({ name: 'ownerBootstrapOnce', data: { action: 'request' } }).then(console.log)`。确认返回 `success: true`、`data.state: "pending"` 且尚未过期。此操作只创建待批准请求，不授予任何权限；公开响应不包含目标身份、请求编号或批准摘要。
   2. `request` 先在事务外只读确认成员库和邀请码库为空，随后在一个只使用固定文档 `doc()` 的事务中同时创建 `meal_members/__membership_control_v1__` 哨兵和固定请求文档。哨兵进入 `bootstrap_pending`，并绑定内部请求编号。微信云数据库事务不支持 `where`、`limit` 等批量查询，因此事务本身不依赖这些 API；空库审计和事务之间可能出现的合法写入都必须先读写同一个 control 文档，文档版本冲突保证哨兵创建与正式写入只能有一个提交。
   3. 部署者本人在云函数控制台对 `ownerBootstrapOnce` 执行云端测试，事件只填 `{"action":"approve"}`。只有返回 `success: true` 且 `data.state` 为 `approved` 才继续。批准事务只读取固定 control、请求和目标成员文档，验证请求仍为 `pending`、未过期且与哨兵绑定，再把哨兵推进到 `bootstrap_approved` 并增加 `revision`。不要手工编辑数据库文档，也不要临时开放数据库规则。
   4. 仍在云函数控制台执行第二次云端测试，事件只填 `{"action":"activate"}`，无需也不得从外部传入请求编号。激活事务只读取同一组固定文档，验证批准摘要、目标身份、control phase、请求绑定和 revision，再原子创建唯一 owner、把 control 切换为 `active` 并删除请求记录。不要从开发者工具、小程序或跨账号终端调用 `approve` 或 `activate`：上下文带 `OPENID`/`UNIONID`/`FROM_OPENID`/`FROM_UNIONID` 时都会被明确拒绝。
   5. 只有返回 `success: true` 且 `data.state` 为 `initialized` 才算成功。`membership` 和 `privacy` 中所有成员或邀请码新增、更新、撤销及删除路径，都必须在同一事务读取并更新该 control；`bootstrap_pending` 或 `bootstrap_approved` 期间一律拒绝正式写入。并发请求、批准、激活或业务写入依赖固定 control 文档的版本冲突串行化。随后立即从云端删除 `ownerBootstrapOnce`，并确认正式环境中已无法调用它。

   请求文档内的 `targetOpenid`、随机请求编号和批准摘要仅用于两次云端事务，不返回小程序界面。客户端可以在临时函数存在时发起无权限的 `request`，但不能批准记录，也不能通过事件字段把自己或指定身份提升为 owner。若目标不确定或请求已过期，先停止测试并按失败状态排查，不要猜测或手工改写 `targetOpenid`。数据库规则保持客户端完全拒绝；拥有云环境管理权限的人仍可从云控制台直接改写数据，这类平台管理员操作不在程序事务能够防止的范围内，应通过最小权限和云审计日志管控。
10. 重新编译后，管理员应直接进入小程序，再在“我的”页面生成成员邀请码。验证第 7 位受邀用户会被拒绝、邀请码使用一次后立即失效，并验证未使用邀请码在创建 24 小时后失效。普通成员必须无法创建邀请或管理成员。

## AI 云函数配置

正式服务地址（`https://gptpro.live/v1/responses`）、模型、Responses 协议和非秘密兼容请求头已经版本化在 `provider-config.js`。先部署其他业务闭环，再由部署者本人在 `aiPlanner` 云函数的环境变量界面只填写：

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `AI_API_KEY` | 是 | AI 服务凭据；绝不进入代码、日志或 Git |

正常发布不需要再填写 AI URL、模型名或推理强度；仓库默认为 `gpt-5.6`、Responses 协议和 `xhigh`。只有以后迁移服务商时，才使用以下可选覆盖项：

| 变量 | 说明 |
| --- | --- |
| `AI_API_ENDPOINT` / `AI_BASE_URL` | 完整 HTTPS Endpoint 或服务根地址，必须二选一 |
| `AI_MODEL` / `AI_API_STYLE` | 新服务商的模型名与 `responses` / `chat-completions` 协议 |
| `AI_REASONING_EFFORT` | 仅 Responses 可用 |
| `AI_PROVIDER_HEADER_NAME` / `AI_PROVIDER_HEADER_VALUE` | 可选的供应商 `x-*` 请求头；若值是凭据，只能放云函数环境变量 |
| `AI_TIMEOUT_MS` | 否 | 非秘密超时参数，默认使用示例值 |
| `AI_MAX_TOKENS` | 否 | 非秘密输出上限，默认使用示例值 |
| `AI_TEMPERATURE` | 否 | 默认不发送；仅当所选模型明确支持时再设置 0 至 2 |

覆盖时 `AI_API_ENDPOINT` 与 `AI_BASE_URL` 必须且只能填写一个。旧部署的 `AI_API_URL` 仍可作为“完整请求地址”兼容读取，但新部署不要再使用。配置完成后部署 `aiPlanner`，选择云端安装依赖。不要把控制台中的真实值复制到 `.env.example`、聊天、截图、提交记录或发布说明。

随后部署不需要任何环境变量或密钥的 `mealAiMaintenance`，选择云端安装依赖。其 `config.json` 配置 `mealAiRetentionSweep` 每 30 分钟运行一次；微信云开发七段 cron 使用 UTC+8。部署后在云函数触发器页面确认 timer 已创建，并确认函数只接受 `getWXContext().SOURCE === 'wx_trigger'`。这里的 `SOURCE` 只用于验证平台定时触发类型，不代表操作者权限。微信可能重复投递同一次定时消息，函数已按幂等方式设计。首次验证只查看返回/日志中的计数和错误代码，不要加入打印任务文档的临时日志；若有失败，保留函数等待下次重试并按错误代码排查索引或数据库状态。

八个云函数的 `wx-server-sdk` 均固定为 `4.0.2`，并提交各自的 lockfile v3。部署时使用仓库中的 `package.json` 和 `package-lock.json` 云端安装依赖；不要删除锁文件、改回 `latest`，也不要提交 `node_modules`。升级 SDK 时应单独修改明确版本、重新生成全部八个锁文件并跑完整验证，不能让正式部署随 npm 标签漂移。

部署者可在本机进程环境临时只设置 `AI_API_KEY` 后运行 `node scripts/test-ai-provider-live.js`。该脚本只发送仓库内固定的虚构选择，输出仅包含契约是否通过及数量摘要，不读取用户数据库，不保存模型原文，也不会打印 URL、Key 或模型名；不要在命令参数中直接拼接 Key。

AI 请求只从云函数发出。前端仅提交用户主动选择的餐次、7/14 天、饮食目标、忌口、健康约束和逐日运动安排；AI 返回内容必须通过云函数的契约、结构化食材、长度、数量和健康安全校验后，才能保存为 `draftPlan`。

生成器 v4 会按分片索引顺序生成详情，并把已完成分片的餐名作为后续分片禁用清单。上游返回与前序餐名语义相同的结果时，当前分片按任务尝试上限重试；最终合并仍执行全计划严格去重。升级部署会明确终止尚未完成的旧生成器任务，用户可重新发起；已经确认的计划、采购勾选、健康记录和私人资料不会被改写。

AI task schema v2 会在任务启动时保存规范化 `activePlan` / `draftPlan` 的摘要，并在 finalize 事务中与最新计划摘要比较。部署时先更新 `aiPlanner`，再更新并启用 `mealAiMaintenance`；不要只部署其中一个。升级前已存在且没有摘要的活动任务会失败关闭为 `conflict`，不会写入候选计划，用户需重新生成。维护函数会压缩这些旧任务、清除仍匹配的活动指针并清理遗留分片，但不会读取或修改 `meal_user_states`。

## schema v6 升级

1. 先备份云数据库，再更新并部署 `userData`，随后部署 `aiPlanner` 和小程序代码。
2. 不要清空或重建 `meal_user_states`。首次读取旧文档时，`userData` 在事务中把 v1-v5 状态增量迁移到 v6。
3. 旧静态食谱仅作为旧用户迁移输入生成 `source: legacy` 的 `activePlan`；新用户保持 `activePlan: null`，必须主动定制计划。
4. v6 保存 `activePlan`、`draftPlan`、最多 64 份 `planHistory`、`generationPreferences`、`stateRevision` 和按 `planId` 隔离的采购/晚餐状态。应用更新不会自动替换已确认计划；达到上限时显式拒绝，不静默删除旧计划。
5. AI 生成只写候选计划；用户在预览页确认后才替换 `activePlan`。生成、确认或恢复失败时保留原计划。
6. 所有写操作携带 `expectedStateRevision`。发生多设备冲突时刷新云端状态，不允许旧客户端静默覆盖。
7. 采购勾选使用从规范化食材产生的稳定 ID；采购勾选和逐日晚餐模式按 `planId` 保存，切换或恢复时加载对应计划自己的状态。旧 flat 状态迁移到迁移时的当前计划。
8. 超过单文档 64 份历史的长期路线是独立归档集合、稳定游标分页和事务恢复；该方案上线并验证迁移前不得淘汰现有历史。
9. AI finalize 只把 `activePlan` / `draftPlan` 摘要和生成偏好作为写入前置条件。计划正文更新、确认、恢复或丢弃会使旧任务进入 `conflict` 且不增加 `stateRevision`；日期、采购、晚餐模式、提醒、设置和餐次覆盖等无关并发更新允许保留并合并。

## 验证顺序

1. 运行 `node scripts/validate.js`，确认 schema v6、AI 契约、共享副本、7/14 天动态餐次和页面路由通过。
2. 在开发者工具编译，检查新用户无计划空状态、餐次任意组合、7/14 天、可选双晚餐、逐日运动、加载/错误/重试状态。
3. 未配置 AI 时应明确显示尚未配置，不得出现内置食谱兜底。
4. 配置 AI 后生成候选，核对全部日期、餐次、结构化食材、生成依据和采购汇总；丢弃候选不能影响当前计划。
5. 确认候选、恢复历史和采购勾选后重新登录，数据应从云端恢复。
6. 同一微信号用两台设备制造 revision 冲突，确认不会静默覆盖。另在 AI 生成期间分别更新候选正文、确认候选、恢复历史和丢弃候选，确认旧任务均以 `conflict` 结束、完整用户状态和 `stateRevision` 不变；再只修改日期、采购、晚餐模式、提醒、设置或餐次覆盖，确认生成成功且这些并发修改保留。最后用第二微信号验证无法读取前一用户的数据。
7. 验证体重、运动、照片、头像、提醒开关及“清空我的私人数据”闭环。额外验证未受邀微信无法调用图片入口、超过头像 1 MB 或健康照片 2 MB 时明确失败、伪装扩展名及文件内容/摘要不符被拒绝，并确认 Network 中没有客户端 `uploadFile`。健康提醒默认关闭，只有用户主动开启后显示。唯一管理员仍有活跃成员时，删除必须被阻止；只有显式选择接任者并确认 `transferOwner` 后才能继续，且任何时刻只能有一名管理员。
8. 建立一个仅含虚构条件且带 v2 摘要的 AI 任务并停止推进，待其 `expiresAt` 后验证 `mealAiMaintenance` 把任务压缩为 `expired`、保留摘要、清除匹配代次的活动指针且不改变 `meal_user_states`。在隔离测试环境另构造无摘要的旧活动任务，确认其压缩为 `conflict`、遗留分片被清理、匹配指针被清除且用户状态不变；重复触发一次应保持幂等。不要使用真实健康或饮食正文做运维测试。
9. 运行 `node scripts/check-staged-safety.js` 并人工核对暂存差异，确认没有配置文件、凭据或个人数据。

## 云开发不可用时

可以保留原生小程序界面，改接自建 HTTPS 后端：

1. 小程序调用 `wx.login` 获取一次性 code，只把 code 发给后端。
2. 后端自行保存 AppID/AppSecret，并通过微信服务端接口换取身份信息；`session_key` 永不返回前端。只有采用此兼容方案时才需要配置 AppSecret。
3. 后端签发自己的短期会话，数据库查询始终使用服务端解析的用户身份，拒绝客户端传入的用户 ID。
4. 自建后端实现同等的 schema v6 迁移、revision 乐观锁、按计划隔离的 UI 状态、无静默历史淘汰、用户隔离、AI 服务端调用、删除闭环和日志脱敏。
5. API 使用有效 HTTPS 证书，并在微信公众平台配置合法域名。

## 上传与发布

全部测试通过后，再在开发者工具执行上传，并在微信公众平台填写版本说明、服务类目和隐私保护指引。上传前再次确认真实配置只存在本机或云控制台，仓库中仍是占位值。提交审核和正式发布按仓库所有者的明确授权执行。
