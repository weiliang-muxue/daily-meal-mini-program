const days = [
  {
    id: 'week-2026-01-mon', short: '一', name: '周一', theme: '清蒸开场',
    breakfast: { label: '早餐', title: '牛奶燕麦蛋碗', ingredients: '纯牛奶 300 ml · 燕麦 40 g · 鸡蛋 1 个 · 猕猴桃 1 个', method: '燕麦加牛奶煮 3–5 分钟；鸡蛋水煮，水果最后吃。', tag: '钙锚点：牛奶' },
    restDinner: { label: '今晚不锻炼', title: '香菇蒸鸡腿 + 西兰花', ingredients: '去皮鸡腿肉 150 g · 鲜香菇 3 朵 · 西兰花 250 g · 米饭 80–100 g', method: '鸡肉用少量生抽、姜腌 10 分钟，与香菇蒸 15 分钟；西兰花焯熟。', tag: '少油 · 蛋白质约 30 g' },
    workoutDinner: { label: '今晚锻炼', title: '三文鱼杂粮饭恢复碗', ingredients: '三文鱼 130 g · 杂粮饭 150 g · 西兰花 200 g · 无糖酸奶 100 g', method: '三文鱼少油煎熟，和杂粮饭、焯西兰花装碗；酸奶单独吃。', tag: '补主食 + 优质蛋白' },
  },
  {
    id: 'week-2026-01-tue', short: '二', name: '周二', theme: '一锅汤菜',
    breakfast: { label: '早餐', title: '芝士番茄蛋吐司', ingredients: '全麦吐司 2 片 · 鸡蛋 1 个 · 低盐芝士 1 片 · 番茄 1 个', method: '不粘锅刷薄油煎蛋；吐司夹番茄、鸡蛋和芝士。', tag: '钙锚点：芝士' },
    restDinner: { label: '今晚不锻炼', title: '虾仁豆腐青菜汤', ingredients: '虾仁 120 g · 北豆腐 200 g · 小白菜 250 g · 米饭 80–100 g', method: '姜片煮水，下豆腐 5 分钟、虾仁 2 分钟，最后放青菜。', tag: '选钙盐点制豆腐' },
    workoutDinner: { label: '今晚锻炼', title: '番茄牛肉荞麦面', ingredients: '瘦牛肉 120 g · 荞麦面 80 g · 番茄 1 个 · 青菜 150 g', method: '番茄煮出汤，下牛肉片、面和青菜；少盐，用醋提味。', tag: '一锅补糖原与铁' },
  },
  {
    id: 'week-2026-01-wed', short: '三', name: '周三', theme: '维 D 鱼餐',
    breakfast: { label: '早餐', title: '南瓜小米粥 + 酸奶蛋', ingredients: '小米 40 g · 南瓜 120 g · 无糖酸奶 200 g · 鸡蛋 1 个', method: '小米南瓜可前夜预约煮；早上配水煮蛋和酸奶。', tag: '钙锚点：酸奶' },
    restDinner: { label: '今晚不锻炼', title: '香煎三文鱼 + 口蘑菠菜', ingredients: '三文鱼 150 g · 口蘑 150 g · 菠菜 200 g · 米饭 80–100 g', method: '1 茶匙油煎三文鱼；口蘑炒软，菠菜焯水拌入。', tag: '维生素 D 食物来源' },
    workoutDinner: { label: '今晚锻炼', title: '鸡丝豆腐杂粮粥', ingredients: '鸡胸 120 g · 北豆腐 150 g · 杂粮粥 1 大碗 · 青菜 150 g', method: '杂粮粥煮开后下鸡丝和豆腐，最后放青菜，白胡椒调味。', tag: '温热好消化 · 补钙' },
  },
  {
    id: 'week-2026-01-thu', short: '四', name: '周四', theme: '快手炒菜',
    breakfast: { label: '早餐', title: '强化豆奶 + 玉米鸡蛋', ingredients: '高钙无糖豆奶 300 ml · 玉米 1 根 · 鸡蛋 1 个 · 橙子 1 个', method: '玉米与鸡蛋一起煮；豆奶优先每 100 ml 钙 ≥100 mg。', tag: '乳糖不耐友好' },
    restDinner: { label: '今晚不锻炼', title: '鸡胸口蘑炒黄瓜', ingredients: '鸡胸 150 g · 口蘑 150 g · 黄瓜 1 根 · 红薯 120 g', method: '鸡胸切片抓少量淀粉；1–2 茶匙油依次炒熟。', tag: '高蛋白 · 一锅完成' },
    workoutDinner: { label: '今晚锻炼', title: '虾仁玉米豆腐蒸蛋', ingredients: '虾仁 120 g · 鸡蛋 2 个 · 嫩豆腐 120 g · 玉米半根 · 米饭 120 g', method: '蛋液加温水，铺豆腐、虾仁和玉米蒸 12 分钟，配米饭。', tag: '软嫩补能量 · 少油' },
  },
  {
    id: 'week-2026-01-fri', short: '五', name: '周五', theme: '番茄炖锅',
    breakfast: { label: '早餐', title: '隔夜酸奶燕麦', ingredients: '无糖酸奶 200 g · 燕麦 40 g · 蓝莓/草莓 100 g · 核桃 10 g', method: '前夜混合酸奶与燕麦冷藏，早上加水果核桃。', tag: '钙锚点：酸奶' },
    restDinner: { label: '今晚不锻炼', title: '番茄土豆炖瘦牛肉', ingredients: '瘦牛肉 150 g · 番茄 2 个 · 土豆 100 g · 小白菜 200 g', method: '牛肉变色后放番茄土豆和水炖 15 分钟；最后放青菜。', tag: '铁 + 蛋白质' },
    workoutDinner: { label: '今晚锻炼', title: '照烧鸡腿紫薯盘', ingredients: '去皮鸡腿 150 g · 紫薯 220 g · 彩椒 100 g · 牛奶 250 ml', method: '鸡腿少油煎熟，用少量生抽收汁；紫薯蒸熟，配彩椒和牛奶。', tag: '恢复餐 · 双钙锚点之一' },
  },
  {
    id: 'week-2026-01-sat', short: '六', name: '周六', theme: '清蒸鱼餐',
    breakfast: { label: '早餐', title: '花生酱香蕉吐司 + 奶', ingredients: '全麦吐司 2 片 · 无糖花生酱 10 g · 香蕉半根 · 牛奶 300 ml', method: '吐司烤脆，薄抹花生酱并铺香蕉片。', tag: '钙锚点：牛奶' },
    restDinner: { label: '今晚不锻炼', title: '清蒸鲈鱼 + 豆腐青菜', ingredients: '鲈鱼/鱼片 180 g · 北豆腐 150 g · 菜心 250 g · 米饭 80–100 g', method: '鱼加姜蒸 8–10 分钟；豆腐和菜心焯熟。', tag: '豆腐补钙' },
    workoutDinner: { label: '今晚锻炼', title: '牛肉土豆杂蔬焖饭', ingredients: '瘦牛肉 130 g · 大米 75 g · 土豆 120 g · 胡萝卜和菌菇 150 g', method: '牛肉先炒变色，与米、土豆和杂蔬一起焖熟；少油少盐。', tag: '长运动日更耐饱' },
  },
  {
    id: 'week-2026-01-sun', short: '日', name: '周日', theme: '冰箱清理',
    breakfast: { label: '早餐', title: '蔬菜鸡蛋卷 + 牛奶', ingredients: '全麦饼 1 张 · 鸡蛋 2 个 · 绿叶菜 100 g · 牛奶 300 ml', method: '鸡蛋与切碎蔬菜摊熟，卷入全麦饼。', tag: '钙锚点：牛奶' },
    restDinner: { label: '今晚不锻炼', title: '菌菇豆腐鸡丝汤面', ingredients: '荞麦面 50 g · 鸡胸 100 g · 豆腐 150 g · 菌菇青菜 250 g', method: '依次下鸡丝、菌菇、豆腐和面，最后放青菜。', tag: '清冰箱 · 控制面量' },
    workoutDinner: { label: '今晚锻炼', title: '香蕉燕麦酸奶蛋杯', ingredients: '香蕉 1 根 · 燕麦 45 g · 高蛋白酸奶 200 g · 鸡蛋 1 个 · 核桃 10 g', method: '燕麦用热水泡软，拌酸奶和香蕉，配水煮蛋；晚归也能完成。', tag: '免炒菜 · 不是只吃香蕉鸡蛋' },
  },
]

const shoppingGroups = [
  { id: 'calcium', name: '补钙与蛋白', items: [
    ['milk', '纯牛奶', '2–2.5 L'], ['yogurt', '无糖酸奶', '800–1000 g'], ['soy', '高钙无糖豆奶', '2–3 盒（备选）'], ['egg', '鸡蛋', '12–14 个'], ['tofu', '北豆腐/嫩豆腐', '约 1 kg'], ['cheese', '低盐芝士', '1 小包'],
  ]},
  { id: 'meat', name: '肉鱼虾', items: [
    ['chicken', '鸡胸/去皮鸡腿', '约 1 kg'], ['shrimp', '虾仁', '250 g'], ['salmon', '三文鱼', '280 g'], ['bass', '鲈鱼/鱼片', '180 g'], ['beef', '瘦牛肉', '400 g'],
  ]},
  { id: 'veg', name: '蔬菜菌菇', items: [
    ['leafy', '绿叶菜', '约 1.5 kg，分两次买'], ['broccoli', '西兰花', '2 颗'], ['tomato', '番茄', '5–6 个'], ['mushroom', '口蘑/香菇', '约 700 g'], ['cucumber', '黄瓜', '1 根'], ['roots', '南瓜、土豆、红薯、紫薯', '各适量'], ['mixed', '玉米、胡萝卜、彩椒', '各 1–2 份'],
  ]},
  { id: 'staple', name: '主食水果', items: [
    ['oats', '燕麦、小米、杂粮', '各 1 小包'], ['rice', '大米/杂粮米', '约 750 g'], ['noodle', '荞麦面', '1 小包'], ['bread', '全麦吐司、全麦饼', '各 1 包'], ['banana', '香蕉', '4–6 根'], ['fruit', '猕猴桃、橙子、莓果', '按计划购买'],
  ]},
  { id: 'seasoning', name: '基础调味', items: [
    ['oil', '食用油/香油', '少量'], ['soy-sauce', '低盐生抽', '1 瓶'], ['basic', '姜、白胡椒、醋', '适量'], ['starch', '玉米淀粉', '1 小包'], ['nuts', '无糖花生酱、核桃', '各 1 小份'],
  ]},
].map((group) => ({ ...group, items: group.items.map(([id, name, amount]) => ({ id, name, amount })) }))

const plans = [{
  id: 'week-2026-01',
  title: '第一周',
  contentVersion: 1,
  days,
}]

const catalog = {
  schemaVersion: 1,
  contentVersion: 1,
  defaultPlanId: plans[0].id,
  plans,
}

function findPlan(planId) {
  return plans.find((plan) => plan.id === planId) || plans[0]
}

function findDay(plan, dayId, fallbackIndex = 0) {
  return plan.days.find((day) => day.id === dayId) || plan.days[Math.max(0, Math.min(plan.days.length - 1, fallbackIndex))]
}

module.exports = { catalog, plans, days, shoppingGroups, findPlan, findDay }
