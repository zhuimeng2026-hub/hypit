# sample — 样片抽帧

这个目录**只放抽帧，不放视频**。

## 为什么

| 原因 | 具体 |
|---|---|
| git 历史不可逆 | 三条片子 42MB，`git add` 一下就进对象库，之后删文件也删不掉 |
| 仓库规矩 | `/opt/hypit/CLAUDE.md` 明确写了「不要提交付费产出」 |
| 会悄悄过期 | 西式两条的音轨由 cron 每晚 04:00 重写，复制过来的视频副本不会跟着动 |

改成抽帧后：**42MB → 1.6MB**，每条 8 帧代表全片弧线（片头 4% 到片尾 96%）。

## 目录

```
frames/
  garden/              8 帧  星河湾半岛五號《传奇园境 东方雅韵》
  west-announcer/       8 帧  同片西式风格验证片 · 播报男声
  west-scholar/         8 帧  同片西式风格验证片 · 温润男声
  *_contact_sheet.jpg   4×2 拼版，一张看全片
caps.v2.json            园林片的字幕时间轴（事实源）
west_style_character_v1.ass  西式两条的字幕
manifest.json           来源、实测数据、重新生成的命令、未决问题
```

## 视频在哪

三条片子都不在本目录。真源：

| key | 路径 |
|---|---|
| `garden` | `/opt/OpenMontage_Voicebox/dw_video/_fix/v2_final.mp4` |
| `west-announcer` | `/opt/hypit/projects/west-style/audio_fixed/west_style_fixed.mp4` |
| `west-scholar` | `/opt/hypit/projects/west-style/audio_fixed/west_style_scholar_fixed.mp4` |

**不要把视频复制到这里。** 要看片子直接读上面的路径。

## 重新生成

字幕时间轴、烧字幕、裁尾、响度归一、复核：

```bash
cd /opt/OpenMontage_Voicebox
python3 scripts/caption_rewrite.py probe   <video>
python3 scripts/caption_rewrite.py plan    <video> --facts <facts.json> --script <narration.txt> -o plan.json
python3 scripts/caption_rewrite.py build   <video> --plan plan.json -o out.mp4
python3 scripts/caption_rewrite.py normalize in.mp4 -o out.mp4   # -16 LUFS / -1 dBTP
python3 scripts/caption_rewrite.py verify  out.mp4
```

西式两条的音轨修复有 cron（每晚 04:00），换音乐改
`/opt/hypit/projects/west-style/scripts/fix_kenburns_audio.py`
顶部的 `MUSIC` 常量。

抽帧本身：对每条片子取 4%~96% 等距 8 帧，`scale=640:-2 -q:v 3`。
