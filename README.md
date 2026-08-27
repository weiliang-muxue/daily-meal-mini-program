# 每天怎么吃

微信原生小程序。用户先选择 7/14 天、所需餐次、饮食目标、逐日运动和个人约束，再由云函数调用 AI 生成候选餐单；不是 `web-view` 套壳。

当前开发版本为 `0.2.0-dev.1`，尚未正式发布。当前工作线是 Branch `v0.2.0`，上一源码基线由 Tag `v0.1.0` 保留；开发中能力与正式版本必须以 [CHANGELOG.md](CHANGELOG.md) 和 `release-manifest.json` 为准。Branch 会继续增加提交，Tag 是不可移动的历史快照，两者不要混用。

## 已实现

- 先选择早餐、午餐、晚餐、加餐的任意非空组合，再生成 7 或 14 天餐单。
- 用户需要时可为晚餐同时生成运动/不运动方案，不再把“两种晚餐”固定给所有人。
- AI 候选餐单先预览、后确认；失败、丢弃或版本冲突不会替换当前计划。
- 清淡低油及用户主动选择的健康提醒；新用户不会默认启用或发送专业健康条件。
- 采购清单勾选、个人提醒和计划设置。
- `wx.login` + 云函数可信上下文识别用户；前端无 AppSecret、openid、unionid 或 session_key。
- 用户主动选择头像、填写昵称，并可之后修改。
- 邀请制小范围使用，默认 1 位管理员加 6 个受邀名额；邀请码单次使用并在创建 24 小时后过期。
- 每个人可独立调整自己的餐食，不影响其他成员或基础食谱更新。
- 体重、私有照片与运动打卡；月历日期下直接显示体重，运动日显示绿色底和圆点。
- 体重与运动时长均支持近 7 天和本月折线，近 7 天支持跨月查询；另有运动次数和总分钟汇总。
- 云数据库为真源，本地缓存作为加载和断网降级。
- 稳定 `planId/dayId`、计划历史和 `schemaVersion` 向前迁移；更新程序或新增下一期 14 天餐单不会重置用户数据。
- AI 运行期正文按用户私有保存以支持断线续传；到期任务由独立定时云函数幂等压缩，中间分片失败时可在下一批继续清理。
- 用户可二次确认后删除自己的私人数据、照片和成员身份；唯一管理员仍有活跃成员时，必须先明确选择接任者并确认转移，系统不会自动提升任何成员。

部署前请阅读 [docs/DEPLOY.md](docs/DEPLOY.md)、[docs/DATABASE.md](docs/DATABASE.md) 和 [docs/PRIVACY.md](docs/PRIVACY.md)。

版本升级见 [CHANGELOG.md](CHANGELOG.md) 与 [docs/VERSIONING.md](docs/VERSIONING.md)，每次开发、验证和发布证据记录在 [docs/ITERATION_LOG.md](docs/ITERATION_LOG.md)，每次交付按 [docs/RELEASE_CHECKLIST.md](docs/RELEASE_CHECKLIST.md) 核对；使用支持见 [SUPPORT.md](SUPPORT.md)，安全问题见 [SECURITY.md](SECURITY.md)。发布后的附近超市、路线和可靠价格数据源研究记录在 [docs/ROADMAP.md](docs/ROADMAP.md)。

每次推送或 Pull Request 都会运行只读 GitHub Actions，自动检查版本同步、v1-v5 数据迁移、AI 契约、动态餐次和公开仓库安全规则。工作流不配置也不读取任何 GitHub Secret。

原素材完整保存在 `source-assets/meal-plan-gpt-image-2.png`，发布版压缩图位于 `miniprogram/assets/meal-plan-cover.jpg`。

## GitHub 安全规则

- 仓库只保存示例配置。真实 `project.config.json`、`miniprogram/config.js` 和所有 `.env` 只留本机。
- 用户饮食记录、采购勾选、运动、体重、头像、照片和数据库导出只存云端或本机私有目录，不进入 Git。
- `.githooks/pre-commit` 检查暂存索引，`.githooks/pre-push` 检查即将推送的完整提交范围，拦截疑似 AppID、AppSecret、令牌、私钥、微信身份标识和个人数据文件；先提交后删除也不能绕过。

首次克隆后运行 `git config core.hooksPath .githooks` 启用本地提交钩子。正式 AI 地址、`gpt-5.6` 模型、Responses 协议和 `xhigh` 推理强度是可公开审计的版本配置；真实 AI Key 只在微信云函数环境变量中填写。云开发登录不需要 AppSecret，只有改用自建后端兼容方案时才在服务端配置 AppSecret。首位管理员通过发布前临时云函数初始化，成功后必须立即从云端删除该函数。
