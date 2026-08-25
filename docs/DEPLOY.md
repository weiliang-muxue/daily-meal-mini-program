# 云开发部署与发布

## 需要填写

1. `project.config.json`：把 `wxYOUR_APPID_HERE` 换成“每天怎么吃”的真实 AppID。
2. `miniprogram/config.js`：把 `YOUR_CLOUD_ENV_ID` 换成真实云开发环境 ID。
3. 不要在任何前端文件填写 AppSecret。云开发方案不需要前端或本仓库保存 AppSecret。

## 初始化

1. 微信开发者工具导入目录：`E:\CodeXWork\饮食小程序`。
2. 使用已注册小程序的管理员/开发者微信登录开发者工具。
3. 点击“云开发”并开通环境，记录环境 ID。
4. 创建集合：`meal_users`、`meal_user_states`、`meal_avatar_uploads`、`meal_members`、`meal_invites`、`health_daily`、`health_photo_uploads`。
5. 将 `database.rules.json` 的规则配置到数据库，禁止客户端直接读写。
6. 将 `storage.rules.json` 的规则配置到云存储；确认只允许已登录用户写入 `avatars/`。
7. 为 `membership` 云函数设置环境变量：`MAX_MEMBERS=4`；先选一个只在本机掌握的部署口令，执行 `node scripts/hash-bootstrap-code.js "口令"`，把输出写入 `OWNER_BOOTSTRAP_CODE_HASH`。不要把明文或哈希提交到小程序前端。
8. 分别部署 `membership`、`auth`、`userData`、`health`、`privacy` 云函数，选择“云端安装依赖”。
9. 按 `database.indexes.json` 在云控制台创建 `health_daily` 与 `meal_invites` 索引；该文件是建议清单，微信开发者工具不会自动替你创建云数据库索引。
10. 首位管理员在首次部署页输入部署口令，之后从“我的”生成三个一次性邀请码。
11. 编译后验证：未邀请拦截、邀请码单次使用和名额上限、个人餐食调整、24/25 日体重数字、运动绿色标记、照片、体重/运动的跨月近 7 天与本月折线、重新进入恢复。
12. 使用另一微信号验证数据隔离；用同一微信号在另一设备验证数据恢复。

## 更新食谱不丢数据

食谱内容与用户状态分开存储。新增 14 天时：

1. 为每周使用全新的稳定 `planId`，例如 `week-2026-02`、`week-2026-03`。
2. 为每天使用全新的稳定 `dayId`，不要复用或修改已发布 ID。
3. 只追加计划目录并提高 `contentVersion`；不要重置 `meal_user_states`。
4. 需要改变用户数据结构时，提高 `CURRENT_SCHEMA` 并在 `migrate()` 增加向前迁移。
5. 发布前用旧版本状态样本运行 `scripts/validate.js`，确认迁移结果仍保留采购、提醒和历史周期选择。

## 云开发不可用时的兼容方案

若账号主体或套餐无法开通云开发，可保留现有小程序前端，替换 `utils/cloud.js` 为自建 HTTPS API：

1. 小程序调用 `wx.login` 获取一次性 code，只把 code 发给自建后端。
2. 后端保存 AppID/AppSecret，通过 `auth.code2Session` 换取 `openid/unionid/session_key`。
3. 后端生成自己的短期登录态，绝不把 `session_key` 返回小程序。
4. 数据库所有表使用服务端解析的用户 ID 作为隔离条件，客户端传入的用户 ID 不可信。
5. API 域名必须配置在微信公众平台合法域名并使用有效 HTTPS 证书。

## 发布

完成真机和多账号验证后，在开发者工具中执行“上传”，到微信公众平台填写版本说明、隐私保护指引、服务类目并提交审核。上传代码和提交审核都是外部发布动作，本项目当前停在上传前。
