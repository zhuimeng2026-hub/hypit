# hypit-md-to-pdf

Markdown → PDF，headless Chromium 原生 `--print-to-pdf`。

**不属于 npm Distribution。** 和同级的 [`../dub-server`](../dub-server) 一个约定：仓库内的独立
工具，自己管依赖，只跟 git 走。所以 `marked` 由本包的 `package.json` 声明，不进根
`package.json` 的 `dependencies` —— 装 `@hypit/hypit` 的终端用户不会多背一个 markdown 解析器。

```bash
npm install          # 只装 marked
npm run build        # 渲染 ../../project.md -> ../../project.pdf
node md-to-pdf.mjs in.md out.pdf --page-size a4
```

## 为什么不用 make-pdf

make-pdf 内部用 paged.js 分页。paged.js 里 `counter(page)` 只在 `@page` 边距盒的
`content` 中有效，一旦改用 `element()` 把元素搬进去，页码恒为 0，渲染成「第 0 页」。

Chromium 自己的 print 引擎没有这个限制，`@page { @bottom-center { content: "第 "
counter(page) " 页" } }` 直接可用。这也是中文页脚格式能落地的唯一原因。

## 用法

```
node md-to-pdf.mjs <input.md> <output.pdf> [options]

  --page-size a4|letter|legal   纸张，默认 a4
  --title T                     PDF 标题；配合 --cover 作封面主标题
  --author A                    作者；配合 --cover 作封面副标题
  --cover                       首页封面
  --toc                         正文前插入目录
  --style <path>                追加样式，覆盖默认 md-to-pdf.css
  --header-text "..."           页眉文案（每页重复）
  --footer-text "... {page} ..."  页脚文案，{page} 是页码占位符
```

页眉页脚走 CLI 而不是写进 CSS，因为它们是文档专属的；CSS 只管版式几何与边距盒的字体。

## 已知限制

- **目录没有页码。** Chromium 不支持 `target-counter()`，条目可点击（内部锚点）但不带页号。
  也没有 PDF 书签大纲。
- **超高图片不会被自动缩小。** 打印引擎不像浏览器视口那样把超过版心的图缩到一页，靠
  `md-to-pdf.css` 里的 `max-height: var(--content-height)` 约束。
- **snap Chromium 的路径限制很窄。** 这台机器上的 snap 版既不能写 `/tmp` 和
  `~/.cache`，也不能读 `/tmp`（会静默渲染成 16KB 的错误页）。唯一可写的是
  `~/.snap/chromium/common`。渲染器会依次探测候选路径并逐个实印验证 —— AppArmor 按路径
  判定，`access(W_OK)` 检测不出来。非 snap 版 Chromium 会自动走到后面的候选。

## 图片

图片按 base64 data URI 内联进 HTML，相对路径以 markdown 文件所在目录为基准解析。
缺图时直接报错退出并列出缺哪一张，不会产出静默缺图的 PDF。