#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把「一段视频 + 它的文案」变成一份可构建的 Hypit 对齐工程。

生成 analyze.svml（词级对齐工程）+ analyze.svrun（运行入口）。

用法
----
  # 从文本文件读文案，按句切段
  python3 make-analyze.py --audio assets/sample.mp3 --transcript script.txt

  # 直接给文案字符串
  python3 make-analyze.py --audio assets/sample.mp3 --text "第一句。第二句。"

  # 逐句自己切（--segments 用 || 分隔，与工程里的 Token 分隔符一致）
  python3 make-analyze.py --audio assets/sample.mp3 --segments "句子一||句子二||句子三"

  # 只看会生成什么，不落盘
  python3 make-analyze.py --audio assets/sample.mp3 --text "a. b." --dry-run

产物
----
  analyze.svml  —— <script>（分段口播）+ <whisperx:Alignment>（每段一个）
                    + <time:Timeline>（按顺序排布的 Window 链）
  analyze.svrun —— target 指向第一个 Alignment 的 .alignment 导出

⚠️ 三条踩过的坑，改这个脚本前务必读完（都是「不报错但没干活」的类型）：

1) **target 必须指向 alignment 本身**（如 `seg-1.alignment`），不能指向
   narration-media.media 或任何中间产物。指向别的东西时，引擎会认为对齐结果
   无人消费，**直接把它从计算图里剪掉** —— 构建照样 outcome: complete、
   零报错，但 whisperx.local 一次都不会被调用。
   （2026-10-10 实测：target 指向 media 时 2 个请求；指向 alignment 后 4 个。）

2) **runtime.json 里必须存在可用的 whisperx endpoint**
   （`whisperx.local` -> `@hypit/provider-whisperx-local`）。
   实测：`bindings` 并非必需，删掉后仍会正确路由到 whisperx.local；
   早先遇到的 RUNTIME_CREDENTIAL_MISSING 是因为那份 runtime 里
   只有 hypihub.default、根本没有 whisperx endpoint。
   保留 bindings 仍是好习惯（让路由意图显式），但真正必要的是 endpoint 存在。

3) **media.local endpoint 不能删**。inspect / normalize / speech-evidence
   音频全由它提供，只留 whisperx.local 会报
   "no selected Endpoint accepts ... speech-evidence-audio"。

另外：每段的 Alignment 必须带 `language=`（有台词时），且空 Segment
（tokenStart == tokenEndExclusive）**不允许写 media=** —— 那是给纯静帧
场景走的另一条边界路径。本模板面向「有台词」的视频，故每段都带 media。
"""
import argparse
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
NODE = "/root/.nvm/versions/node/v22.22.1/bin/node"
HYPIT = "/opt/hypit/bin/hypit.mjs"

# 语言代码 -> WhisperX 要求的两位/三位小写码
LANG_CODES = {"zh": "zh", "en": "en", "yue": "yue", "ja": "ja", "ko": "ko"}


def split_segments(args):
    """把文案切成若干段。优先用 --segments，其次 --text 自动切句。"""
    if args.segments:
        return [s.strip() for s in args.segments.split("||") if s.strip()]
    text = args.text
    if not text and args.transcript:
        if not os.path.exists(args.transcript):
            sys.exit("读不到 transcript 文件: %s" % args.transcript)
        text = open(args.transcript, encoding="utf-8").read()
    if not text:
        sys.exit("需要 --text / --transcript / --segments 之一")
    # 中英文混排的按句切；保留标点，句末标点跟着上一段
    parts = re.split(r"(?<=[。！？!?；;\.])[ \t]*", text)
    return [p.strip() for p in parts if p.strip()]


def seg_id(i):
    return "seg-%d" % i


def build_svml(audio_ref, segments, language):
    lang = LANG_CODES.get(language.lower(), language.lower())
    n = len(segments)

    script_lines = "\n".join(
        '    <%s>%s</%s>' % (seg_id(i + 1), s, seg_id(i + 1))
        for i, s in enumerate(segments))

    aligns = "\n".join(
        '  <whisperx:Alignment id="%s" narrative={story}\n'
        '    segment={story.segment.%s} media={narration-media.media}\n'
        '    domain={narration-media.domain} language="%s"/>'
        % (seg_id(i + 1), seg_id(i + 1), lang)
        for i in range(n))

    # Window 链：每段的长度用同一个 audio 的 extent，串成一条时间轴。
    # 真实使用时通常每段有自己的音频切片（见 README 的「多段不同音频」）。
    wins = []
    prev = "start"
    for i in range(n):
        w = seg_id(i + 1)
        wins.append('    <time:Window id="%s" from="%s" for={narration-media.extent}/>'
                    % (w, prev))
        prev = "%s.end" % w
    windows = "\n".join(wins)

    return '''<?svml using="@hypit/markup@1"?>

<svml>
  <import from="@hypit/script@1"/>
  <import as="asset" from="@hypit/media@1"/>
  <import as="mediaop" from="@hypit/media-operations@1"/>
  <import as="whisperx" from="@hypit/whisperx@1"/>
  <import as="time" from="@hypit/timeline-author@1"/>

  <time:Clock id="clock" frame-rate="30"/>

  <!-- ===== 口播分段 ===== -->
  <script id="story">
%s
  </script>

  <!-- ===== 音频准备 ===== -->
  <asset:Audio id="narration" src="%s"/>
  <mediaop:Normalize id="narration-media" source={narration}
    video="none" audio="default" span-authority="audio" clock={clock}/>

  <!-- ===== 词级对齐：每段一个，把该段的词边界落到 narration-media 的时间域 ===== -->
%s

  <!-- ===== 时间轴：按段序排布 ===== -->
  <time:Timeline id="timeline" clock={clock} end="%s.end">
%s
  </time:Timeline>
</svml>
''' % (script_lines, audio_ref, aligns, seg_id(n), windows)


def build_svrun(first_align_id):
    return '''<?svml using="@hypit/markup/run@1"?>

<svrun version="1">
  <author source="./analyze.svml"/>
  <!-- ⚠️ 必须指向 alignment 导出。指向 media 等中间产物会让引擎把对齐整个
       剪掉：构建照样 complete，但 whisperx.local 一次都不跑。见 make-analyze.py 顶部。 -->
  <target output="%s.alignment"/>
</svrun>
''' % first_align_id


def main():
    p = argparse.ArgumentParser(description="生成 Hypit 词级对齐工程")
    p.add_argument("--audio", required=True, help="音频/视频文件路径（相对工程目录）")
    p.add_argument("--transcript", help="文案文本文件")
    p.add_argument("--text", help="文案字符串")
    p.add_argument("--segments", help="手动分段，用 || 分隔")
    p.add_argument("--language", default="en", help="语言代码，默认 en")
    p.add_argument("--fps", type=int, default=30, help="时钟帧率，默认 30")
    p.add_argument("--dry-run", action="store_true")
    a = p.parse_args()

    audio = a.audio if a.audio.startswith("./") else "./" + a.audio
    if not os.path.exists(os.path.join(HERE, a.audio)):
        print("⚠️  音频不存在: %s（工程仍会生成，构建时会报 ENOENT）" % audio,
              file=sys.stderr)

    segs = split_segments(a)
    if not segs:
        sys.exit("分段结果为空")

    svml = build_svml(audio, segs, a.language).replace('frame-rate="30"',
                                                        'frame-rate="%d"' % a.fps)
    svrun = build_svrun(seg_id(1))

    print("分段 %d 段：" % len(segs))
    for i, s in enumerate(segs):
        print("  %-6s %s" % (seg_id(i + 1), s[:60] + ("…" if len(s) > 60 else "")))
    print("target: %s.alignment" % seg_id(1))

    if a.dry_run:
        print("\n--dry-run：未落盘。")
        return 0

    open(os.path.join(HERE, "analyze.svml"), "w", encoding="utf-8").write(svml)
    open(os.path.join(HERE, "analyze.svrun"), "w", encoding="utf-8").write(svrun)
    print("\n已生成 analyze.svml / analyze.svrun")

    print("\n下一步：")
    print("  cd %s" % HERE)
    print("  %s %s runtime up --runtime ./hypit.runtime.json --project \"$PWD\"" % (NODE, HYPIT))
    print("  %s %s build ./analyze.svrun --runtime ./hypit.runtime.json --json" % (NODE, HYPIT))
    print("  # 确认 outcome=complete 后，用 get 导出 %s.alignment 看词级时间戳"
          % seg_id(1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
