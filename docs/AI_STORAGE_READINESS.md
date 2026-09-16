# AI 云数据库就绪检查

这份检查只处理集合和索引元数据，不查询任何文档，不读取用户身份、餐单、运动、体重、照片或凭据。新建资源前必须在当前云环境里重新核对；历史截图、本地导出文件和 CLI 退出码都不能证明当前云端已就绪。

## 用哪个界面

- 集合和索引：使用微信开发者工具中的“云开发 -> 数据库”，或同一环境的 CloudBase 管理控制台。
- 微信公众平台 `mp.weixin.qq.com`：用于版本管理、提交审核和发布，不用于本次 AI 数据库初始化。可以保持登录，当前无需在该页操作。

## 必需集合

| 集合 | 用途 | 复合索引数 |
| --- | --- | ---: |
| `meal_ai_tasks` | AI 任务和临时分片状态 | 3 |
| `meal_ai_shards` | 兼容和未来外置分片清理 | 1 |
| `meal_ai_controls` | 并发、限流和授权版本元数据 | 0 |

三个集合的客户端 `read` 和 `write` 都必须为 `false`。不要为验证而插入测试文档，也不要删除或重建已存在集合。

## 必需复合索引

就绪判定以集合、字段顺序、方向和“可用”状态为准，不依赖控制台中的自定义索引名。

| 集合 | 字段与方向 |
| --- | --- |
| `meal_ai_tasks` | `owner` 升序，`status` 升序，`createdAt` 降序 |
| `meal_ai_tasks` | `status` 升序，`expiresAt` 升序 |
| `meal_ai_tasks` | `shardCleanupPending` 升序，`shardCleanupUpdatedAtMs` 升序 |
| `meal_ai_shards` | `owner` 升序，`taskId` 升序 |

新建索引后等待状态变为“可用”或当前控制台的同义稳定状态。“创建中”、“构建中”、“等待中”或创建请求成功都不等于就绪。

## 安全操作顺序

1. 确认开发者工具当前选中的云环境与小程序本机配置相同；不回显环境 ID。
2. 只看集合列表，记录上述三项的“存在/未验证”，不打开数据文档。
3. 只创建已确认缺失的集合，并立即应用 `database.rules.json` 中的客户端全拒绝规则。
4. 在索引管理页核对上表四项；只创建缺失项，不删除、重建或改名已存在索引。
5. 等待四项全部进入可用状态，再用相同界面复核一次。
6. 只有三个集合和四个索引全部为 `true` 时，才能让 `aiPlanner` 接受新生成任务。
7. 运行本地索引清单门禁：

```powershell
node scripts/check-ai-storage-readiness.js --check-manifest
node scripts/check-ai-storage-readiness.test.js
```

第一个命令只读取仓库中的 `database.indexes.json`，输出固定计数和布尔值；不读取云环境、密钥或业务数据。

## 就绪快照边界

`buildAiStorageReadiness()` 只接受固定 schema 的布尔快照。多一个字段、少一个字段、字符串状态或任意原始管理 API 响应都会失败关闭，并且只返回 `AI_STORAGE_SNAPSHOT_INVALID`。不要把云控制台的原始响应、环境配置或凭据传给该门禁。

未就绪时公开错误码为 `AI_STORAGE_NOT_READY`，就绪时为 `AI_STORAGE_READY`。修复计划仅能列出上述固定集合和索引，且明确禁止文档读写。
