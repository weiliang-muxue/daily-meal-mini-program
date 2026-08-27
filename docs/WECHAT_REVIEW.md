# 微信上传、审核与发布清单

本清单供仓库所有者或获得授权的发布者本人使用。它只记录公开规则和无敏感值的验证结论；AppID、环境 ID、Key、账号、密码、邀请码、身份标识和用户数据只在对应微信后台或安全配置界面处理，不得写入仓库、聊天、截图或审核说明的公开副本。

微信规则和类目会调整。每次提交审核前都应重新打开下列官方页面，并以提交页面当时显示的要求为准。

本清单分为技术验证和发布者后台核对。隐私授权实现及“预览、上传、审核、发布”的构建一致性属于技术发布流程；隐私指引填写、第三方条款、深度合成或健康类目、算法或合作材料、邀请制审核访问材料均由发布者本人在微信后台核对和处理，不作为本仓库的代码门禁，也不要求为审核另建业务能力。

## 1. 隐私授权实现

- [ ] 真机基础库达到 `2.32.3` 或更高；低版本路径不会崩溃或卡死。`wx.getPrivacySetting`、`wx.openPrivacyContract`、`wx.requirePrivacyAuthorize` 和 `wx.onNeedPrivacyAuthorization` 均从基础库 `2.32.3` 开始支持，低版本需兼容。官方说明见 [小程序隐私协议开发指南](https://developers.weixin.qq.com/miniprogram/dev/framework/user-privacy/PrivacyAuthorize.html)、[wx.getPrivacySetting](https://developers.weixin.qq.com/miniprogram/dev/api/open-api/privacy/wx.getPrivacySetting.html)、[wx.openPrivacyContract](https://developers.weixin.qq.com/miniprogram/dev/api/open-api/privacy/wx.openPrivacyContract.html)、[wx.requirePrivacyAuthorize](https://developers.weixin.qq.com/miniprogram/dev/api/open-api/privacy/wx.requirePrivacyAuthorize.html) 和 [wx.onNeedPrivacyAuthorization](https://developers.weixin.qq.com/miniprogram/dev/api/open-api/privacy/wx.onNeedPrivacyAuthorization.html)。
- [ ] 选择并真机验证一条完整流程：主动调用 `wx.getPrivacySetting`，或全局注册 `wx.onNeedPrivacyAuthorization`。自定义监听触发后必须在用户真实操作后调用 `resolve`；同意按钮使用 `open-type="agreePrivacyAuthorization"`，拒绝也要结束 pending 状态。`wx.requirePrivacyAuthorize` 只用于按需预触发，不代替用户同意。
- [ ] 用户可查看完整隐私指引。`wx.openPrivacyContract` 不是强制接口，但官方推荐使用；若不使用，页面内必须能完整展示协议，而非只有摘要。
- [ ] 单独验证昵称输入：用户未同意隐私协议时，`<input type="nickname">` 不会触发 `onNeedPrivacyAuthorization`，而会降级为普通文本输入。
- [ ] 不把 `app.json.__usePrivacyCheck__` 当作关闭隐私校验的开关。官方指南说明隐私功能已全量启用。

官方同时文档化主动和被动两种流程，没有规定所有小程序必须统一选择其中一种，也没有提供适用于所有页面结构的唯一推荐代码模板。

## 2. 后台隐私指引

- [ ] 发布者本人在“小程序用户隐私保护指引”中按本次提审代码的实际行为填写，不直接沿用旧版本结论。提审页面会把开发版本的接口调用情况与隐私指引比较；不一致或为空时需要在当前提审入口更新。官方说明见 [用户隐私保护指引填写说明](https://developers.weixin.qq.com/miniprogram/dev/framework/user-privacy/)。
- [ ] 至少核对微信接口自动映射：选择头像和昵称对应“收集你的昵称、头像”；`wx.chooseImage`、`wx.chooseMedia` 或 `wx.chooseVideo` 对应“收集你选中的照片或视频信息”。官方映射见 [小程序用户隐私保护指引内容介绍](https://developers.weixin.qq.com/miniprogram/dev/framework/user-privacy/miniprogram-intro.html)。
- [ ] 不把用户手工填写的运动记录误写成“微信运动步数”。官方的该类型对应微信运动授权和 `wx.getWeRunData`，不是所有运动数据。
- [ ] 按后台实际可选项如实覆盖用户手工填写的体重、运动、饮食选择、忌口、健康约束、提醒、AI 生成选择和计划数据，并写清处理目的、存储期限、联系方式及查阅、更正、删除路径。
- [ ] 核对实际删除闭环与指引一致；账号或成员身份删除后，相应个人数据按承诺处理。官方审核规则要求收集任何用户数据时明确告知用途、取得明确同意，并在注销后删除相关数据，见 [微信小程序平台常见拒绝情形](https://developers.weixin.qq.com/miniprogram/product/reject.html)。

官方公开的“隐私保护指引内容介绍”没有给出“体重”“饮食偏好”“健康约束”“手工运动记录”“AI 提示词”或“AI 生成选择”的固定后台类型名称。发布者必须以提交页面实际选项和真实数据流判断，不能自行把仓库术语冒充为平台类别。

## 3. 第三方 AI 数据处理

- [ ] 在用户发起生成前，以清晰、可单独操作的方式告知第三方处理者、处理目的、发送数据范围、保存策略和联系方式；拒绝后不得发送本次数据。
- [ ] 发布者本人核验 AI 供应商现行服务条款、隐私政策、数据保存和安全安排与产品披露一致，并保存不含凭据或用户数据的核验记录。
- [ ] 取得适用的单独同意。官方隐私指引模板说明，确需向第三方共享或转让用户信息时，应直接征得或确认第三方征得用户单独同意，见 [小程序用户隐私保护指引内容介绍](https://developers.weixin.qq.com/miniprogram/dev/framework/user-privacy/miniprogram-intro.html)。
- [ ] 不把官方页面中的“第三方服务商信息”示例误当成运行时 AI 供应商专用字段；该示例描述代开发服务商。运行时 AI 的披露仍需按真实信息对外提供场景完成。

微信公开文档没有提供“第三方 AI 数据处理”的固定隐私选项、统一同意文案或按钮模板。具体文案、是否还涉及委托处理或其他法律安排，应由发布者结合主体、供应商和数据流完成合规判断。

## 4. 类目、资质与内容标识

- [ ] 发布者本人在后台按真实功能核对并选择服务类目，不以应用名称或“非医疗声明”替代现场判断。类目与材料会变化，以提审页面要求为准，官方范围见 [小程序开放的服务类目](https://developers.weixin.qq.com/miniprogram/product/material.html)。
- [ ] 发布者本人在后台核对是否适用“深度合成”下的 `AI问答`、`AI创作` 或其他类目，并自行准备平台当时要求的材料。使用第三方技术时，官方公开类目表列出的材料包括技术主体的生成合成类（深度合成）算法备案，以及小程序主体与技术主体包含算法名称、应用场景或备案信息的合作协议。
- [ ] 所有 AI 生成餐单、历史计划和其他生成内容在用户查看内容的显著位置持续标注“AI生成”“人工智能生成”或同等含义。该要求来自 [小程序开放的服务类目](https://developers.weixin.qq.com/miniprogram/product/material.html)，不能只在设置页或隐私说明中提及一次。
- [ ] 发布者本人在后台核对是否适用医疗服务或“其他医学健康服务”类目及相应资质。官方对后者的示例是非医疗级运动或营养检测，用于健康管理和改善生活习惯，不用于医疗诊断筛查；这并不自动证明任何饮食工具都属于或不属于该类目。
- [ ] 页面不宣称诊断、处方、治疗或疾病疗效；不夸大日常饮食、养生健康或医疗健康内容。官方内容规则见 [微信小程序平台运营规范](https://developers.weixin.qq.com/miniprogram/product/)。

官方公开类目页无法仅凭“AI 餐单”和“健康记录”替发布者决定唯一类目，也没有保证某一种免责声明能够免除资质要求。最终选择和材料由有权限且了解主体资质的发布者在后台确认；这些后台事项不要求修改本仓库代码，也不作为自动 `validate` 的通过条件。

## 5. 邀请制审核访问

- [ ] 保持现有微信身份与邀请制业务逻辑，不为审核新增邀请码池、账号密码体系、绕过成员校验的入口或其他专用代码路径。
- [ ] 发布者本人在提审后台按页面实际字段核对并提供平台接受的审核访问说明或材料，使审核者能够体验适用功能；不得在小程序页面索取审核者的微信用户名或密码，也不得把任何测试凭据写入 Git。官方 [微信小程序平台运营规范](https://developers.weixin.qq.com/miniprogram/product/) 和 [微信小程序平台常见拒绝情形](https://developers.weixin.qq.com/miniprogram/product/reject.html) 均写明：存在账号体系时提供包含账号和密码、可体验所有功能的测试号；隐藏或受限功能也要能完整体验。
- [ ] 发布者本人根据微信身份登录和邀请制的实际情况向平台说明入口、操作顺序、角色范围及必要前置条件；若后台或审核人员提出补充要求，由发布者本人在平台渠道处理，不将真实访问材料写入公开文档。
- [ ] 发布者本人用虚构数据完成一次审核路径真机演练；这项结果作为外部提审材料核对，不改变邀请业务规则，也不作为本仓库自动代码门禁。

官方公开文档没有说明一次性或短期邀请码是否等价于测试账号密码，也没有规定邀请码数量、最低有效期或固定“审核备注”模板。因此本清单不对邀请码作额外要求，也不宣称现有邀请方式已获得官方预先认可；最终以发布者本人提审时的平台反馈为准。

## 6. 上传、审核与正式发布

- [ ] 完成本地门禁、开发者工具编译、预览和真机回归后，获得仓库所有者明确上传确认。
- [ ] 在开发者工具上传冻结的候选 commit，填写对应版本号和无敏感信息的项目备注。上传后在后台“版本管理 - 开发版本”核对完全相同的候选，可按需设为体验版。官方顺序见 [小程序协同工作和发布](https://developers.weixin.qq.com/miniprogram/dev/framework/quickstart/release.html)；上传参数也见 [命令行 V2](https://developers.weixin.qq.com/miniprogram/dev/devtools/cli.html)。
- [ ] 使用体验版完成最终技术回归；发布者本人同步核对本清单中的后台隐私、类目、资质和审核访问材料。上传备注只是版本管理备注，不代替后台提审材料。
- [ ] 获得仓库所有者单独的提交审核确认后，才在后台开发版本列表提交审核；只能有一份代码处于审核中。
- [ ] 审核通过后核对审核版本仍是同一构建，再由仓库所有者给出最终发布确认并本人选择全量或分阶段发布。
- [ ] 上传、审核和微信正式发布完成前不创建 Tag。确认平台正式发布完成后，才按仓库版本策略在审核通过的完全相同 commit 上创建 annotated Tag；任何构建或合规内容变化都重新走适用门禁。

官方发布文档明确的平台顺序是“预览、上传代码、提交审核、发布”，并区分开发版本、体验版本、审核中版本和线上版本。官方公开文档没有提供适用于所有业务的审核材料固定模板，也没有替仓库定义 Git Tag 时机；本项目的 Tag 时机由仓库版本策略额外约束。
