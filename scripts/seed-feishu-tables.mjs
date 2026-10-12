#!/usr/bin/env node
// 播种「热点驱动 · 多平台视频矩阵流水线」在飞书多维表格里的四张作业表。
//
// 为什么是四个 Base 而不是一个 Base 四张表：
// 应用 cli_a93667cd41f99bde 有 bitable 读写权限，能建 Base、建记录、增删字段，
// 但**没有「新建数据表」权限** —— 在一个 Base 里 POST /tables 恒返回
// 1254001 WrongRequestBody（错误码有误导性，实为权限缺失）。
// 一个项目对一个表，所以直接建四个 Base，各用其默认数据表。
//
// 顺带的架构收益：B4 拆解结论 与 B5 重构稿 天然分表，评审者不会在同��行里
// 同时看到原稿台词和改写结果 —— 那正是 B4→B5 原创度隔离要阻断的污染通道。
//
//   node scripts/seed-feishu-tables.mjs           # 只建（已存在则跳过）
//   node scripts/seed-feishu-tables.mjs --json    # 额外打印 app_token 映射
//
// 凭据来自 /root/.claude/settings.json 的 env 块（与 wechat-ledger 同一个应用）。

import { readFileSync } from "node:fs"

const API = "https://open.feishu.cn/open-apis"
const SETTINGS = "/root/.claude/settings.json"

const { FEISHU_APP_ID, FEISHU_APP_SECRET } = JSON.parse(readFileSync(SETTINGS, "utf8")).env
if (!FEISHU_APP_ID || !FEISHU_APP_SECRET) {
  console.error("缺少 FEISHU_APP_ID / FEISHU_APP_SECRET")
  process.exit(1)
}

async function api(path, body, method = "POST") {
  const res = await fetch(API + path, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return res.json()
}

let token = (
  await (
    await fetch(`${API}/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: FEISHU_APP_ID, app_secret: FEISHU_APP_SECRET }),
    })
  ).json()
).tenant_access_token

// 字段类型
const TXT = 1
const NUM = 2
const SINGLE = 3
const MULTI = 4
const DATE = 5
const URL = 15

// DATE 字段的写入值是**毫秒时间戳**，不是 ISO 字符串 —— 传 ISO 会写不进去。

const PLATFORMS = ["抖音", "快手", "视频号", "B站", "YouTube", "小红书", "本地"]
// 素材入料流。授权初值不同：候选池 unknown（B3 无权判定），自有素材 cleared。
const STREAMS = ["候选池", "自有素材"]
// 失败码枚举 —— 对应附录 A 的 failures[]。
// 这些必须是枚举而不是自由文本：「这个候选为什么没了」要能被筛选和统计，
// 埋在 JSON 数组里等于没有答案，然后被重复下载、重复计费。
const FAILURE_CODES = [
  "NO_VIDEO_STREAM", // 下载到的是 HTML 页面或纯音频，不是视频
  "DOWNLOAD_FAILED", // 网络/鉴权失败
  "DUPLICATE", // source_sha256 命中已有素材
  "PROBE_FAILED", // ffprobe 解不出流信息
  "DECODE_ERROR", // 容器可读但解码报错
  "TIMEOUT", // 超时
  "LICENSE_BLOCKED", // 授权状态不允许使用
  "DISK_FULL", // 落盘失败
]
const FAILURE_STAGES = ["download", "probe", "transcode", "index"]

const select = (...names) => ({ property: { options: names.map((name) => ({ name })) } })
const multi = (...names) => ({ property: { options: names.map((name) => ({ name })) } })

const TABLES = [
  {
    name: "选题池",
    primary: "选题",
    fields: [
      ["选题ID", TXT], ["匹配产品", TXT], ["热度分", NUM], ["产品契合分", NUM],
      ["综合分", NUM], ["下游关键词", TXT], ["平台", SINGLE, select(...PLATFORMS)],
      ["参考视频URL", URL], ["入选理由", TXT], ["run_id", TXT],
      ["状态", SINGLE, select("待评审", "已采纳", "已否决")], ["评审备注", TXT],
    ],
  },
  {
    name: "拆解结论",
    primary: "素材ID",
    fields: [
      ["选题ID", TXT], ["视频URL", URL], ["平台", SINGLE, select(...PLATFORMS)],
      ["钩子类型", TXT], ["开场时长秒", NUM], ["节奏曲线", TXT], ["爆点位置", TXT],
      ["字幕样式", TXT], ["镜头调度", TXT], ["原片时长秒", NUM],
      ["拆解JSON路径", TXT], ["是否通过复核", SINGLE, select("待复核", "通过", "重拆")],
    ],
  },
  {
    // 与「拆解结论」分表是刻意的：同表会把原稿台词和改写稿并排放到一行，
    // 破坏 B4→B5 的原创度隔离。
    name: "重构稿",
    primary: "稿次",
    fields: [
      ["拆解引用", TXT], ["选题ID", TXT], ["口播稿", TXT], ["分镜", TXT],
      ["素材映射", TXT], ["目标平台", MULTI, multi(...PLATFORMS)],
      ["工程路径", TXT], ["时长秒", NUM],
      ["原创度自检", SINGLE, select("未检", "通过", "疑似同质")],
      ["状态", SINGLE, select("草稿", "待审", "已批准", "需重写")],
    ],
  },
  {
    name: "成片投放",
    primary: "批次",
    fields: [
      ["工程路径", TXT], ["稿次引用", TXT],
      ["平台", MULTI, multi(...PLATFORMS)], ["成片路径", TXT], ["成片时长秒", NUM],
      ["发布凭据", TXT], ["平台返回ID", TXT], ["发布备注", TXT],
      ["状态", SINGLE, select("待发布", "已发布", "发布失败", "已撤回")],
      ["完成时间", TXT],
    ],
  },

  // ── 素材三件套 ────────────────────────────────────────────────
  // 素材塞不进一行：derivatives 是一对多，failures[] 是顶层数组。
  // 压成单行必然丢信息，所以拆成「台账 / 衍生物 / 失败」三张表。
  {
    // 主字段是 asset_id（内容哈希）而不是人可读标题。
    // 寻址口径 asset_id = sha256(source_sha256 + "\n" + 规范化参数) 是整个
    // 环节唯一不可返工的部分；用标题当主字段会让「同一条素材只有一个身份」
    // 这个不变量被人的命名习惯破坏。
    name: "素材台账",
    primary: "asset_id",
    fields: [
      // 入料与身份
      ["入料流", SINGLE, select(...STREAMS)],
      ["source_sha256", TXT],
      ["norm_version", NUM],
      ["来源URI", TXT], ["平台", SINGLE, select(...PLATFORMS)],
      ["source_ref", TXT], ["run_id", TXT],
      ["ingested_at", DATE],
      // probe —— ffprobe 事实，可复现
      ["duration_ms", NUM], ["width", NUM], ["height", NUM], ["fps", NUM],
      ["vcodec", TXT], ["acodec", TXT], ["sample_rate", NUM],
      ["channels", NUM], ["bitrate", NUM],
      // signals —— 派生启发式，允许随算法升级变化，不参与寻址
      ["has_audio", SINGLE, select("是", "否")],
      ["silence_ratio", NUM], ["avg_luma", NUM], ["sharpness", NUM],
      ["phash", TXT],
      // 授权与标注
      ["license_status", SINGLE, select("cleared", "unknown", "restricted", "pending")],
      ["license_note", TXT],
      // tags 是提示不是承诺：是否采信由 B5 决定
      ["tags", MULTI, multi("产品特写", "室外", "手持", "口播", "空镜", "字幕素材")],
    ],
  },
  {
    // 与「素材台账」是 1:N。独立成表才能查「哪些规格还没转」，
    // 塞进 JSON 字段就查不了。
    name: "素材衍生物",
    primary: "衍生物ID",
    fields: [
      ["asset_id", TXT],          // 外键 -> 素材台账.asset_id
      ["norm_version", NUM],      // 转码口径版本；改口径时据此识别旧产物
      ["规范化参数串", TXT],        // canonical_norm_params，字典序全量
      ["path", TXT], ["bytes", NUM], ["sha256", TXT],
      ["生成时间", DATE],
      // 切片不是衍生物行，而是 asset_id#t=12500-15200 这样的时间区间引用。
      // 建行会让「换分镜不换素材」退化成全量重转。写入方不要在这里造 #t= 行。
      ["切片引用", TXT],
    ],
  },
  {
    name: "入料失败",
    primary: "失败ID",
    fields: [
      ["source_ref", TXT], ["入料流", SINGLE, select(...STREAMS)],
      ["阶段", SINGLE, select(...FAILURE_STAGES)],
      ["失败码", SINGLE, select(...FAILURE_CODES)],
      ["message", TXT], ["uri", TXT], ["run_id", TXT],
      ["发生时间", DATE],
    ],
  },
]

// 已有的 Base 先按名字找出来，避免重复创建。
// 注意：没有 GET /bitable/v1/apps 这个接口（404），只能走云空间文件列表按
// type=bitable 过滤。
const existing = new Map()
let pageToken
let list
do {
  const url = `/drive/v1/files?page_size=200${pageToken ? `&page_token=${pageToken}` : ""}`
  list = await api(url, undefined, "GET")
  if (list.code !== 0) throw new Error(`列出云空间文件失败：${list.msg}`)
  for (const f of list.data.files ?? []) if (f.type === "bitable") existing.set(f.name, f.token)
  pageToken = list.data.next_page_token
} while (list.data.has_more)

const created = {}

for (const spec of TABLES) {
  let appToken = existing.get(spec.name)
  let base = spec.name

  if (!appToken) {
    const r = await api("/bitable/v1/apps", { name: spec.name })
    if (r.code !== 0) throw new Error(`创建「${spec.name}」失败：${r.msg}`)
    appToken = r.data.app.app_token
    console.log(`建「${spec.name}」  ${appToken}`)
  } else {
    console.log(`「${spec.name}」已存在，跳过建表：${appToken}`)
  }

  // 取默认数据表
  const tables = await api(`/bitable/v1/apps/${appToken}/tables?page_size=20`, undefined, "GET")
  let tableId = tables.data.items[0].table_id
  await api(`/bitable/v1/apps/${appToken}/tables/${tableId}`, { name: base }, "PATCH")

  // 读现有字段，清掉预置的四个
  const fields = await api(
    `/bitable/v1/apps/${appToken}/tables/${tableId}/fields?page_size=100`,
    undefined, "GET")
  const have = new Set(fields.data.items.map((f) => f.field_name))
  const primary = fields.data.items.find((f) => f.is_primary)
  for (const f of fields.data.items) {
    if (f.is_primary) continue
    if (!have.has(f.field_name)) continue
    await api(`/bitable/v1/apps/${appToken}/tables/${tableId}/fields/${f.field_id}`, undefined, "DELETE")
  }

  // 主字段改名
  await api(`/bitable/v1/apps/${appToken}/tables/${tableId}/fields/${primary.field_id}`,
    { field_name: spec.primary, type: TXT }, "PUT")

  // 建其余字段
  let ok = 0
  for (const [name, type, extra] of spec.fields) {
    const body = { field_name: name, type }
    if (extra) Object.assign(body, extra)
    const r = await api(`/bitable/v1/apps/${appToken}/tables/${tableId}/fields`, body)
    if (r.code === 0) ok++
    else console.error(`    ! ${name}：${r.msg}`)
  }
  created[spec.name] = { app_token: appToken, table_id: tableId }
  console.log(`   ${spec.name}  ${tableId}  主字段「${spec.primary}」+ ${ok}/${spec.fields.length} 字段`)
}

if (process.argv.includes("--json")) console.log(JSON.stringify(created, null, 2))
else console.log("\n完成。把 app_token 写进 .env 供流水线读取。")