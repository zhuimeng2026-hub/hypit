#!/usr/bin/env node
// 把 project.md 渲染成 project.pdf。
//
// 渲染本身在 tools/md-to-pdf/（通用 markdown -> PDF，走 Chromium 自带的 print
// 引擎）。那是一个独立小包，不在 npm Distribution 里，marked 由它自己的
// package.json 声明 —— 这样装 @hypit/hypit 的用户不会多背一个 markdown 解析器。
// 这里只保留本文档特有的东西：标题、作者、页眉页脚文案。
//
// 版式出处：「混凝土屋面漏水修缮方案.pdf」。页脚「第 N 页」此前做不出来 ——
// 原来的 make-pdf 走 paged.js，counter(page) 在页脚容器元素里恒为 0；
// Chromium 自己的 print 引擎在 @page 的 @bottom-center 里能直接求值。
//
//   node scripts/build-project-pdf.mjs
//
// 图片缺失时渲染器会报错并列出缺哪一张，而不是产出一份静默缺图的 PDF；
// 重新生成图片的步骤见 project-images.md。

import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { execFileSync } from "node:child_process"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const source = join(repoRoot, "project.md")
const out = join(repoRoot, "project.pdf")
const renderer = join(repoRoot, "tools", "md-to-pdf", "md-to-pdf.mjs")

if (!existsSync(renderer)) {
  console.error(`renderer not found at ${renderer}`)
  process.exit(1)
}

const args = [
  renderer,
  source,
  out,
  "--page-size", "a4",
  "--cover",
  "--toc",
  "--title", "热点驱动 · 多平台视频矩阵流水线",
  "--author", "设计目标",
  "--header-text", "追梦成真 ｜ AI视频智能生产解决方案专家",
  "--footer-text", "第 {page} 页 ｜ 热点驱动 · 多平台视频矩阵流水线 · 系统设计 V1.0",
]

try {
  const stdout = execFileSync(process.execPath, args, { stdio: ["ignore", "pipe", "inherit"] })
  process.stdout.write(stdout)
} catch (error) {
  process.exit(error.status ?? 1)
}