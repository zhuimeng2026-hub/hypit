#!/usr/bin/env node
// markdown -> PDF，直接走 Chromium 自己的 print 引擎（--print-to-pdf）。
//
// 为什么不用 make-pdf：它内部用 paged.js 分页，而 paged.js 里
// counter(page) 只在 @page 边距盒的 content 中可求值，页脚容器元素里的
// counter(page) 恒为 0 —— 所以中文「第 N 页」在 paged.js 里做不出来。
// Chromium 的 print 引擎没有这个限制，@bottom-center 里 counter(page) 直接可用。
//
//   node tools/md-to-pdf/md-to-pdf.mjs in.md out.pdf [选项]
//
// 选项：
//   --page-size a4|letter|legal   纸张，默认 a4
//   --title T                     PDF 标题元数据；配合 --cover 作封面主标题
//   --author A                    作者元数据；配合 --cover 作封面副标题
//   --cover                       首页封面
//   --toc                         在正文前插入目录（无页码，见下方说明）
//   --style <path>                追加样式（覆盖默认 md-to-pdf.css）
//   --header-text T               页眉文字，居中
//   --footer-text T               页脚文字，居中；其中 {page} 替换为页码
//   --margin <css>                覆盖 @page margin，如 "20mm 18mm"
//   --chromium <path>             Chromium 可执行文件，默认 /snap/bin/chromium
//   --keep-html <path>            保留生成的中间 HTML，便于排查
//   -h, --help
//
// 已知环境事实（不要重新踩坑）：
//   · Chromium 的 print 默认带页眉页脚，必须 --no-pdf-header-footer，
//     否则会注入自己的日期/URL/标题。
//   · snap 版的 chromium 受 AppArmor 限制：既不能写 /tmp，也不能读 /tmp，
//     连 $HOME 根目录下的 .cache 都不行。中间 HTML 与输出 PDF 必须放在
//     snap 的可写目录里（~/.snap 或 $SNAP_USER_COMMON）。下面的
//     resolveScratchRoot() 靠一次真实打印来探测哪个目录可用。
//   · 图片必须内联成 data URI，相对 src 在打印时不会解析。

import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_CSS = join(HERE, "md-to-pdf.css")
const DEFAULT_CHROMIUM = "/snap/bin/chromium"

const USAGE = `usage: node tools/md-to-pdf/md-to-pdf.mjs <input.md> <output.pdf> [options]

  --page-size a4|letter|legal   纸张，默认 a4
  --title T                     PDF 标题；配合 --cover 作封面主标题
  --author A                    作者；配合 --cover 作封面副标题
  --cover                       首页封面
  --toc                         正文前插入目录
  --style <path>                追加样式，覆盖默认 md-to-pdf.css
  --header-text T               页眉文字（居中）
  --footer-text T               页脚文字（居中），{page} 为页码占位
  --margin <css>                覆盖 @page margin
  --chromium <path>             Chromium 可执行文件，默认 ${DEFAULT_CHROMIUM}
  --keep-html <path>            保留中间 HTML
  -h, --help`

// ---------- CLI ----------

const FLAGS = new Set([
  "--page-size",
  "--title",
  "--author",
  "--style",
  "--header-text",
  "--footer-text",
  "--margin",
  "--chromium",
  "--keep-html",
])
const BOOLEANS = new Set(["--cover", "--toc"])

function parseArgs(argv) {
  const opts = {
    input: undefined,
    output: undefined,
    pageSize: "a4",
    title: undefined,
    author: undefined,
    cover: false,
    toc: false,
    style: [],
    headerText: undefined,
    footerText: undefined,
    margin: undefined,
    chromium: process.env.CHROMIUM_BIN ?? DEFAULT_CHROMIUM,
    keepHtml: undefined,
  }
  const positional = []

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "-h" || arg === "--help") {
      console.log(USAGE)
      process.exit(0)
    }
    if (BOOLEANS.has(arg)) {
      if (arg === "--cover") opts.cover = true
      else opts.toc = true
      continue
    }
    if (FLAGS.has(arg)) {
      const value = argv[++i]
      if (value === undefined) fail(`选项 ${arg} 缺少取值`)
      switch (arg) {
        case "--page-size": opts.pageSize = value; break
        case "--title": opts.title = value; break
        case "--author": opts.author = value; break
        case "--style": opts.style.push(value); break
        case "--header-text": opts.headerText = value; break
        case "--footer-text": opts.footerText = value; break
        case "--margin": opts.margin = value; break
        case "--chromium": opts.chromium = value; break
        case "--keep-html": opts.keepHtml = value; break
      }
      continue
    }
    if (arg.startsWith("--")) fail(`未知选项 ${arg}`)
    positional.push(arg)
  }

  if (positional.length < 2) {
    console.error(USAGE)
    process.exit(2)
  }
  if (positional.length > 2) fail(`多余的位置参数: ${positional.slice(2).join(" ")}`)
  ;[opts.input, opts.output] = positional
  return opts
}

function fail(message) {
  console.error(`md-to-pdf: ${message}`)
  process.exit(1)
}

// ---------- markdown -> HTML ----------

async function loadMarkdownConverter() {
  try {
    return (await import("marked")).marked
  } catch (error) {
    fail(
      "找不到 markdown 转换器 marked。请在仓库根安装它：pnpm add -w -D marked\n" +
        `  (${error.message})`,
    )
  }
}

// 头尾的空白与换行在 CSS content 字符串里没有意义，统一压成单空格。
function cssString(value) {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\s+/g, " ")}"`
}

// 把页眉页脚渲染成 @page 边距盒。这是整个脚本存在的理由：Chromium 的
// print 引擎在这里求值 counter(page)，paged.js 做不到。
function pageMarginBoxes({ headerText, footerText }) {
  const boxes = []
  if (headerText) {
    boxes.push(`@top-center {
      content: ${cssString(headerText)};
      font-family: "Noto Serif CJK SC", "Songti SC", "SimSun", serif;
      font-size: 8.5pt;
      color: #6b6862;
      text-align: center;
      vertical-align: bottom;
      padding-bottom: 4pt;
      border-bottom: 0.6pt solid #b5b0a8;
      width: 100%;
    }`)
  }
  if (footerText) {
    // {page} 是页码占位符，其余文字原样进入 content。
    // 必须切成「引号字符串 / counter(page) / 引号字符串」三段，
    // 整串再套一对引号是不合法的 CSS（counter() 不是字符串字面量的一部分）。
    const content = footerText
      .split("{page}")
      .map(cssString)
      .join(' counter(page) ')
    boxes.push(`@bottom-center {
      content: ${content};
      font-family: "Noto Serif CJK SC", "Songti SC", "SimSun", serif;
      font-size: 8.5pt;
      color: #6b6862;
      text-align: center;
      vertical-align: top;
      padding-top: 4pt;
      border-top: 0.6pt solid #b5b0a8;
      width: 100%;
    }`)
  }
  if (boxes.length === 0) return ""
  return `@page { ${boxes.join("\n  ")} }`
}

function coverHtml({ title, author }) {
  if (!title) return ""
  const body = [`<h1 class="cover-title">${escapeHtml(title)}</h1>`]
  if (author) body.push(`<p class="cover-subtitle">${escapeHtml(author)}</p>`)
  const date = `<p class="cover-meta">${escapeHtml(new Date().toISOString().slice(0, 10))}</p>`
  return `<section class="cover">
<div class="cover-body">
${body.join("\n")}
</div>
${date}
</section>`
}

// 目录。Chromium 不支持 target-counter()，所以没有页码；
// 锚点是文档内跳转，导出 PDF 后依然可点。
// 返回 { toc, body } —— 正文只保留注入了 id 的版本，目录本身单独交给调用方。
function buildToc(html, depth) {
  const entries = []
  const body = html.replace(
    /<h([1-6])([^>]*)>([\s\S]*?)<\/h\1>/g,
    (match, level, attrs, inner) => {
      if (Number(level) > depth) return match
      const id = `sec-${entries.length + 1}`
      entries.push({ level: Number(level), text: stripTags(inner), id })
      return `<h${level}${attrs} id="${id}">${inner}</h${level}>`
    },
  )
  if (entries.length === 0) return { toc: "", body }
  const list = entries
    .map((entry) => `<li class="toc-h${entry.level}"><a href="#${entry.id}">${entry.text}</a></li>`)
    .join("\n")
  const toc = `<nav class="toc">\n<h2 class="toc-title">目录</h2>\n<ol>\n${list}\n</ol>\n</nav>`
  return { toc, body }
}

function stripTags(html) {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .trim()
}

function escapeHtml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

// ---------- 图片内联 ----------

// 打印时相对 src 不解析（file:// 相对路径在 snap 沙箱里尤其不可靠），
// 所以全部换成 data URI。缺图必须报错，而不是产出一份静默缺图的 PDF。
function inlineImages(html, baseDir) {
  const missing = []
  const unsupported = []

  const out = html.replace(/<img\b[^>]*>/gi, (tag) => {
    const srcMatch = /\bsrc\s*=\s*"([^"]*)"/i.exec(tag)
    if (!srcMatch) return tag
    const src = srcMatch[1]
    if (/^(data:|https?:|file:|\/\/)/i.test(src)) return tag

    const abs = isAbsolute(src) ? src : resolve(baseDir, src)
    if (!existsSync(abs)) {
      missing.push(src)
      return tag
    }
    const mime = sniffMime(abs)
    if (!mime) {
      unsupported.push(src)
      return tag
    }
    const data = readFileSync(abs).toString("base64")
    return tag.replace(srcMatch[0], `src="data:${mime};base64,${data}"`)
  })

  if (missing.length > 0 || unsupported.length > 0) {
    console.error("md-to-pdf: 图片无法内联：")
    for (const path of missing) console.error(`  缺失: ${path}`)
    for (const path of unsupported) console.error(`  不支持的图片类型: ${path}`)
    process.exit(1)
  }
  return out
}

// 按魔数判断，扩展名只作兜底 —— 换个扩展名的图片也能正确嵌入。
function sniffMime(path) {
  let head
  try {
    const fd = readFileSync(path)
    head = fd.subarray(0, 16)
    if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) {
      return "image/png"
    }
    if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg"
    if (head.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif"
    if (
      head.subarray(0, 4).toString("latin1") === "RIFF" &&
      head.subarray(8, 12).toString("latin1") === "WEBP"
    ) {
      return "image/webp"
    }
    const text = fd.toString("utf8", 0, 512).trimStart()
    if (text.startsWith("<svg") || (text.startsWith("<?xml") && text.includes("<svg"))) {
      return "image/svg+xml"
    }
  } catch {
    // 读不了就落到扩展名
  }
  const ext = path.split(".").pop()?.toLowerCase()
  return { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml" }[ext]
}

// ---------- HTML 组装 ----------

function buildHtml({ body, toc, opts }) {
  const css = [readFileSync(DEFAULT_CSS, "utf8")]
  for (const path of opts.style) css.push(`/* ${path} */\n${readFileSync(path, "utf8")}`)

  // 生成的 @page 覆盖默认纸张与页边距，并追加页眉页脚边距盒。
  const page = [`@page { size: ${opts.pageSize.toUpperCase()};`]
  page.push(`margin: ${opts.margin ?? "22mm 18mm 20mm"};`)
  page.push("}")
  const boxes = pageMarginBoxes(opts)
  if (boxes) page.push(boxes)
  // 封面走命名页，页眉页脚清空。用 @page :first 不行 —— 没有 --cover 时
  // 正文第一页也会被一起清掉。
  if (opts.cover) {
    page.push(`@page cover {
      margin: ${opts.margin ?? "22mm 18mm 20mm"};
      @top-center { content: none; }
      @bottom-center { content: none; }
    }`)
  }
  css.push(page.join(" "))
  // 图片的版心高度上限，与上面默认的上下页边距配套（A4 297 - 22 - 20 = 255，
  // 留 10mm 余量）。改了 --margin 就用 --style 把它一起覆盖掉。
  css.push(":root { --content-height: 245mm; }")

  const meta = [
    `<meta charset="utf-8">`,
    `<title>${escapeHtml(opts.title ?? "")}</title>`,
    opts.author ? `<meta name="author" content="${escapeHtml(opts.author)}">` : "",
  ]
    .filter(Boolean)
    .join("\n  ")

  const content = [opts.cover ? coverHtml(opts) : "", toc, body]
    .filter(Boolean)
    .join("\n\n")

  return `<!doctype html>
<html lang="zh-CN">
<head>
  ${meta}
  <style>
${css.join("\n\n")}
  </style>
</head>
<body>
${content}
</body>
</html>
`
}

// ---------- Chromium ----------

// snap 沙箱可写目录探测。候选按「最可能可用」排序；每个候选都做一次真实
// 打印，写不出 PDF 就换下一个 —— AppArmor 的限制是路径级的，文件系统权限
// 检查（existsSync/access）探测不到。
function scratchCandidates() {
  const home = process.env.HOME ?? homedir()
  return [
    process.env.MD2PDF_SCRATCH,
    process.env.SNAP_USER_COMMON,
    home ? join(home, "snap", "chromium", "common") : undefined,
    process.env.XDG_RUNTIME_DIR ? join(process.env.XDG_RUNTIME_DIR, "md-to-pdf") : undefined,
    home ? join(home, ".cache", "md-to-pdf") : undefined,
    process.cwd(),
  ].filter((path, index, all) => path && all.indexOf(path) === index)
}

function runChromium(chromium, htmlPath, pdfPath) {
  execFileSync(
    chromium,
    [
      "--no-sandbox",
      "--headless",
      "--disable-gpu",
      // 不传这个，Chromium 会往每页注入自己的日期/URL/标题
      "--no-pdf-header-footer",
      "--virtual-time-budget=10000",
      `--print-to-pdf=${pdfPath}`,
      pathToFileURL(htmlPath).href,
    ],
    { stdio: ["ignore", "pipe", "pipe"], timeout: 180_000 },
  )
  return existsSync(pdfPath) && statSync(pdfPath).size > 0
}

function render(opts, html) {
  const tried = []
  for (const root of scratchCandidates()) {
    let scratch
    try {
      scratch = mkdtempSync(join(root, "md-to-pdf-"))
    } catch {
      tried.push(`${root} (不可创建目录)`)
      continue
    }
    const htmlPath = join(scratch, "doc.html")
    const pdfPath = join(scratch, "doc.pdf")
    try {
      writeFileSync(htmlPath, html)
      if (runChromium(opts.chromium, htmlPath, pdfPath)) {
        writeFileSync(opts.output, readFileSync(pdfPath))
        return
      }
      tried.push(`${root} (chromium 无法写入)`)
    } catch (error) {
      tried.push(`${root} (${error.message.split("\n")[0]})`)
    } finally {
      if (opts.keepHtml) writeFileSync(opts.keepHtml, html)
      rmSync(scratch, { recursive: true, force: true })
    }
  }
  fail(
    `chromium 在所有候选目录都写不出 PDF。已尝试：\n  ${tried.join("\n  ")}\n` +
      "若用 snap 版 chromium，中间文件必须落在 snap 的可写目录里；" +
      "也可用 MD2PDF_SCRATCH 指定一个目录。",
  )
}

// ---------- main ----------

const opts = parseArgs(process.argv.slice(2))
if (!existsSync(opts.chromium)) fail(`找不到 chromium：${opts.chromium}`)
if (!existsSync(opts.input)) fail(`找不到输入文件：${opts.input}`)

const marked = await loadMarkdownConverter()
const markdown = readFileSync(opts.input, "utf8")

let body = marked.parse(markdown, { gfm: true, breaks: false })
body = inlineImages(body, dirname(resolve(opts.input)))

let toc = ""
if (opts.toc) {
  const built = buildToc(body, 3)
  toc = built.toc
  body = built.body
}

render(opts, buildHtml({ body, toc, opts }))
console.log(resolve(opts.output))