---
title: 渲染器选型
description: 为什么 Hypit 的渲染路径保留 HyperFrames；何时可以并行引入其他渲染器，以及必须放弃哪些特性。
---

Source 描述工作内容。Run 选择 Target。**渲染器（Renderer）** 把编排好的 composition 转成帧与最终媒体文件。本指南说明 Renderer 当前为何留在 HyperFrames，整体替换为 Remotion 或任何 React 帧驱动框架会丢掉什么，以及任何增量扩展应有的形态。

## 决策

Renderer 保留在 HyperFrames。整体迁移到 Remotion 不可行：`useCurrentFrame()` + `<AbsoluteFill>` 模型下没有四个核心渲染合约的等价物。允许**并行**新增 Renderer；但它必须只覆盖 A+B 特性子集，并显式禁用四个 C 类别原语——这些原语依赖 HyperFrames 独有的 per-seek barrier。

## 当前渲染路径

`packages/hyperframes/src/document.ts:701-723` 把编排好的 `Composition` 编译成一段 **vanilla DOM** HTML 字符串：一个 `<div data-composition-id>` 根节点，N 个 `<div class="clip hypit-visual-present" data-start data-duration data-hypit-stack-order>` 子节点，加上三段内嵌脚本：

- `frameAnimationRuntime`（`document.ts:620-660`）监听 `hf-seek` 事件，对 `animation-play-state: paused` 的 CSS keyframes 设置 `animation.currentTime`，采样 `getComputedStyle`，**取消**该 animation，再把采样到的属性写回 inline style。
- `visibilityRuntime`（`document.ts:680-690`）处理 Present 内部子区间的显隐。
- `browserProgramScript`（`packages/hyperframes/src/browser-program.ts:51-93`）调用用户提供的 `(root, data) => render(localFrame)` 逃逸口。

本地 Renderer（`packages/provider-hyperframes-local/src/capture.ts:131-148`）启动 N 个并行 Chrome Headless Shell worker（`152.0.7928.2`，版本钉在 `packages/provider-hyperframes-local/package.json:13`）。每帧流程：dispatch `hf-seek` → await `detail.waitUntil(fn): Promise` → `Page.captureScreenshot` 截 PNG。`waitUntil` barrier 就是 **像素级决定性合约**：字体加载、joined-box 测量、shrink-to-fit 都必须先完成才能采样该帧。`waitUntil` 当前在 text-flow runtime 注册（`packages/hyperframes/src/text.ts:1169-1178`），gate 住 `document.fonts.ready` 与按段落精确字体的布局，Renderer 必须等这些 promise resolve 后才能截图。

Provider 故意传 `forceScreenshot: true` 关掉 `@hyperframes/engine` 自带的 BeginFrame 快速路径，因为那条路没有 `waitUntil` barrier。音频走独立链路：`provider-media-local` 跑 ffmpeg amix，再由 `executeMuxProgramMedia`（`packages/media-execution/src/execute.ts:1234`）把无声 mp4 + WAV 合成最终 mp4。

## Remotion 的真实能力（2026 年末）

| 能力 | 状态 | 备注 |
| --- | --- | --- |
| React 组件 → 帧 | 支持 | `useCurrentFrame()` + `<AbsoluteFill>` + `<Sequence>` |
| GSAP 集成 | 支持 | `@remotion/gsap`——paused timeline + `useCurrentFrame` seek；**禁止**：`play/seek/onUpdate/Math.random()` |
| Lottie | 支持 | `@remotion/lottie` + `lottie-web`（开源，无需 LottieFiles 付费授权） |
| Three.js / R3F | 支持 | `@remotion/three`；必须用 `useCurrentFrame()`，不能用 R3F 的 `useFrame()` |
| 字幕 + 转写 | 支持 | `@remotion/captions` + whisper-cpp / elevenlabs / openai-whisper 接入 |
| CSS `@keyframes` | 不推荐 | Remotion 文档明确警告会闪烁；只支持 `useCurrentFrame` 驱动 |
| WAAPI | 不支持 | 没有官方集成；无文档 |
| 任意 HTML drop-in | 不支持 | `<IFrame>` 仅用于静态或 `useCurrentFrame` 驱动内容；`<HtmlInCanvas>` 实验性，需 Chrome ≥ 149 |

规模化：`@remotion/lambda`（每区域 1000 并发执行），本地默认并发 `CPU/2`，可用 `npx remotion benchmark` 调优。

## 特性 × 兼容性分类

把编排好的 `Composition` 特性按假定的 React 渲染器分四类：

| 类别 | 占比 | 含义 | 示例 |
| --- | --- | --- | --- |
| **A** 直接映射 | ~40% | `useCurrentFrame()` + inline style 即可驱动的样式化 DOM | 简单 `<img>`/`<video>`/`<div>`、`<audio>` 片段、visibility 子区间、stacking 排序 |
| **B** 需要适配 | ~35% | 需 `useEffect` 包装、手动测量或种子 RNG | fine-caption 动效 / media edge-sustain-handoff 的 GSAP timeline、joined-box outline、shrink-to-fit、ellipsis 折行检测、path text upright 旋转、per-word LCG 序列 |
| **C** 不兼容 | ~15% | 渲染合约根本不同 | per-seek barrier、paused CSS seek-and-cancel、`VisualProgramElement` 用户逃逸口、源帧率 video slot 注入 |
| **D** 不在渲染路径 | ~10% | 在 Renderer 上游以 `BlobRef` 形式产出 | 图片生成、TTS、whisperx 对齐、`image-compose`、`image-transform`、`semantic-take-adjust` |

## 四个 C 类别阻塞点

这四个合约决定了 Remotion 不能整体迁移。它们也是 HyperFrames 与纯 ffmpeg / Remotion / Lottie 渲染器竞争的核心差异。

### 1. `hf-seek` + `waitUntil(fn): Promise` 每帧 barrier

参考实现见 `packages/hyperframes/src/text.ts:1169-1178`，协议由 Renderer 侧每帧 dispatch。`hf-seek` 事件携带 `detail.waitUntil(fn): Promise`；只有该 promise resolve 之后才截图。Remotion 最接近的机制是 `delayRender()` / `continueRender()`，但它是**每渲染一次**，不是 per-seek 事件驱动。

### 2. Paused-CSS-keyframe seek + computed-style 采样 + 取消 + inline-style 重写

`packages/hyperframes/src/document.ts:259-273` 和 `:620-660`。运行时先暂停 CSS keyframe 动画，按 `currentTime` seek，读 `getComputedStyle`，取消该 animation，再把采样到的属性值写回 inline style。这保证 seek 决定性、避免 compositor 缓存。`@remotion/gsap` **只对 GSAP timeline** 做这件事，不覆盖作者写的任意 CSS keyframe。Remotion 文档明确警告 CSS 动画会在渲染时闪烁。

### 3. `VisualProgramElement` 的任意 `(root, data) => render(localFrame)`

`packages/hyperframes/src/browser-program.ts:51-93`。这是用户自写的逃逸口，每帧在 DOM 根上跑任意函数。除非用户改写成 React 组件，否则没有 React 等价物。这个逃逸口的翻译规则属于作者侧问题，不是渲染器问题。

### 4. 源帧率 video slot 注入 + ffmpeg 预抽 PNG

`packages/hyperframes/src/document.ts:381-407`，由 `@hyperframes/engine` 的 `FrameLookupTable` 喂数据。对非 1:1 源/目标速率映射和 hold frame，Renderer 用 ffmpeg 把源视频解码成 PNG 序列，页面渲染一系列 `<video data-hypit-source-rate="N/D" data-hypit-source-frame="M">` 片段——每个循环边界或 hold 目标帧一段。Remotion 的 `<OffthreadVideo>` 只播单个源文件，无法表达 "把一段作品片段拆成 N 个源帧率片段，每段播一张静态 PNG"。

## 可行的增量路径

### 路径 1 — 留在 HyperFrames（默认）

Renderer 保持现状。四个 C 类别原语是与纯 ffmpeg / Remotion / Lottie 渲染器的差异化竞争力；丢掉它们等于降级。当没有具体痛点指向 React 时推荐这条路。

### 路径 2 — 并行新增 `packages/render-remotion/`

新增并行 Renderer，消费编排好的 `Composition` 并产出 React 组件树。`.svrun` 通过 `runtime: "remotion"` 选择 Renderer；现有 HyperFrames Renderer 仍是默认。规模：3–5 个新包，2–4 人月。C 类别特性对 Remotion 渲染作品**显式禁用**；validation 层（`packages/composition/src/track.ts:1392-1412` 风格的断言）在 `runtime: "remotion"` 下遇到不支持的特性时给出明确错误。音频混流复用 `provider-media-local`。

### 路径 3 — Remotion 用于窄场景交付

Remotion 用于静态或模板化产物（单帧图像、无 `VisualProgram` 且无非 1:1 速率映射的字幕片、模板化产品视频）。Studio 全功能路径仍走 HyperFrames。PoC 约 1 人月。

## 许可证

Remotion **不是** MIT/OSS 协议，是自定义专有协议。

| 组织类型 | 许可证 |
| --- | --- |
| 个人、非营利、≤ 3 人公司 | 免费 |
| > 3 人营利公司 | **付费**——$25/seat·月（Creators）**或** $0.01/render + $100/月最低（Automators）；Enterprise $500+/月 |

免费许可覆盖 **Hypit 编译器从项目 `.svml` / `.svrun` 生成的代码**（代用户的 LLM 生成代码）。**不**覆盖代用户渲染用户自己提供的 React 组件。因此路径 2 只在 React 树由 Hypit 编译器生成时才合规；如果允许用户上传 `.tsx` 让 Hypit 渲染，则需购买付费许可证。如果 `runtime: "remotion"` 计划接受用户自写 `.tsx`，需要提前规划。

## 参考

- `packages/hyperframes/src/document.ts:701-723` — composition HTML 发射
- `packages/hyperframes/src/document.ts:259-273, 620-660` — paused-CSS seek + computed-style 采样 + 取消 + inline-style 重写
- `packages/hyperframes/src/text.ts:1169-1178` — `hf-seek` 监听器与 `waitUntil(fn): Promise`（每帧 barrier）
- `packages/hyperframes/src/browser-program.ts:51-93` — `VisualProgramElement` 逃逸口
- `packages/provider-hyperframes-local/src/capture.ts:131-148` — Renderer 主循环
- `packages/provider-hyperframes-local/src/render.ts:76-128` — `renderHyperframesVisual` 入口
- `packages/provider-hyperframes-local/package.json:13` — Chrome Headless Shell 版本钉
- `packages/media-execution/src/execute.ts:1234` — `executeMuxProgramMedia`（最终 mp4 混流）
- `packages/composition/src/track.ts:1392-1412` — composition 校验器（stacking-key 冲突）
- [代码规范](./conventions.md) — wire 数据与模块边界
- [运行时](./runtime.md) — 选择 Runtime Profile 与 Provider Endpoint
- [Models and Providers](./providers.md) — 何时新增 Provider 是正确的改动