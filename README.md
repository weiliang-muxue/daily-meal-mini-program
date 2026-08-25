# 每天怎么吃

微信原生小程序，一周早餐与两种晚餐计划。不是 `web-view` 套壳。

## 已实现

- 周一至周日原生卡片切换和左右滑动。
- 每天分别提供“今晚不锻炼”和“今晚锻炼”，共 14 套不同晚餐。
- 清淡低油、补钙、维生素 D 与巧囊闭经针治疗期骨健康提示。
- 采购清单勾选、个人提醒和计划设置。
- `wx.login` + 云函数可信上下文识别用户；前端无 AppSecret、openid、unionid 或 session_key。
- 用户主动选择头像、填写昵称，并可之后修改。
- 邀请制小范围使用，默认最多 4 人；管理员生成一次性邀请码。
- 每个人可独立调整自己的餐食，不影响其他成员或基础食谱更新。
- 体重、私有照片与运动打卡；月历日期下直接显示体重，运动日显示绿色底和圆点。
- 体重与运动时长均支持近 7 天和本月折线，近 7 天支持跨月查询；另有运动次数和总分钟汇总。
- 云数据库为真源，本地缓存作为加载和断网降级。
- 稳定 `planId/dayId` 和 `schemaVersion` 迁移，后续新增周期不会重置用户数据。
- 用户可二次确认后清空自己的私人数据和照片，不影响成员资格及其他成员。

部署前请阅读 [docs/DEPLOY.md](docs/DEPLOY.md)、[docs/DATABASE.md](docs/DATABASE.md) 和 [docs/PRIVACY.md](docs/PRIVACY.md)。

原素材完整保存在 `source-assets/meal-plan-gpt-image-2.png`，发布版压缩图位于 `miniprogram/assets/meal-plan-cover.jpg`。

## GitHub 安全规则

- 仓库只保存示例配置。真实 `project.config.json`、`miniprogram/config.js` 和所有 `.env` 只留本机。
- 用户饮食记录、采购勾选、运动、体重、头像、照片和数据库导出只存云端或本机私有目录，不进入 Git。
- `.githooks/pre-commit` 会在每次提交前拦截疑似 AppID、AppSecret、令牌、私钥和个人数据文件。
