# 数据库设计与升级

本项目采用微信云开发。客户端不直接读写数据库，所有用户数据均经业务云函数处理；数据库规则建议把全部业务集合的客户端读写关闭。

## 集合

### `meal_users`

文档 `_id` 由云函数使用当前调用者 `OPENID` 创建，前端永远拿不到该值。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `schemaVersion` | number | 用户档案结构版本 |
| `nickname` | string | 用户主动填写，最多 20 字 |
| `avatarFileId` | string | 用户主动选择并上传后的 `cloud://` 文件 ID |
| `unionid` | string | 调用上下文可用时保存，永不返回前端 |
| `loginCount` | number | 登录次数 |
| `createdAt` / `updatedAt` / `lastLoginAt` | server date | 审计时间 |

### `meal_user_states`

文档 `_id` 同样为当前用户 `OPENID`，一人一条状态记录。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `schemaVersion` | number | 当前为 4 |
| `activePlanId` | string | 稳定周期 ID，例如 `week-2026-01` |
| `selectedDayId` | string | 稳定日期 ID，不依赖数组位置 |
| `selectedDay` | number | 兼容旧数据的显示下标 |
| `defaultDinnerMode` | string | `rest` 或 `workout` |
| `dinnerModeByDay` | object | 按稳定日期 ID 保存当天模式 |
| `mealOverrides` | object | 按稳定餐食 ID 保存当前用户的餐食调整 |
| `checkedShoppingIds` | string[] | 采购勾选 ID |
| `customReminders` | object[] | 用户补充提醒及完成状态 |
| `settings` | object | 补钙、维生素 D 等显示设置 |
| `createdAt` / `updatedAt` | server date | 创建及更新时间 |

### `meal_avatar_uploads`

短期上传票据。云函数为当前用户创建一次性随机 token，前端只能上传到对应 inbox 路径；资料保存时云函数核对所有者与 10 分钟有效期，再把文件搬入以 openid 哈希隔离的永久目录。票据和临时文件随后删除。

### `meal_members` / `meal_invites`

`meal_members` 以 openid 为文档 ID，保存 `active/disabled` 状态和 `owner/member` 角色。`meal_invites` 只保存邀请码 SHA-256 哈希、一次性使用状态和 7 天有效期，明文只在创建时返回管理员。

### `health_daily`

每个用户每天一条，文档 ID 为服务端对 `openid:YYYY-MM-DD` 的 SHA-256，不接受客户端用户 ID。字段包含 `owner`、`date`、`month`、`weight`、私有 `photoFileId`、`exercise`、`note` 和服务端时间。照片由 `health_photo_uploads` 一次性票据校验后保存到当前用户哈希目录。

`privacy` 云函数可在用户二次确认后删除当前用户的 `meal_users`、`meal_user_states`、`health_daily` 记录及头像、体重照片和未完成上传票据；不会删除 `meal_members` 成员资格或其他用户数据。

## 初始化与升级

1. 首次部署前创建 `meal_users`、`meal_user_states`、`meal_avatar_uploads`、`meal_members`、`meal_invites`、`health_daily`、`health_photo_uploads`。
2. 首次登录时，云函数以当前 `OPENID` 为文档 ID 初始化记录。
3. `userData` 的 `migrate()` 在读取旧数据时执行增量迁移。它保留稳定 ID，把旧 `dinnerMode` 转换为 `defaultDinnerMode`，并补齐新字段。
4. 新增食谱周期时只向 `miniprogram/data/meal-plan.js` 的 `plans` 追加新 `planId`，不要修改已发布 ID。
5. 现有文档使用字段级 `update`，旧客户端不会删除未来版本新增的服务端字段。

## 索引建议

用户档案和状态集合均按文档 `_id` 精确读取，一人一条，不需要额外索引。不要为 `openid` 建重复索引，也不要开放按用户列表查询。健康记录和邀请需要以下索引：

- `health_daily`: `owner` 升序 + `month` 升序 + `date` 升序，用于月历；另建 `owner` 升序 + `date` 升序，用于跨月近 7 天趋势。
- `meal_invites`: `codeHash` 升序 + `active` 升序，用于一次性邀请码验证。

- `meal_history`: `_openid` 升序 + `createdAt` 降序的组合索引。
- `plan_catalog`: `status` 升序 + `publishedAt` 降序的组合索引。

## 权限

将仓库根目录的 `database.rules.json` 内容配置到云数据库安全规则。云函数使用服务端 SDK，不依赖客户端集合权限。头像与体重照片都采用一次性上传票据，永久目录禁止客户端直接读写，云函数仅返回短期预览 URL。
