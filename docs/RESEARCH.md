# 实现前研究记录

本项目先研究现有原生小程序与微信官方规范，再实现；没有复制第三方项目代码或素材。

## GitHub 候选

- [DawnChen915/cailanzi-miniprogram](https://github.com/DawnChen915/cailanzi-miniprogram)：较新的原生云开发项目。借鉴“云函数为数据边界、本地快照先展示、服务层集中同步、空状态与失败反馈”的工程思路。
- [Fuqianjiao/Refrigerator_Companion](https://github.com/Fuqianjiao/Refrigerator_Companion)：原生 TypeScript + 云函数。借鉴静默身份连接、头像昵称单独完善、食谱/采购组件化；没有采用其向前端返回并缓存 openid、临时头像上传失败后继续保存本地路径的做法。
- [Laity624/Food-Yun](https://github.com/Laity624/Food-Yun)：原生云开发菜谱项目。借鉴安全区域与数据库权限文档意识；没有采用依赖传入 `userInfo` 的旧登录形态。
- [haohao594/Resipe-Mini-Program](https://github.com/haohao594/Resipe-Mini-Program)：2020 年项目，包含云函数与菜谱卡片，但依赖旧版组件和用户资料流程，仅用于了解历史结构，不作为当前 API 依据。

## 微信官方文档核对

- [小程序登录](https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/login.html)：`wx.login` 的 code 一次性使用；传统后端用 `auth.code2Session` 换取 openid/unionid/session_key；session_key 不应下发客户端。
- [头像昵称填写](https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/userProfile.html)：现行流程使用 `button open-type="chooseAvatar"` 和 `input type="nickname"`，由用户主动选择和填写；开发者工具对原生输入的模拟不等同真机。

## 本项目取舍

1. 采用微信云开发，云函数通过 `cloud.getWXContext()` 获取身份；前端仍调用 `wx.login` 建立真实微信登录流程，但不保存或展示身份标识。
2. 用户档案、状态和食谱目录分离。食谱更新只追加稳定 ID，不覆盖用户状态。
3. 数据库完全关闭客户端读写，所有业务字段由云函数清洗后更新。
4. 本地缓存只负责加载与离线降级，成功连接后以云数据库返回为准。
5. 头像使用一次性票据、临时 inbox、云函数校验和用户隔离目录，昵称可跳过并随时修改。
