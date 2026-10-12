# .pdfimg/ — project.pdf 的图片资源

这个目录**不入库**（见根 `.gitignore`）。图片由 `project.md` 引用、由
`tools/md-to-pdf/md-to-pdf.mjs`（由 `scripts/build-project-pdf.mjs` 调用）内联进 PDF，
因此重建 PDF 必须先有这些文件。

```bash
node scripts/build-project-pdf.mjs   # -> project.pdf
```

脚本在缺图时会报错并列出缺哪一张，不会产出一份静默缺图的 PDF。

## 为什么图片不入库

四张图合计约 2.1MB，其中底图是生成物。`project.pdf` 本身（~2.7MB）已经把
它们全部内联成 data URI，所以从 git 里拿不到图不影响文档的分发。

## 三张成片抽帧

来自本仓库已渲染的成片，用 ffmpeg 在约 45% 处抽单帧，裁成 9:16 竖版。

| 文件 | 来源 | 规格 |
|---|---|---|
| `guangzhou.jpg` | `examples/guangzhou-clone/.hypit/cron-logs/guangzhou-cron-*.mp4` | 132s · 720×1280 |
| `explainer.jpg` | `examples/complex-explainer/productions/explainer/output/final.mp4` | 137s · 1080×1920 |
| `guizou.jpg` | `examples/guizou-clone/output-cpu.mp4` | 362s · 720×1280 |

```bash
ffmpeg -ss 59 -i <src> -frames:v 1 -vf "crop=ih*9/16:ih,scale=900:-1" -q:v 2 guangzhou.jpg
```

成片是 gitignored 的构建产物，所以这个目录同样是机器本地的。换机器时
需要在本地重跑一次渲染，或从别处取得这三张图。

## pipeline.png — 流程示意图（两层合成）

底图由 `agnes-image-2.1-flash` 生成，文字层由 SVG 渲染，两者用 ffmpeg 叠加。

### 底图

```bash
POST https://aikey4k.mengxa.com:8443/v1/images/generations
model: agnes-image-2.1-flash
Authorization: Bearer <~/.claude/settings.json 的 ANTHROPIC_AUTH_TOKEN>
```

提示词要求：暖纸质感、极淡网格、右上琥珀晕染、**中心完全留白、不含任何
文字或图形**。

```bash
ffmpeg -i bg-plate.png -vf "scale=936:1180:force_original_aspect_ratio=increase,crop=936:1180" bg936.png
```

### 文字层

`overlay.svg` 里的卡片是半透明白（`fill-opacity="0.72"`），底图纹理才能透上来。
渲染时需要透明背景：

```bash
chromium --headless --default-background-color=00000000 \
  --screenshot=overlay.png --window-size=936,1180 file://.../overlay.html
```

然后叠加：

```bash
ffmpeg -i bg936.png -i overlay.png -filter_complex "[0:v][1:v]overlay=0:0:format=auto" -frames:v 1 pipeline.png
```

## 为什么文字不交给图像模型

两个文生图模型都试过，中文渲染都不可靠：

| 模型 | 结果 |
|---|---|
| MiniMax 官方 `image-01` | 英文标签全错（`VIRALDIODCI`、`MULI-FORMT RENDER`） |
| `agnes-image-2.1-flash` | 大字中英混排正确，**小字号中文全错**（`投胆薛`、`选题磨`、`拆放孖驫`）；简化成单行大字后错得更厉害（`梢桉官`、`麦桐绩稆`） |

流程图里的每个字都是契约信息（Agent 编号、产物文件名），错字会直接误导读者。
所以分工固定为：**底图交给 AI，文字永远走确定性绘制**。

## 顺带记下的调用坑

- `/opt/babystory/.env` 的 `LLM_BASE_URL` 缺 `:8443`，会 301 重定向
- 同一文件的 `LLM_TOKEN` 已失效（`Invalid token`），但 settings.json 的
  `ANTHROPIC_AUTH_TOKEN` 对图像模型有效