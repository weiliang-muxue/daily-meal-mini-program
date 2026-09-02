# 实现前研究记录

本项目先研究现有原生小程序与微信官方规范，再实现；没有复制第三方项目代码或素材。

## GitHub 搜索范围与候选差距

本轮复查日期为 2026-08-26。搜索范围包括微信原生小程序、CloudBase/云函数、AI 食谱或计划生成、动态餐次、7/14 天计划、运动约束、采购清单、用户隔离和发布检查；同时通过 GitHub 公开 API 核对默认分支、许可证、归档状态与最后代码推送时间，并阅读候选仓库的 README 和相关目录。搜索只能证明本轮范围内“尚未发现单一完整项目”，不能证明 GitHub 不存在相关实现。

| 候选项目 | 最后推送 / 许可证 | 已覆盖、可学习的部分 | 本项目仍需补齐的关键能力 | 采用边界 |
| --- | --- | --- | --- | --- |
| [TencentCloudBase/awesome-miniprogram-skills](https://github.com/TencentCloudBase/awesome-miniprogram-skills) | 2026-06-18 / MIT | 官方微信 AI 开发模式示例；原子接口、业务卡片、云函数可信身份和预览/正式双模式 | 是通用 Skill 集，不含动态餐次、逐日运动与健康约束、7/14 天计划、采购汇总和用户数据迁移 | 学习原子业务接口与服务端身份边界；如将来引入代码，必须锁定上游 commit 并保留 MIT 许可证和修改记录 |
| [TencentCloudBase/cloudbase-agent-ui](https://github.com/TencentCloudBase/cloudbase-agent-ui) | 2026-01-29 / MIT | 官方微信原生 AI 对话组件；流式输出、多轮会话、错误和工具卡片 | 面向聊天，不提供结构化餐单契约、分片任务持久化、计划确认和版本迁移 | 借鉴长任务反馈和错误交互；当前餐单生成仍使用本项目可恢复的结构化任务流程，不直接替换为聊天组件 |
| [DawnChen915/cailanzi-miniprogram](https://github.com/DawnChen915/cailanzi-miniprogram) | 2026-08-10 / 未声明 | 微信原生、云开发、家庭库存、菜谱、采购清单、云端真源与离线快照 | 不是按用户所选餐次和逐日运动约束生成 7/14 天 AI 计划；没有本项目的 AI 契约、候选确认及计划版本迁移闭环 | 学习服务层、空状态和同步反馈；因无许可证不复制代码或素材 |
| [Fuqianjiao/Refrigerator_Companion](https://github.com/Fuqianjiao/Refrigerator_Companion) | 2026-04-13 / 未声明 | 原生 TypeScript、云函数、冰箱库存、菜谱匹配和购物清单 | 重点是库存匹配，不是动态 AI 周期计划；缺逐日运动约束、任意餐次组合、计划历史与 schema 向前迁移闭环 | 学习组件拆分与主动完善头像昵称；不采用向前端暴露身份标识等做法，不复制代码 |
| [Laity624/Food-Yun](https://github.com/Laity624/Food-Yun) | 2025-10-23 / 未声明 | 原生云开发菜谱项目、数据库权限意识 | 未覆盖动态 7/14 天生成、运动约束、候选确认、按用户隔离的计划版本和采购状态迁移 | 仅作历史结构参考，不采用旧用户资料流程，不复制代码 |
| [haohao594/Resipe-Mini-Program](https://github.com/haohao594/Resipe-Mini-Program) | 2020-05-16 / GPL-3.0 | 云开发菜谱检索、管理和卡片结构 | 代码长期未推送且依赖旧版组件/用户资料流程；没有 AI 动态计划、运动约束和当前隐私闭环 | 仅了解历史实现；本项目不引入其 GPL 代码 |
| [Henrysxzeng/dayflow](https://github.com/Henrysxzeng/dayflow) | 2026-05-19 / 未声明 | 微信原生、CloudBase、服务端 DeepSeek 环境变量、AI 计划与超时思路 | 业务是任务排期而非食谱；模型响应校验不足以约束餐次数量、食材结构、7/14 天、运动场景和采购汇总 | 学习服务端中转与超时思路；无许可证，不复制实现 |
| [ayrwy/outfit-assistant-miniprogram](https://github.com/ayrwy/outfit-assistant-miniprogram) | 2026-08-12 / 未声明（README 标注仅学习交流） | 微信原生、CloudBase、LLM 服务端中转、模型配置示例 | 业务是穿搭；没有食谱契约、动态餐次、运动约束、采购汇总或计划数据迁移 | 学习 OpenAI 兼容配置检查与结构化结果提取；不复制代码或配置 |
| [Gusty666/mini-kitchen-fast](https://github.com/Gusty666/mini-kitchen-fast) | 2026-07-22 / 未声明 | 先勾选食材、再推荐的条件选择顺序；分类多选、已选条件和缺失食材反馈 | 使用本地静态数据，没有登录、云端真源、用户隔离、AI 任务或迁移 | 学习“用户先选择，系统后生成”的交互顺序；不复制源码或其中的具体 AppID 配置 |
| [SujalPatil21/Mind-Meal](https://github.com/SujalPatil21/Mind-Meal) | 2026-05-29 / MIT | 食材匹配、库存与采购清单的网页演示 | Web + FastAPI + JSON 存储，并非微信原生/云开发；推荐主要匹配静态 `recipes.json`，没有微信身份隔离或动态周期计划 | 可参考 MIT 许可下的通用产品思路，不作为小程序底座 |
| [mzopedia/develop-wechat-ai-miniprograms](https://github.com/mzopedia/develop-wechat-ai-miniprograms) | 2026-07-26 / MIT | 小程序配置、网络请求、隐私 API、疑似密钥和发布状态预检 | 是开发/发布检查工具，不含食谱、计划、采购和用户数据业务 | 作为附加发布前检查参考，不替代本项目业务测试 |

因此，GitHub 并不缺少相关局部实现；缺的是一份经本账号配置后即可发布、并同时满足“微信原生 + 云开发身份边界 + 用户先选餐次/目标/逐日运动 + 任意 1–14 天 AI 候选计划 + 确认后生效 + 采购汇总 + 用户隔离 + 版本迁移 + 前端无密钥”的单一成熟成品。本项目组合公开工程经验自行实现该闭环，并对无许可证仓库只学习思想。

## 后续功能的调研与迭代记录

### 2026-08-31：可变周期输入复核

GitHub 公开项目中可以找到数字输入框、加减步进器和表单校验等局部实现，它们只适合作为交互细节参考；本轮仍未发现可直接替换本项目“微信原生 + 云开发身份边界 + 任意 1–14 天餐单 + 动态餐次 + 运动约束 + 候选确认 + 采购汇总 + 用户隔离与迁移”的完整成品，因此没有复制第三方代码。微信官方原生 [`<input>`](https://developers.weixin.qq.com/miniprogram/dev/component/input.html) 的 `type="number"` 支持数字键盘输入，但 1–14 的范围校验、空白和小于 1 值的失焦归一化、加减按钮边界、辅助功能文案，以及云函数再次拒绝非法周期，仍由应用负责；不能把数字键盘当作数据契约或安全边界。

每个较大功能进入编码前，都要在本文件追加搜索日期、关键词/范围、候选仓库、最后推送时间、许可证、可复用部分和明确差距。候选后来补齐许可证或关键能力时重新评估，不把本轮结论永久化。确定实现后同步更新 `CHANGELOG.md` 的 `Unreleased`、`release-manifest.json`、相应 schema/AI 契约测试和发布清单；公开 Issue 仅使用脱敏样例，支持边界见 `SUPPORT.md`。

本轮没有把任何候选仓库的源码、素材或依赖复制进项目。以后确需引入第三方实现时，必须同时记录上游 URL、固定 commit、原文件、修改内容和许可证，并新增 `THIRD_PARTY_NOTICES.md`；未声明许可证，或只有 README 声称开源但没有可核验许可证文件的仓库，一律只学习思路，不复制代码。

## 微信官方文档核对

- 2026-08-26 复核 [wx.login](https://developers.weixin.qq.com/miniprogram/dev/api/open-api/login/wx.login.html)：登录凭证 `code` 有效期五分钟；传统后端用它换取 openid、满足条件时的 unionid 和 session_key，身份交换与密钥均不能放在小程序前端。
- 2026-08-27 复核 [云函数获取小程序用户信息](https://developers.weixin.qq.com/miniprogram/dev/wxcloudservice/wxcloud/guide/functions/userinfo.html) 与 [Cloud.getWXContext](https://developers.weixin.qq.com/miniprogram/dev/wxcloudservice/wxcloud/reference-sdk-api/utils/Cloud.getWXContext.html)：小程序调用云函数时，微信注入的 `OPENID`、`APPID` 以及满足条件时的 `UNIONID` 是可信身份上下文；`SOURCE` 的官方含义是“云函数本次运行被什么触发”，并会沿调用链传递。`wx_devtools` 只能证明微信 IDE 调用，不能证明操作者是仓库所有者或云环境管理员，因此不得作为首位管理员授权条件。首次 owner 初始化改为两阶段：可信 `OPENID` 只创建随机、短期、无权限请求；部署者在客户端完全不可读写的云数据库控制台明确批准该请求；无终端身份的云端运维调用再原子消费批准记录。授权事实来自控制台数据写入而非 `SOURCE` 或客户端事件，完成后立即删除临时函数。
- [头像昵称填写](https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/userProfile.html)：现行流程使用 `button open-type="chooseAvatar"` 和 `input type="nickname"`，由用户主动选择和填写；开发者工具对原生输入的模拟不等同真机。
- 2026-08-26 复核 [Cloud.callFunction](https://developers.weixin.qq.com/miniprogram/dev/wxcloudservice/wxcloud/reference-sdk-api/functions/Cloud.callFunction.html) 与 [Cloud.CDN](https://developers.weixin.qq.com/miniprogram/dev/wxcloudservice/wxcloud/reference-sdk-api/utils/Cloud.CDN.html)：大于约 100/128 KiB 的字段不应直接塞进调用体；基础库 2.12.0 起可用 `wx.cloud.CDN({ type: 'filePath', filePath })` 把本地临时文件转换为云函数可读取的临时地址。本项目显式检查该能力，不支持时提示升级，不回退到 Base64 或客户端云存储直写。
- 2026-08-26 复核 [存储安全规则](https://developers.weixin.qq.com/miniprogram/dev/wxcloudservice/wxcloud/guide/storage/security-rules.html)：安全规则只能依据 `auth` 与 `resource`，不能查询成员集合；服务端始终有文件权限且规则只限制客户端。因此本项目把根存储规则设为 `read: false`、`write: false`，成员授权只在云函数内执行。

## 本项目取舍

1. 采用微信云开发，云函数通过 `cloud.getWXContext()` 获取身份；前端仍调用 `wx.login` 建立真实微信登录流程，但不保存或展示身份标识。
2. 用户档案、状态和食谱目录分离。食谱更新只追加稳定 ID，不覆盖用户状态。
3. 数据库完全关闭客户端读写，所有业务字段由云函数清洗后更新。
4. 本地缓存只负责加载与离线降级，成功连接后以云数据库返回为准。
5. 头像和健康照片通过微信临时 CDN 进入成员校验后的云函数，执行来源、体积、摘要及真实文件头双重校验，再由服务端写入用户隔离目录；客户端云存储读写全部关闭。昵称可跳过并随时修改。
