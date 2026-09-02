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

正式部署只允许通过仓库内门禁逐个执行七个正式云函数，例如：

```powershell
$approvedEnvironmentFingerprint = 'sha256-v1:<64 lowercase hex characters from the approved release record>'
pwsh -File scripts/deploy-production-function.ps1 -FunctionName membership -ApprovedEnvironmentFingerprint $approvedEnvironmentFingerprint
```

可选名称仅为 `membership`、`auth`、`userData`、`health`、`privacy`、`aiPlanner`、`mealAiMaintenance`。脚本无默认全量模式，并在访问开发者工具或云环境之前拒绝 `ownerBootstrapOnce`、通配符、根目录、路径、别名、组合名称及大小写变体。实际部署还必须传入由仓库所有者在独立、可审计发布记录中事先批准的 `sha256-v1` 目标环境指纹。该版本指纹对用途字符串和环境 ID 做 SHA-256；脚本只在内存中计算并精确比较，不输出环境 ID 或任一指纹。不得在同一次部署会话中根据当前 CLI 选择临时生成批准值，否则无法防止选错环境。每次部署仍按下文顺序逐个运行；不要直接调用 CLI 的云函数根目录、全量或通配符部署。

## 首次初始化

1. 在微信开发者工具导入 `E:\CodeXWork\饮食小程序`，使用已注册小程序的管理员或开发者微信登录。
2. 开通一个云开发环境，并仅在本机配置环境 ID。
3. 创建集合：`meal_users`、`meal_user_states`、`meal_avatar_uploads`、`meal_members`、`meal_invites`、`health_daily`、`health_photo_uploads`、`meal_ai_tasks`、`meal_ai_shards`、`meal_ai_controls`。
4. 把 `database.rules.json` 配置到数据库安全规则，确认十个集合的客户端 `read`、`write` 都为 `false`。
5. 把 `storage.rules.json` 配置到云存储，并确认根规则为客户端 `read: false`、`write: false`。头像和健康照片由小程序使用微信 `wx.cloud.CDN` 临时传给已经校验有效成员身份的业务云函数；只有云函数可以校验并写入私有永久目录，客户端没有任何云存储直写或直读权限。规则修改通常需要 1–3 分钟生效，生效前不要开放测试账号。
6. 按 `database.indexes.json` 手工创建八个复合索引：`health_daily(owner, month, date)`、`health_daily(owner, date)`、`meal_invites(codeHash, active)`、`meal_members(memberRef, status)`、`meal_ai_tasks(owner, status, createdAt desc)`、`meal_ai_tasks(status, expiresAt)`、`meal_ai_shards(owner, taskId)`、`meal_ai_tasks(shardCleanupPending, shardCleanupUpdatedAtMs)`。
7. `membership` 的业务规则已锁定为管理员 1 人加受邀成员 3 人，一次性邀请码创建后 7 天（168 小时）过期。部署前删除旧版本可能遗留的 `INVITE_SLOTS`、`INVITE_TTL_HOURS` 环境变量，当前代码即使看到它们也会忽略，避免旧配置把总容量扩大或缩短有效期。
8. 按顺序部署 `membership`、`auth`、`userData`、`health`、`privacy`，均选择云端安装依赖。七个正式云函数的 `config.json` 都显式配置 `timeout: 60` 和 `memorySize: 256`；完整部署后必须在云函数配置页或只读函数信息中确认线上值确实为 60 秒和 256 MB，不能把文件存在或上传成功当成运行配置已经生效。`auth/config.json` 必须保留 `phonenumber.getPhoneNumber` 云调用权限；部署后在云函数权限页面核对该权限生效。手机号能力受目标小程序主体资格、认证、计费和额度限制，真机失败时不应开放数据库或加入 AppSecret 规避。先不要部署 `mealAiMaintenance`，待第 6 步索引全部显示可用并完成 AI 云函数配置后再启用其定时触发器。
9. 在小程序尚未发布、成员库与邀请码库都为空时，临时部署 `ownerBootstrapOnce`。不要把 `SOURCE=wx_devtools` 当作管理员授权：官方只将 `SOURCE` 定义为调用链来源，它不能证明操作者是项目所有者。按以下两阶段流程初始化，不需要部署口令或其他密钥：

   1. 目标管理员使用自己的微信登录开发者工具，在调试器 Console 执行 `wx.cloud.callFunction({ name: 'ownerBootstrapOnce', data: { action: 'request' } }).then(console.log)`。确认返回 `success: true`、`data.state: "pending"` 且尚未过期。此操作只创建待批准请求，不授予任何权限；公开响应不包含目标身份、请求编号或批准摘要。
   2. `request` 先在事务外只读确认成员库和邀请码库为空，随后在一个只使用固定文档 `doc()` 的事务中同时创建 `meal_members/__membership_control_v1__` 哨兵和固定请求文档。哨兵进入 `bootstrap_pending`，并绑定内部请求编号。微信云数据库事务不支持 `where`、`limit` 等批量查询，因此事务本身不依赖这些 API；空库审计和事务之间可能出现的合法写入都必须先读写同一个 control 文档，文档版本冲突保证哨兵创建与正式写入只能有一个提交。
   3. 部署者本人在云函数控制台对 `ownerBootstrapOnce` 执行云端测试，事件只填 `{"action":"approve"}`。只有返回 `success: true` 且 `data.state` 为 `approved` 才继续。批准事务只读取固定 control、请求和目标成员文档，验证请求仍为 `pending`、未过期且与哨兵绑定，再把哨兵推进到 `bootstrap_approved` 并增加 `revision`。不要手工编辑数据库文档，也不要临时开放数据库规则。
   4. 仍在云函数控制台执行第二次云端测试，事件只填 `{"action":"activate"}`，无需也不得从外部传入请求编号。激活事务只读取同一组固定文档，验证批准摘要、目标身份、control phase、请求绑定和 revision，再原子创建唯一 owner、把 control 切换为 `active` 并删除请求记录。不要从开发者工具、小程序或跨账号终端调用 `approve` 或 `activate`：上下文带 `OPENID`/`UNIONID`/`FROM_OPENID`/`FROM_UNIONID` 时都会被明确拒绝。
   5. 只有返回 `success: true` 且 `data.state` 为 `initialized` 才算成功。`membership` 和 `privacy` 中所有成员或邀请码新增、更新、撤销及删除路径，都必须在同一事务读取并更新该 control；`bootstrap_pending` 或 `bootstrap_approved` 期间一律拒绝正式写入。并发请求、批准、激活或业务写入依赖固定 control 文档的版本冲突串行化。随后立即从云端删除 `ownerBootstrapOnce`，并确认正式环境中已无法调用它。

   请求文档内的 `targetOpenid`、随机请求编号和批准摘要仅用于两次云端事务，不返回小程序界面。客户端可以在临时函数存在时发起无权限的 `request`，但不能批准记录，也不能通过事件字段把自己或指定身份提升为 owner。若目标不确定或请求已过期，先停止测试并按失败状态排查，不要猜测或手工改写 `targetOpenid`。数据库规则保持客户端完全拒绝；拥有云环境管理权限的人仍可从云控制台直接改写数据，这类平台管理员操作不在程序事务能够防止的范围内，应通过最小权限和云审计日志管控。
10. 重新编译后，管理员应直接进入小程序，再在“我的”页面生成成员邀请码。验证生成值为 32 位大写十六进制、明文仅在创建时出现，待使用列表只显示备注和到期时间；撤销前有二次确认，撤销后原码失效且释放一个名额，重复撤销不重复释放。继续验证第 4 人加入后不能再创建或兑换邀请、邀请码使用一次后立即失效，并验证未使用邀请码在创建 7 天后失效。普通成员必须无法创建、查看、撤销邀请或管理成员。若从旧容量升级，历史已加入成员必须全部保留；正常成员入口只撤销超出新容量的待使用邀请，活跃成员本身已超过 4 人时仅禁止新增，不得自动删除成员。

## AI 云函数配置

模型、Responses 协议和请求头锁定在 `provider-config.js`；provider 请求契约 v9 使用服务根域 `/responses`、`gpt-5.6`、`store:false`，不主动附加服务配置未声明的推理强度。云函数只发送标准 Bearer 鉴权与 JSON 内容头，不发送 provider 专用鉴权或兼容头；兼容回退继续保留 `model`、`instructions`、`input` 和 `store:false`。端点、用户可见服务名和数据接收方 revision 由云函数运行时配置，因此更换服务地址无需改代码，但仍必须执行下述 revision 与重新授权流程。先部署其他业务闭环，再由部署者本人在 `aiPlanner` 云函数的环境变量界面填写：

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `AI_API_KEY` | 是 | AI 服务凭据；绝不进入代码、日志或 Git |
| `AI_API_BASE_URL` | 是 | 非秘密 HTTPS 基础地址；服务根地址规范化为 `/responses`，明确填写 `/v1` 才规范化为 `/v1/responses`，完整 Responses 地址原样保留 |
| `AI_PROVIDER_DISPLAY_NAME` | 是 | 非秘密、面向用户展示的数据接收方名称，1–40 个字符 |
| `AI_PROVIDER_REVISION` | 是 | 正整数；标识本次数据接收方配置，默认示例为 `8` |

只轮换同一数据接收方的 Key 时，保持 `AI_PROVIDER_REVISION` 不变，用户无需因密钥轮换重新授权。只要 `AI_API_BASE_URL`、实际数据接收方或 `AI_PROVIDER_DISPLAY_NAME` 任一变化，就必须先将 `AI_PROVIDER_REVISION` 增加到新的正整数，再一起保存并重新部署；旧活动任务会以 `AI_DATA_CONSENT_REQUIRED` 关闭，用户下一次生成时必须重新勾选发送同意。禁止改变 URL 或接收方却沿用旧 revision。模型名、协议、推理强度、请求头和 temperature 仍不能由环境变量覆盖；contract v9 只允许标准 Bearer 鉴权和 JSON 内容头。

以下只有两个非秘密资源参数可选；通常保持默认值：

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `AI_TIMEOUT_MS` | 否 | 非秘密超时参数，默认使用示例值 |
| `AI_MAX_TOKENS` | 否 | 非秘密输出上限，默认使用示例值 |

配置完成后部署 `aiPlanner`，选择云端安装依赖。部署前清除旧版本可能遗留的 `AI_API_ENDPOINT`、`AI_BASE_URL`、`AI_API_URL`、`AI_MODEL`、`AI_API_STYLE`、`AI_REASONING_EFFORT`、`AI_PROVIDER_HEADER_NAME`、`AI_PROVIDER_HEADER_VALUE` 和 `AI_TEMPERATURE`；当前代码即使看到这些旧变量也会忽略，但清除可以避免控制台误导。不要把控制台中的真实值复制到 `.env.example`、聊天、截图、提交记录或发布说明；仓库中的 `.env.example` 只能保存公开示例和 Key 占位符。

部署后使用小程序的无任务 AI 状态检查确认 `providerContractRevision` 与 `release-manifest.json` 中的 `aiProviderContractRevision` 完全一致，并确认返回的 `providerRevision` 是本次配置的正整数、展示名正确。`providerContractRevision` 只标识代码请求契约；`providerRevision` 标识可变的数据接收方配置。公开状态不返回服务地址、请求头、Key、配置指纹或用户数据；任一版本缺失或不匹配时，客户端与发布探针必须保持维护状态，不能把旧云函数误判为可用。

随后部署不需要任何环境变量或密钥的 `mealAiMaintenance`，选择云端安装依赖。其 `config.json` 配置 `mealAiRetentionSweep` 每 30 分钟运行一次；微信云开发七段 cron 使用 UTC+8。部署后确认 `aiPlanner` 与 `mealAiMaintenance` 的线上超时均为 60 秒、内存均为 256 MB，再在云函数触发器页面确认名称为 `mealAiRetentionSweep`、类型为 `timer`、每 30 分钟运行一次的触发器已经创建并启用，并确认函数只接受 `getWXContext().SOURCE === 'wx_trigger'`。这里的 `SOURCE` 只用于验证平台定时触发类型，不代表操作者权限。微信可能重复投递同一次定时消息，函数已按幂等方式设计。首次验证只查看返回/日志中的计数和错误代码，不要加入打印任务文档的临时日志；若有失败，保留函数等待下次重试并按错误代码排查索引或数据库状态。

八个云函数的 `wx-server-sdk` 均固定为 `4.0.2`，并提交各自的 lockfile v3。部署时使用仓库中的 `package.json` 和 `package-lock.json` 云端安装依赖；不要删除锁文件、改回 `latest`，也不要提交 `node_modules`。升级 SDK 时应单独修改明确版本、重新生成全部八个锁文件并跑完整验证，不能让正式部署随 npm 标签漂移。

部署者可在本机进程环境临时只设置项目专用的 `MEAL_AI_LIVE_TEST_KEY` 后，显式运行 `node scripts/test-ai-provider-live.js --smoke` 做最低成本连通测试，或运行 `node scripts/test-ai-provider-live.js --contract` 做当前固定 10 天合成输入的完整契约测试。脚本无参数时拒绝联网，即使环境中已存在测试 Key 也不会发出请求。本地联调入口会明确忽略通用 `AI_API_KEY`、`OPENAI_API_KEY` 以及运行时 URL、展示名、revision 和模型覆盖，只测试仓库默认 provider 配置，避免误用其他开发工具或项目的凭据。该变量仅用于本机联调；正式 `aiPlanner` 云函数读取上述四项正式配置。脚本只发送仓库内固定的虚构选择，输出仅包含脱敏错误分类、兼容配置和数量摘要，不读取用户数据库，不保存模型原文，也不会打印 URL、Key、请求头、上游响应体或模型名；不要在命令参数中直接拼接 Key。真实验收仍必须从目标微信云函数发起，不能用经过本机代理的结果代替。1、10、14 天的边界覆盖由本地契约和页面测试分别验证，不把单次真实上游联调误写成全部周期实测。

AI 请求只从云函数发出。前端仅提交用户主动选择的餐次、任意 1–14 天周期（默认 1 天）、至少一项饮食目标/风格/补充目标、忌口、健康约束，以及用户明确确认的“不安排运动”或逐日运动安排；旧偏好不会自动视为已确认。云函数在创建任务前重复校验上述意图，AI 返回内容必须通过契约、结构化食材、长度、数量和健康安全校验后，才能保存为 `draftPlan`。

生成器 v7 会按分片索引顺序生成详情，每次只生成 1 个餐位，并把已完成分片的餐名作为后续分片禁用清单。新请求和新计划使用 AI contract v2；固定 provider 配置仍为 `gpt-5.6`、Responses、`store:false` 和 16000 输出 token 上限，不通过缩减输出预算降低契约完整性。上游返回与前序餐名语义相同或出现可重试故障时，当前分片最多尝试 2 次；任务最长保留 2 小时，最终合并仍执行全计划严格去重。升级部署会把生成器或契约版本不匹配的活动任务明确关闭，用户需重新发起；已经确认、候选和历史中的 contract v1 餐单以及 legacy contract v0 餐单仍可使用，采购勾选、健康记录和私人资料不会被改写。

AI task schema v3 会在任务启动时保存本次同意协议版本和规范化 `activePlan` / `draftPlan` 的摘要，并在 finalize 事务中与最新计划摘要比较。部署时先更新 `aiPlanner`，再更新并启用 `mealAiMaintenance`；不要只部署其中一个。升级前已存在且没有同意版本的活动任务会失败关闭为 `AI_DATA_CONSENT_REQUIRED`；具有同意版本但没有摘要的旧任务关闭为 `conflict`。两者都不会写入候选计划，用户需回到确认页重新勾选并生成。维护函数会压缩这些旧任务、清除仍匹配的活动指针并清理遗留分片，但不会读取或修改 `meal_user_states`。

## schema v8 升级

1. 先备份云数据库。部署顺序固定为：先部署可同时读取 schema v7/v8 的新版 `aiPlanner`，再部署 `userData` v8，最后上传新版小程序。不得先部署 `userData` v8，否则尚未升级的旧 `aiPlanner` v7 会拒绝已迁移的 v8 用户状态。
2. 不要清空或重建 `meal_user_states`。首次读取旧文档时，`userData` 在事务中把 v1-v7 状态增量迁移到 v8，并新增默认关闭的喝水提醒；schema v8 一旦写入，不得回滚到只支持 v7 的旧云函数。
3. 旧静态食谱仅作为旧用户迁移输入生成 `source: legacy` 的 `activePlan`；新用户保持 `activePlan: null`，必须主动定制计划。
4. v8 保留原有计划兼容与生成偏好迁移，并新增默认关闭的 `waterReminder`；不会自动替换已确认计划，也不会改写历史、采购、健康或个人提醒。
5. 混部矩阵：旧 `userData` v7 + 新 `aiPlanner` 允许作为第一阶段；新 `userData` v8 + 新 `aiPlanner` 是目标组合；新 `userData` v8 + 旧 `aiPlanner` v7 禁止。完成两项云函数升级后才上传会写入 schema v8 的小程序。
6. 旧客户端窗口：`userData` v8 首次读取会把文档迁移为 v8，仍只支持 schema v7 的旧小程序随后会失败关闭并要求升级。因此应在新版小程序已审核、可立即发布时执行 `userData` 与客户端切换，尽量缩短间隔；不得把该阶段描述为旧客户端可无缝继续使用或零停机。
7. 真机验证喝水提醒默认关闭、每日/周一至周五、起止时间和间隔。只有用户点击并二次确认后才请求日历权限；分别验证拒绝、部分失败和微信版本不支持。已写入事项须在系统日历自行删除。
8. AI 生成只写候选计划；用户在预览页确认后才替换 `activePlan`。生成、确认或恢复失败时保留原计划。
9. 所有写操作携带 `expectedStateRevision`。发生多设备冲突时刷新云端状态，不允许旧客户端静默覆盖。
10. 采购勾选使用从规范化食材产生的稳定 ID；采购勾选和逐日晚餐模式按 `planId` 保存，切换或恢复时加载对应计划自己的状态。旧 flat 状态迁移到迁移时的当前计划。
11. 超过单文档 64 份历史的长期路线是独立归档集合、稳定游标分页和事务恢复；该方案上线并验证迁移前不得淘汰现有历史。
12. AI finalize 只把 `activePlan` / `draftPlan` 摘要和生成偏好作为写入前置条件。计划正文更新、确认、恢复或丢弃会使旧任务进入 `conflict` 且不增加 `stateRevision`；日期、采购、晚餐模式、提醒、设置和餐次覆盖等无关并发更新允许保留并合并。

## 验证顺序

1. 先运行 `npm ci --prefix scripts/wx-automator --ignore-scripts --no-audit --no-fund` 和 `npm test --prefix scripts/wx-automator`，再运行 `node scripts/validate.js`，确认自动化运行时、schema v8、AI contract v2、planner v7、共享副本、任意 1–14 天动态餐次（默认 1 天）和页面路由通过。开发者工具自动化入口统一位于 `scripts/wx-automator`；`smoke.js`、`visual-regression.js`、`interactive-smoke.js` 必须串行执行，不能同时占用自动化端口。所有截图、报告、互斥锁和恢复日志只写入 `.local/automator`，不得暂存或推送。
2. 在开发者工具编译，检查新用户无计划空状态、餐次任意组合、1/10/14 天边界、非法周期阻断、可选双晚餐、逐日运动、加载/错误/重试状态。
3. 未配置 AI 时应明确显示尚未配置，不得出现内置食谱兜底。
4. 配置 AI 后生成候选，核对全部日期、餐次、结构化食材、生成依据和采购汇总；丢弃候选不能影响当前计划。
5. 确认候选、恢复历史和采购勾选后重新登录，数据应从云端恢复。
6. 同一微信号用两台设备制造 revision 冲突，确认不会静默覆盖。另在 AI 生成期间分别更新候选正文、确认候选、恢复历史和丢弃候选，确认旧任务均以 `conflict` 结束、完整用户状态和 `stateRevision` 不变；再只修改日期、采购、晚餐模式、提醒、设置或餐次覆盖，确认生成成功且这些并发修改保留。最后用第二微信号验证无法读取前一用户的数据。
7. 验证体重、运动、照片、头像、提醒开关及“清空我的私人数据”闭环。额外验证未受邀微信无法调用图片入口、超过头像 1 MB 或健康照片 2 MB 时明确失败、伪装扩展名及文件内容/摘要不符被拒绝，并确认 Network 中没有客户端 `uploadFile`。健康提醒默认关闭，只有用户主动开启后显示。普通成员清理后应退出成员资格；唯一且无其他成员的管理员清理后应只保留全新随机引用、无个人资料的最小管理员身份，旧缓存不能恢复。唯一管理员仍有活跃成员时，删除必须被阻止；只有显式选择接任者并确认 `transferOwner` 后才能继续，且任何时刻只能有一名管理员。
8. 建立一个仅含虚构条件、带 task schema v3、AI 同意协议 v2 和有效计划摘要的 AI 任务并停止推进，待其 `expiresAt` 后验证 `mealAiMaintenance` 把任务压缩为 `expired`、保留摘要、清除匹配代次的活动指针且不改变 `meal_user_states`。在隔离测试环境分别构造旧同意版本或缺少同意版本的活动任务，以及带当前同意版本但缺少摘要的活动任务：前者应压缩为 `failed / AI_DATA_CONSENT_REQUIRED`，后者应压缩为 `conflict / STATE_REVISION_CONFLICT`；两者的遗留分片与匹配指针均应清理，用户状态保持不变，重复触发应保持幂等。不要使用真实健康或饮食正文做运维测试。
9. 运行 `node scripts/check-staged-safety.js` 并人工核对暂存差异，确认没有配置文件、凭据或个人数据。
10. 每次完整部署或升级后，由部署者在目标云环境控制台人工完成线上元数据复核：七个正式云函数的超时均为 60 秒、内存均为 256 MB；`auth` 只保留本发布所需的 `phonenumber.getPhoneNumber` 云调用权限；`mealAiMaintenance` 的 `mealAiRetentionSweep` 触发器已启用、类型为 `timer` 且每 30 分钟运行一次；数据库安全规则恰好覆盖十个正式集合且每项客户端 `read`、`write` 都为 `false`；云存储根规则的客户端 `read`、`write` 都为 `false`。本地 `node scripts/validate.js` 只校验仓库静态配置，不查询云环境，不能替代这一步。若只读工具不能筛选返回字段或可能显示环境变量，改用控制台页面只核对上述字段，不保存完整原始响应。

## 云开发不可用时

可以保留原生小程序界面，改接自建 HTTPS 后端：

1. 小程序调用 `wx.login` 获取一次性 code，只把 code 发给后端。
2. 后端自行保存 AppID/AppSecret，并通过微信服务端接口换取身份信息；`session_key` 永不返回前端。只有采用此兼容方案时才需要配置 AppSecret。
3. 后端签发自己的短期会话，数据库查询始终使用服务端解析的用户身份，拒绝客户端传入的用户 ID。
4. 自建后端实现同等的 schema v8 迁移、AI contract v2 与历史计划 contract v1/v0 兼容、revision 乐观锁、按计划隔离的 UI 状态、无静默历史淘汰、用户隔离、AI 服务端调用、删除闭环和日志脱敏。
5. API 使用有效 HTTPS 证书，并在微信公众平台配置合法域名。

## 上传与发布

全部测试通过后，再在开发者工具执行上传，并在微信公众平台填写版本说明、服务类目和隐私保护指引。上传前再次确认真实配置只存在本机或云控制台，仓库中仍是占位值。提交审核和正式发布按仓库所有者的明确授权执行。
