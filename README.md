# 每天怎么吃

微信原生小程序。用户先选择任意 1–14 天（默认 1 天）、所需餐次、饮食目标、逐日运动和个人约束，再由云函数调用 AI 生成候选餐单；不是 `web-view` 套壳。

当前候选版本为 `0.2.0`，状态为 `release-candidate`。运行时对应提交 `115cc5d` 已于 `2026-09-04` 重新完成微信开发版本上传；后续只允许追加不改变运行时目录的公开文档修订。尚未设为体验版、提交微信审核或正式发布。当前候选只位于 Branch `v0.2.0`，上一源码基线由 Tag `v0.1.0` 保留，`main` 不代表本候选树；候选能力与正式发布状态必须以 [CHANGELOG.md](CHANGELOG.md) 和 `release-manifest.json` 为准。上传、审核及正式发布完成前不创建 `v0.2.0` Tag；审核通过、仓库所有者最终确认并完成微信正式发布后，才在审核通过的完全相同 commit 上创建 annotated Tag。

当前兼容矩阵为用户状态 schema v8、新生成请求与计划 contract v2、AI 生成器 v7、AI task schema v3、AI 数据同意协议 v2、AI provider 请求契约 v9。服务商切换会使旧活动任务失败关闭并要求用户重新勾选，不会自动沿用旧同意；升级不改写已确认、候选或历史餐单。历史 contract v1 餐单与 legacy contract v0 静态迁移餐单仍可查看、确认和恢复。

## 已实现

- 先选择早餐、午餐、晚餐、加餐的任意非空组合，再生成任意 1–14 天餐单；新用户默认 1 天，可直接输入或逐天增减。
- 用户需要时可为晚餐同时生成运动/不运动方案，不再把“两种晚餐”固定给所有人。
- AI 候选餐单先预览、后确认；失败、丢弃或版本冲突不会替换当前计划。
- 清淡低油及用户主动选择的健康提醒；新用户不会默认启用或发送专业健康条件。
- 采购清单勾选、个人提醒和计划设置。
- `wx.login` + 云函数可信上下文识别用户；前端无 AppSecret、openid、unionid 或 session_key。
- 用户主动选择头像、填写昵称，并可之后修改。
- 邀请制小范围使用，默认总容量 4 人，即 1 位管理员加 3 个受邀名额；邀请码单次使用并在创建 7 天后过期。
- 每个人可独立调整自己的餐食，不影响其他成员或基础食谱更新。
- 体重、私有照片与运动打卡；月历日期下直接显示体重，运动日显示绿色底和圆点。
- 体重与运动时长均支持近 7 天和本月折线，近 7 天支持跨月查询；另有运动次数和总分钟汇总。
- 云数据库为真源，本地缓存作为加载和断网降级。
- 稳定 `planId/dayId`、计划历史和 `schemaVersion` 向前迁移；更新程序或新增任意后续周期餐单不会重置用户数据。
- AI 运行期正文按用户私有保存以支持断线续传；到期任务由独立定时云函数幂等压缩，中间分片失败时可在下一批继续清理。
- 用户可二次确认后清空自己的全部私人数据和照片；普通成员同时退出成员资格，唯一且无其他成员的管理员仅保留随机化、无个人资料的最小管理员身份，避免实例失去管理入口。唯一管理员仍有活跃成员时，必须先明确选择接任者并确认转移，系统不会自动提升任何成员。

部署前请阅读 [docs/DEPLOY.md](docs/DEPLOY.md)、[docs/DATABASE.md](docs/DATABASE.md) 和 [docs/PRIVACY.md](docs/PRIVACY.md)。

版本升级见 [CHANGELOG.md](CHANGELOG.md) 与 [docs/VERSIONING.md](docs/VERSIONING.md)，每次开发、验证和发布证据记录在 [docs/ITERATION_LOG.md](docs/ITERATION_LOG.md)，每次交付按 [docs/RELEASE_CHECKLIST.md](docs/RELEASE_CHECKLIST.md) 核对，微信后台隐私、类目、审核访问和发布操作按 [docs/WECHAT_REVIEW.md](docs/WECHAT_REVIEW.md) 执行；使用支持见 [SUPPORT.md](SUPPORT.md)，安全问题见 [SECURITY.md](SECURITY.md)。发布后的附近超市、路线和可靠价格数据源研究记录在 [docs/ROADMAP.md](docs/ROADMAP.md)。

每次推送或 Pull Request 都会运行只读 GitHub Actions，自动检查版本同步、schema v1-v7 到 v8 数据迁移、AI 契约、动态餐次、微信开发者工具自动化运行时和公开仓库安全规则。工作流不配置也不读取任何 GitHub Secret。可复现的自动化源码位于 `scripts/wx-automator`，截图、报告、互斥锁和恢复日志只写入被 Git 忽略的 `.local/automator`。

“我的”页提供默认关闭的喝水提醒，可选每日或周一至周五、起止时间及提醒间隔。保存设置不申请权限；只有用户主动点击并二次确认后才写入未来 30 天系统日历重复事项。修改、关闭或清空小程序数据不会删除设备日历事项，需在系统日历中自行删除。

原素材完整保存在 `source-assets/meal-plan-gpt-image-2.png`，发布版压缩图位于 `miniprogram/assets/meal-plan-cover.jpg`。

## GitHub 安全规则

- 仓库只保存示例配置。真实 `project.config.json`、`miniprogram/config.js` 和所有 `.env` 只留本机。
- 用户饮食记录、采购勾选、运动、体重、头像、照片和数据库导出只存云端或本机私有目录，不进入 Git。
- `.githooks/pre-commit` 检查暂存索引，`.githooks/pre-push` 检查即将推送的完整提交范围，拦截疑似 AppID、AppSecret、令牌、私钥、微信身份标识和个人数据文件；先提交后删除也不能绕过。

首次克隆后运行 `git config core.hooksPath .githooks` 启用本地提交钩子。AI 模型和 Responses 协议是版本化代码配置；provider 请求契约 v9 使用部署者在云函数运行时填写的 HTTPS Responses 地址与 `gpt-5.6`，云函数只发送标准 Bearer 鉴权和 JSON 内容头，不发送 provider 专用鉴权或兼容头，也不主动附加未在服务配置中声明的推理强度。兼容回退受 deadline 约束，每个档位始终保留 `model`、`instructions`、`input` 和 `store:false`。正式 `AI_API_KEY`、`AI_API_BASE_URL`、`AI_PROVIDER_DISPLAY_NAME` 与 `AI_PROVIDER_REVISION` 只在微信云函数环境变量中配置；只轮换同一接收方的 Key 时 revision 不变，服务地址、接收方或展示名变化时必须提高 revision，使旧活动任务关闭并要求用户重新确认发送。真实 Key 绝不进入代码、日志或 Git。云开发登录不需要 AppSecret，只有改用自建后端兼容方案时才在服务端配置 AppSecret。首位管理员通过发布前临时云函数初始化，成功后必须立即从云端删除该函数。
