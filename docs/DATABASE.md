# 数据库设计与升级

本项目采用微信云开发。客户端不直接访问数据库；所有业务读写均经过云函数，并以可信调用上下文中的 `OPENID` 确定当前用户。客户端传入的用户 ID 不作为授权依据。

## 集合与权限

部署时创建以下十个集合，并把客户端 `read`、`write` 均设为 `false`：

- `meal_users`
- `meal_user_states`
- `meal_avatar_uploads`
- `meal_members`
- `meal_invites`
- `health_daily`
- `health_photo_uploads`
- `meal_ai_tasks`
- `meal_ai_shards`
- `meal_ai_controls`

云函数使用服务端 SDK 读写。不要为了调试临时开放集合，也不要允许客户端按 openid 查询或列举用户。

## `meal_users`

文档 `_id` 为当前调用者的 `OPENID`，只在服务端使用。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `schemaVersion` | number | 用户档案结构版本 |
| `nickname` | string | 用户主动填写，最多 20 字 |
| `avatarFileId` | string | 经成员校验、内容校验和一次性票据事务绑定后的私有文件 ID |
| `unionid` | string | 调用上下文可用时保存，永不返回前端 |
| `loginCount` | number | 登录次数 |
| `createdAt` / `updatedAt` / `lastLoginAt` | server date | 服务端审计时间 |

## `meal_user_states` schema v6

一名用户一条文档，文档 `_id` 为当前调用者 `OPENID`。云数据库是数据真源，本机缓存只是当前微信身份命名空间下的离线快照。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `schemaVersion` | number | 当前为 6 |
| `stateRevision` | number | 服务端乐观锁版本，每次成功写入递增 |
| `activePlan` | object/null | 用户已确认的当前计划；新用户为 `null` |
| `draftPlan` | object/null | AI 校验通过但尚未确认的候选计划 |
| `planHistory` | object[] | 最多 64 份被替换计划；达到上限后拒绝继续替换，不静默删除 |
| `generationPreferences` | object | 7/14 天、餐次、目标、风格、约束与逐日运动选择 |
| `activePlanId` | string | 当前计划稳定 ID；兼容导航和旧字段 |
| `selectedDayId` / `selectedDay` | string/number | 当前查看日期的稳定 ID 与兼容下标 |
| `defaultDinnerMode` / `dinnerModeByDay` | string/object | 当前计划的兼容展示字段；用户选择双晚餐时的默认及逐日场景 |
| `planUiStateByPlan` | object | 以 `planId` 为键保存每份当前/候选/历史计划的查看日期、晚餐模式与采购勾选 |
| `mealOverrides` | object | 以稳定餐食 ID 为键的个人展示调整 |
| `checkedShoppingIds` | string[] | 当前计划内已勾选的稳定采购 ID；兼容现有页面的镜像字段 |
| `customReminders` | object[] | 用户主动添加的提醒与完成状态 |
| `settings` | object | 健康提醒开关；默认关闭，用户主动开启后生效 |
| `createdAt` / `updatedAt` | server date | 服务端创建及更新时间 |

### 动态计划对象

`activePlan`、`draftPlan` 和历史计划使用同一严格结构：

- 计划：稳定 `id`、`planVersion`、`contractVersion`、`source`、标题、7/14 天周期、生成时间、生成依据、推荐说明、`days`、`shoppingGroups`。
- 日期：稳定 `id`、日期、星期、主题、该日运动安排、动态 `meals` 数组。
- 餐食：稳定 `id`、`type`（早餐/午餐/晚餐/加餐）、`scenario`（默认/不运动/运动）、标题、结构化食材、做法和提示。
- 采购项：从最终餐食的规范化食材确定性汇总；相同规范名称、单位和分类产生跨计划稳定 ID，不采用数组位置或随机 ID。

服务端限制计划为 7 或 14 天、每天最多 5 个餐食、计划正文最多 128 KiB、完整用户状态最多 900 KiB、历史最多 64 份，并限制所有数组数量与文本长度。达到 64 份或文档大小上限时，确认/恢复操作返回明确错误，当前计划及全部历史保持原样；服务端和客户端都不得用 `slice` 或其他方式静默淘汰旧计划。

64 份是单文档阶段的明确保护上限，不是长期归档策略。后续需要更长历史时，应先引入按用户隔离的独立归档集合、稳定游标分页、迁移校验与恢复事务，再提高容量；迁移完成前不得删除 `meal_user_states.planHistory` 中的任何计划。`planUiStateByPlan` 与计划一同迁移，使旧计划恢复时找回该计划自己的采购勾选和逐日晚餐模式。

## 其他集合

### `meal_members` 与 `meal_invites`

`meal_members` 以 openid 为文档 ID，保存 `active/disabled/deleting` 状态、`owner/member` 角色、加入时间和服务端时间；`deleting` 是阻止删除过程中继续写入私人数据的不可用状态。默认容量为 1 位 `owner` 加 6 位受邀 `member`；非秘密环境变量 `INVITE_SLOTS=6` 表示受邀名额，不包含管理员。受邀账号永远以普通 `member` 加入，只有唯一 `owner` 可以创建邀请、查看成员或发起管理员转移。`meal_invites` 只保存邀请码摘要、有效状态、次数、有效期和创建者；明文只在创建时返回一次，每个邀请码最多使用一次，并在创建 24 小时后过期。

`meal_members/__membership_control_v1__` 是所有成员和邀请码正式写入共同使用的固定并发控制文档。control schema v2 保存 `phase`、`bootstrapRequestId`、唯一 owner、活跃成员数、预留邀请码数和单调递增的 `revision`。历史 schema v1 control 没有 `phase` 时按已初始化的 `active` 兼容读取；新的空环境不能由常规 `membership` 自行创建空 control，必须走临时初始化函数。

首次部署时，临时函数在空库只读审计后，以事务原子创建 control 哨兵和 `meal_members/__owner_bootstrap_request_v1__`。状态依次为 `bootstrap_pending`、`bootstrap_approved`、`active`；请求最长 30 分钟，包含微信可信身份、随机请求编号、与二者绑定的摘要、状态和过期时间。`membership` 与 `privacy` 中所有合法成员/邀请码写入口都在同一事务先读取 control，初始化态拒绝写入，活跃态写入时同步增加 revision。这样空库审计后若有合法业务写竞争，双方会在同一个 control 文档发生版本冲突，只能一个提交。批准和激活事务只使用固定 `doc()` 读写，不在事务内调用微信官方不支持的批量查询。激活消费并删除请求记录后，应从云端删除临时函数。

客户端规则对 `meal_members` 和 `meal_invites` 始终为 `read: false`、`write: false`。拥有云环境管理权限的人可在云控制台绕过应用云函数直接改写数据，这不属于程序可以阻止的调用路径；生产环境必须限制控制台权限并保留平台审计日志，不要把手工改库当作正常初始化或修复流程。

### `meal_avatar_uploads` 与 `health_photo_uploads`

图片不经过客户端云存储 inbox。小程序先用 `FileSystemManager.getFileInfo` 检查大小并计算 SHA-256，再以 `wx.cloud.CDN({ type: 'filePath', filePath })` 把本地临时文件交给同一次 `updateProfile` 或 `saveDaily` 云函数调用。云函数先确认可信 `OPENID` 对应有效成员，再限制 HTTPS 来源、DNS 解析、重定向、绝对超时和流式响应体大小，并复核 SHA-256、实际字节数及 JPG/PNG/WebP 文件头。

云函数上传前创建短期一次性票据，保存 `owner`、`state`、`permanentPath`、预期大小/摘要、目标日期（健康照片）、有效期和服务端时间。状态依次为 `prepared`、`staged`、`consumed` 或 `cleanup`/`cleaning`；只有 `staged` 能在业务事务中消费一次。票据消费与档案/当天记录写入属于同一个事务，事务内重新读取当前活跃文件引用，避免跨设备旧写删除新文件。头像最大 1 MB，健康照片最大 2 MB。

### `health_daily`

每个用户每天最多一条。文档 ID 为服务端对 `openid:YYYY-MM-DD` 的摘要，客户端不能选择文档 ID。字段包含 `owner`、`date`、`month`、体重、私有照片 ID、运动、备注、schema 版本和服务端时间。

### `meal_ai_tasks`、`meal_ai_shards` 与 `meal_ai_controls`

这三个集合只保存 AI 生成流程的临时私有数据，均由服务端写入 `owner` 并按可信调用身份隔离：

- `meal_ai_tasks` 在生成运行期保存任务状态、用户本次选择、AI 提纲和详情片段、租约、计划标识及创建/过期时间；客户端不能指定 `owner`。任务 schema v2 在启动事务中对规范化后的 `{ activePlan, draftPlan }` 计算带域分隔的稳定 SHA-256 `planStateFingerprint`，其中 `null` 也明确参与摘要。任务只保存摘要，不复制计划正文，公开任务响应也不返回摘要。当前生成器把详情片段内嵌在任务文档的 `chunks` 中。任务进入终态时会立即压缩；无人继续推进的活动任务到期后由 `mealAiMaintenance` 压缩，移除 `input`、`outline`、`chunks`、`finalize` 和租约等正文，只保留恢复幂等、展示终态与审计计数所需的最小字段；`planStateFingerprint` 会保留到终态审计记录中。
- `meal_ai_shards` 是预留的外置分片集合，供未来文档大小迁移和兼容旧数据使用；当前生成器不向其中写入正文。维护函数仍按 `owner + taskId` 删除到期任务可能遗留的分片，账号删除则按 `owner` 删除该用户全部分片。
- `meal_ai_controls` 保存当前用户的并发、限流或任务控制元数据，不保存可供其他用户读取的公共状态。

用于索引的 `createdAt`、`updatedAt` 和 `expiresAt` 均为服务端计算的 epoch milliseconds，不能与 `serverDate` 混用；`createdAtMs`、`updatedAtMs` 仅作为现阶段兼容字段。活动任务默认在创建 2 小时后到期。`mealAiMaintenance` 每 30 分钟由 UTC+8 定时触发器运行，分别查询 `queued`、`running`、`finalizing` 及旧状态别名，事务重读后才压缩；重复投递、并发推进或部分分片删除失败均可安全重试。维护日志只记录计数和规范化错误代码，不记录 `owner`、任务 ID、用户输入或 AI 输出。该函数不读取 `meal_user_states`，不会删除 `draftPlan`、`activePlan` 或 `planHistory`。

最终计划写入与任务终结在同一个数据库事务中完成。事务重新规范化最新 `activePlan` 和 `draftPlan` 并计算摘要：摘要与启动基线不一致时，任务以 `conflict` / `STATE_REVISION_CONFLICT` 终结，`meal_user_states` 的全部字段及 `stateRevision` 保持原值；摘要一致时，不要求最新 `stateRevision` 等于启动 revision，因此日期选择、采购勾选、晚餐模式、提醒、设置、`planUiStateByPlan`、`mealOverrides` 等无关并发更新可以保留并与新 `draftPlan` 合并。生成偏好仍必须与任务输入一致。生成期间更新候选正文，或确认、恢复、丢弃计划造成 `activePlan` / `draftPlan` 变化，旧 finalize 均不得写入。

旧 task schema 活动任务若没有合法 `planStateFingerprint`，无法证明计划基线，必须失败关闭。幂等重放、状态读取、当前任务恢复、领取工作和迟到 worker 的成功/失败回写都会把它压缩为 `conflict` 并清除仍指向该代次的控制指针；到期后由维护函数执行相同终态转换。`expired` 与 `conflict` 都可以继续清理遗留分片。上述路径均不读取或修改用户计划状态。

任务完成或过期后的后台清理不能替代账号删除。用户发起数据删除时，`privacy` 会再次按 `owner` 查询并删除三个集合中的全部记录；删除后重新查询确认没有残留。

### 上传票据文件清理

当前票据使用 `permanentPath`、`permanentFileId` 和 `cleanupFileId` 记录预留对象路径、已上传文件和待清理旧文件。服务进程若在文件上传成功但 fileID 写回票据前中断，过期清理会在校验精确私有路径后覆盖该路径并删除，从而回收未知 fileID 的对象。账号删除同时兼容旧版 `inboxFileId`、`fileID`、`fileId`；所有 fileID 必须以 `cloud://` 开头并去重后分批删除。清理领取事务会先重读档案或当天记录中的活跃文件，绝不删除仍被业务记录引用的对象。

## v1-v4 到 v5 迁移

1. `userData.bootstrap` 在事务内读取当前用户文档并执行向前迁移。
2. 旧固定字段、采购勾选、提醒、设置、个人餐食调整和选择状态保留。
3. 旧静态计划只由 `userData` 作为迁移输入注入，转换为 `source: legacy` 的 `activePlan`。schema v6 新用户不会读取静态默认计划。
4. 迁移具有幂等性；已是 v5 的文档不会再次包装计划。
5. AI 生成只写 `draftPlan`；确认时旧 `activePlan` 进入历史。历史达到 64 份时拒绝确认并提示先归档，不移除任何记录。
6. schema v1-v5 的 flat `checkedShoppingIds`、`dinnerModeByDay` 和日期选择在迁移时无损绑定到当时的 `activePlanId`；此后按 `planId` 命名空间读写，并继续同步 flat 字段供现有页面兼容。
6. 确认或恢复计划时，采购勾选只保留目标计划中仍存在的稳定 ID。
7. 所有修改使用 `expectedStateRevision` 在事务中校验。版本不一致返回冲突，客户端必须刷新，不允许旧状态整份覆盖。

## 索引

`meal_users`、`meal_user_states` 和上传票据主要按 `_id` 精确读取。只创建 `database.indexes.json` 中已有的八项：

- `health_daily`: `owner` 升序 + `month` 升序 + `date` 升序，用于月历。
- `health_daily`: `owner` 升序 + `date` 升序，用于跨月区间趋势。
- `meal_invites`: `codeHash` 升序 + `active` 升序，用于一次性邀请码验证。
- `meal_members`: `memberRef` 升序 + `status` 升序，用于管理员按不暴露 openid 的成员引用选择接任者。
- `meal_ai_tasks`: `owner` 升序 + `status` 升序 + `createdAt` 降序，用于读取当前用户某状态下的最近任务。
- `meal_ai_tasks`: `status` 升序 + `expiresAt` 升序，用于维护函数逐个状态查询到期且尚未压缩的任务；不要依赖 `in` 查询。
- `meal_ai_shards`: `owner` 升序 + `taskId` 升序，用于按用户与任务读取或删除分片。
- `meal_ai_tasks`: `shardCleanupPending` 升序 + `shardCleanupUpdatedAtMs` 升序，用于轮转处理遗留分片；每次尝试后更新时间，持续失败的任务不会阻塞后续批次。

维护函数每轮最多压缩 40 条任务、检查 20 条待清理任务并尝试删除 200 个分片。达到上限后由下一次定时触发继续，不用一次读取全部用户任务。

计划历史嵌入当前用户的 `meal_user_states` 文档，不存在独立 `meal_history` 或 `plan_catalog` 集合，也不应创建对应索引。

## 删除闭环

用户二次确认后，`privacy` 按以下顺序执行删除闭环：

1. 预检成员和唯一管理员约束；若删除者是唯一 `owner` 且仍有活跃成员，返回 `OWNER_TRANSFER_REQUIRED`。
2. 先撤销当前用户创建且仍有效的邀请，并在事务内归还邀请名额。
3. 在事务内把当前成员标记为 `deleting` 并更新成员容量控制。所有业务云函数只允许 `active` 成员继续操作，因此从此处开始不能创建新的 AI 任务或私人数据。
4. 再按当前身份收集用户档案、状态、健康记录、上传票据、相关邀请及三个 AI 私有集合，删除云文件与记录，最后删除成员文档。
5. 重新查询全部集合；任何残留都会返回 `DELETE_INCOMPLETE`，不会把部分完成误报为成功。

管理员需先通过 `transferOwner` 明确选择一名活跃普通成员并二次确认，事务成功后才能再次删除。系统不得按加入时间、文档 ID 或其他规则自动提升成员，也不得同时存在两个管理员。删除流程允许在成员已是 `deleting` 或成员文档已移除后重试，以便清理由网络或平台错误造成的剩余记录；重试仍只使用服务端解析的当前身份，不能影响其他用户的数据。
