# analyze-video —— 视频词级对齐模板

把「一段视频 + 它的文案」变成一份**词级时间戳对齐**的 Hypit 工程。

产出不是成片，而是一张时间表：每个词在第几帧开始、结束。字幕、画面切换、
特效都能据此精确锚定 —— 这是 README 说的「anchored to words instead of seconds」。

实测（2026-10-10，30fps 时钟）：

```
'Welcome'    frame   10 →   25   (0.50s)
'to'         frame   26 →   31   (0.17s)
'Guangzhou'  frame   32 →  159   (4.23s)
```

`Guangzhou` 占 4.2 秒而 `to` 只占 0.17 秒 —— 真实语音韵律，不是按秒平均切。

---

## 快速开始

```bash
cd /opt/hypit/templates/analyze-video

# 1. 放音频/视频
cp /path/to/your.mp4 assets/sample.mp3

# 2. 生成工程（三种给文案的方式，任选）
python3 make-analyze.py --audio assets/sample.mp3 --transcript script.txt
python3 make-analyze.py --audio assets/sample.mp3 --text "第一句。第二句。"
python3 make-analyze.py --audio assets/sample.mp3 --segments "句子一||句子二||句子三"

# 3. 起 runtime
/root/.nvm/versions/node/v22.22.1/bin/node /opt/hypit/bin/hypit.mjs \
    runtime up --runtime ./hypit.runtime.json --project "$PWD"

# 4. 构建
/root/.nvm/versions/node/v22.22.1/bin/node /opt/hypit/bin/hypit.mjs \
    build ./analyze.svrun --runtime ./hypit.runtime.json --json

# 5. 导出词级时间戳
/root/.nvm/versions/node/v22.22.1/bin/node /opt/hypit/bin/hypit.mjs \
    get <build-id> --output seg-1.alignment --to out/seg-1.json
python3 -c "import json;print(json.load(open('out/seg-1.json/value.json'))['value'])"
```

`--dry-run` 只看不落盘。`--fps` 改时钟帧率（默认 30），`--language` 改语言
（`en`/`zh`/`yue`…）。

---

## ⚠️ 三个「不报错但没干活」的坑

这三条全部实测踩过。它们的共同点是**构建都返回 `outcome: complete`、零报错**，
但 WhisperX 一次都没被调用。**验证方法永远是看执行日志里有没有 `whisperx.local`**：

```bash
python3 -c "
import json
for l in open('<build-dir>/execution.jsonl'):
    print(json.loads(l)['endpoint'])"
```

### 1. target 必须指向 alignment 本身

```xml
<target output="seg-1.alignment"/>   <!-- ✅ -->
<target output="narration-media.media"/>   <!-- ❌ 对齐被剪掉 -->
```

引擎按「谁消费谁」做可达性分析。指向 media 时，没有任何东西引用对齐结果，
它就被从计算图里剪掉 —— 构建照样 complete，但 WhisperX 一次都不跑。
实测：target 指 media 时 2 个请求，指 alignment 时 4 个。

### 2. `bindings` 建议绑定 whisperx endpoint

```json
"bindings": { "@hypit/whisperx@1#whisperx-alignment": "whisperx.local" }
```

> **实测更正（2026-10-10 反向验证）**：删掉 `bindings` 后构建**仍然通过**，
> 执行日志里 `whisperx.local` **照样被调用**。即当前版本有 endpoint 名称解析的
> 兜底，bindings 并非必需。
>
> 早先观察到的 `RUNTIME_CREDENTIAL_MISSING (hypihub.default.apiKey)` 实际发生在
> **另一套配置**上 —— 那个 runtime 里只有 `hypihub.default` 一个 endpoint，
> 没有 `whisperx.local`。所以真正的必要条件是
> **「runtime 里存在可用的 whisperx endpoint」**，而不是「有没有写 bindings」。
>
> 保留 bindings 仍然更好：它让路由意图显式，避免将来 endpoint 改名或新增时
> 静默走到别处。但它不是当前跑通的必要条件。

### 3. `media.local` 不能删

`inspect` / `normalize` / **speech-evidence 音频**全由它提供。
只留 `whisperx.local` 会报：

```
align-1:prepare-evidence-audio: no selected Endpoint accepts
  the complete @hypit/speech-evidence@1#project-speech-evidence-audio request
```

---

## runtime.json 三项要求

```json
{
  "endpoints": {
    "media.local":   { "use": "@hypit/media-local" },
    "whisperx.local":{ "use": "@hypit/provider-whisperx-local", "config": { "baseUrl": "http://127.0.0.1:8765", ... } }
  },
  "bindings": { "@hypit/whisperx@1#whisperx-alignment": "whisperx.local" }
}
```

`html.local` 只有出片时才需要，纯对齐分析可以删。

WhisperX 服务跑在 **8765**，CPU 推理：

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8765/   # 404 = 活着
ps aux | grep hypit-whisperx | grep -v grep
```

---

## 多段不同音频

模板默认每段共用一条完整音轨（适合「一整段口播切成几句」）。
若每段有各自的音频切片，用 `Transform` + `Trim`：

```xml
<mediaop:Transform id="seg1-audio">
  <mediaop:Trim start="0s" end="12.5s"/>
</mediaop:Transform>
<mediaop:Normalize id="seg-1-media" source={seg1-audio}
  video="none" audio="default" span-authority="audio" clock={clock}/>
<!-- 该段的 Alignment 改用 media={seg-1-media.media} domain={seg-1-media.domain} -->
```

`Trim` 的 `start`/`end`/`tail` 单位是**秒**（如 `"0.25s"` 或 `"2"`）。

---

## 已知限制

- **每段一份 Alignment。** 段内是词级的，段与段之间没有跨段对齐。
- **时间轴长度**由 Window 链的 `for={narration-media.extent}` 决定，
  多段共用同一音轨时各段等长；真实时长请用上面的 `Transform`/`Trim` 切分。
- **空 Segment 不能写 `media=`。** token 为空时走边界路径，
  属性集是 `["id","narrative","segment","domain"]`（2026-10-04 起）。
  本模板面向「有台词」的视频，故每段都带 `media` 和 `language`。
- 需要 HypiHub 凭据才能走远程 TTS / 文生图那条线（`examples/podcast` 等用得到）；
  **纯本地对齐不需要任何凭据**。

---

## 相关

- 框架仓库 `/opt/hypit`（主 README 有完整能力介绍）
- 词级对齐包 `packages/whisperx`
- 时间轴 `packages/timeline-author`
- 音频切分 `packages/media-operations`（`Transform`/`Trim`/`Normalize`）
- 三个已迁移的成品工程：`examples/{guangzhou,guizou}-clone`、`examples/gz-exbi-en`
  （它们走的是空 segment 路径，固定分段摆画面，**不**做词级对齐）
