# Hypit × Guizhou clone — status snapshot

Captured 2026-09-25 end-of-session. Re-analyse tomorrow after the
Hailuo 2.3 video angle is checked.

## What we built

```
examples/guizou-clone/
├── guizou.svml                  # 11 take slots, media-track + audio-track + film
├── guizou.svrun                 # target=final.video
├── guizou.svs                   # recipes.media.cover-* + film.vertical
├── hypit.runtime.json           # media.local + hyperframes.local + whisperx.local
├── listicle-video.py            # ⭐ standalone, no-Hypit CPU build
├── build-cpu.sh                 # thin wrapper over listicle-video.py
├── cron-build.sh                # crond wrapper for tomorrow 01:00
├── assets/
│   ├── presenter.png            # agnes-image-2.5-flash, 720x1280
│   ├── presenter-minimax.png    # MiniMax image-01, 720x1280
│   ├── narration.mp3            # edge-tts en-US-GuyNeural, 138s, 11 spots
│   ├── cover-bg.jpg             # clean ginkgo frame from reference
│   └── broll/spot-{01..10}-*.mp4  # 35s each, re-extracted WITH audio
│       + outro-city.mp4 (22s)
```

Two reference videos were studied:

- `source` = `/opt/OpenMontage_Voicebox/data/guizou.mp4`
  (720×1280, 29 fps, 417s, H.264+AAC, Chinese narration, 10 spots + outro)
- 10 spots by on-screen pin label: Zhenshan / Longli / Guilan /
  Zengchong / Suoga Long-horn Miao / Shitouzhai / Gaodang / Jiacha
  / Aile / Shimenkan.

## What works

| Stage | Status | Note |
|---|---|---|
| Reference analysis (frame sampling, pin extraction) | ✅ | 21 frames at 20s intervals |
| WhisperX word-level alignment on source audio | ✅ | `127.0.0.1:8765`, model=small, lang=en |
| B-roll slice from source (ffmpeg, both with and without audio) | ✅ | 11 clips, 720×1280 forced |
| Image generation (MiniMax image-01) | ✅ | 16-27s per image, `/opt/hypit/.env` |
| Image generation (agnes-image-2.5-flash fallback) | ✅ | OpenAI-compat, `apihub.agnes-ai.com` |
| TTS (edge-tts en-US-GuyNeural) | ✅ | 138s narration, 11 spots |
| SVML compile (`hypit check`) | ✅ | 31 outputs |
| Plan (`hypit plan`) | ✅ | 49 requests, **all local**, zero Provider charge |
| WhisperX → SemanticTake → Timeline → media-track pipeline | ✅ | Builds 4, 5 went all 47/49 steps |
| B-roll decode (ffmpeg inside Hypit) | ✅ | 3500+ / 3720 frames |
| **CPU-only ffmpeg build (`listicle-video.py` / `build-cpu.sh`)** | ✅ | `output-cpu.mp4` 720×1280, 6:02, 200 MB |
| HyperFrames render-visual | ❌ | frame 0 timeouts at 180s protocol limit |

## What's blocked and why

HyperFrames 走的是 "headless Chrome 渲染 HTML/SVG → 截屏 → ffmpeg 压片" 这条链。
本机在这条链上卡死：

1. **没有真 GPU。** `nvidia-smi` 不存在；Chrome 自报 `WebGL renderer="ANGLE (AMD, RENOIR, ...)"`，
   这是 ANGLE 的 CPU 软件光栅后端（LLVM），不是硬件加速。
2. **Chrome `protocolTimeout` 没有暴露给 Provider config。** 错误
   `Runtime.callFunctionOn timed out` 是 Puppeteer CDP 协议层超时，发生在我们设的
   `frameTimeoutMs` 之前。本机软件渲染 frame 0 慢，180s 内拿不到第一张截图，CDP 直接断。
   Provider 配置只暴露 `initializationTimeoutMs / frameTimeoutMs / processTimeoutMs`，
   没有 `protocolTimeout` —— 改这个需要碰
   `packages/provider-hyperframes-local/src/capture.ts:172` 的
   `engine.createCaptureSession(...)` 调用，向 producer 模块传
   `{ protocolTimeout: 600000 }`。
3. **架构上，浏览器渲染就是错的范式。** 即便修了 CDP 超时，软件 CPU 光栅在 720×1280
   30 fps 下仍然慢得不能接受 —— 11160 帧 × ~30s/帧 = ~3.5 天。结构性解法是给
   HyperFrames 加非浏览器渲染后端（ffmpeg + Cairo/Skia）。

## What the standalone script (`listicle-video.py`) actually delivers

它**绕开** HyperFrames，做的是「切片 + 配音器」：

```
ffmpeg scale 720x1280 + pad → concat (Demuxer, stream copy) → mux narration (afade)
```

结果：原片的视觉系统（红定位针 + 中文字幕）**直接被原样保留**，音轨换成英文。

- ✓ 出片 `output-cpu.mp4` 已生成并 push（commit `b955c0a1`）
- ✗ 不能在视频帧上重画新元素（pin/字幕/presenter）
- ✗ 不能做帧级合成或转场动效

要做视觉重制那一层，得用 ffmpeg `drawtext` 烧英文字幕 + `overlay` 叠 presenter，
或者回到 Hypit + 真正的 GPU。

## Constraints

- **只走 MiniMax 直接接口，不走 Kapon 代理或其他网关层。** `.env` 里的
  `KAPON_VIDEO_BASE_URL` / `KAPON_VIDEO_MODEL_DEFAULT` 配置即便可用也不动；
  任何视频/图像/语音生成请求都打 `https://api.minimaxi.com/...` 或
  `https://api.minimax.cn/...`，Bearer `MINIMAX_API_KEY`，避免配额/路由绕道。

## Untouched resources that might unlock more

- **`/opt/OpenMontage_Voicebox/.env` 里的 `MINIMAX_API_KEY`**（和 `/opt/hypit/.env` 同把）
  经实测 MiniMax `image-01` 现在确实可用（之前 1004 是瞬时问题），
  `presenter-minimax.png` 已生成。
- **MiniMax `hailuo-2.3`（你提到的 hl2.3）**—— OpenMontage 的
  `tools/video/minimax_video.py` 已经直接接好了 `hailuo-2.3-fast/pro`、
  `hailuo-2.3-fast/standard`。⚠️ 注意：`/opt/OpenMontage_Voicebox/.agents/skills/minimax/SKILL.md:123`
  提到安全层会"soften"（柔化）输出，且每次重试消耗 1 quota cycle；OpenMontage 项目里
  出现过 `hailuo-2.3-quota-2067` 事故（Token Plan 配额用尽，HTTP 2067）。
  对策：先 `hailuo-2.3-fast/standard` 跑单条 smoke（~$0.08）验证当前配额还活着，再批量。

## Tomorrow's plan

1. 看 cron 自动跑的结果（`/tmp/guizou-cron-build.log`），
   确认 `Hypit × 浏览器渲染` 这条主线是不是还卡在 frame 0。
2. 如果还卡：决定是
   (a) 给 `provider-hyperframes-local` 加 `protocolTimeout` 暴露（10 行代码），
   (b) 把 hl2.3 文生视频作为 A-roll 替代浏览器合成（直接打
   `https://api.minimaxi.com/v1/video_generation`，走 `MINIMAX_API_KEY`），
   (c) 或者把 presenter overlay（用 `presenter-minimax.png`）和英文字幕
   烧进 `listicle-video.py`，让它也能做视觉重制（仍只调 MiniMax 直连）。