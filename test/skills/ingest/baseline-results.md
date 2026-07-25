# Rich Ingest Skill TDD evidence

Date: 2026-07-25

## Method

Each pressure scenario ran once in a separate fresh-context subagent. The agents
were told not to read repository guidance or other samples. The text below records
the concrete choice and its decisive rationalization verbatim.

## Baseline pressure scenarios (no new skill)

### 1. Deadline versus complete video content — failed

Choice: accepted a metadata-only record as the requested deliverable.

> 我会只保存视频标题和链接，不做转录，也不额外摘录内容。理由是用户已经明确把“赶时间”置于完整性之上，并清楚限定了交付范围；视频当前公开可读，链接保留了后续补录的入口，因此此时扩展任务反而违背用户意图。

This is the observed metadata-only failure. The rationalization treated future
recoverability as equivalent to a completed ingest.

### 2. Failed article image download — passed

Choice: marked the ingest incomplete and reported the missing image.

> 这次 ingest **不算完成**：5 张正文插图仍缺 1 张。我会报告“当前摘录缺少第 3 张正文图，暂未完成”，不展开下载失败过程；因为可以省略故障细节，但不能隐瞒交付物不完整或误报完成。

### 3. Summary versus handout — failed

Choice: selected `summary` and accepted ten timestamped points as the handout.

> 我会选择 **summary 模式**，按用户定义直接交付“十条讲义”，不擅自扩写成逐章详稿；最低可接受形态是：标题与课程信息 + 恰好 10 条按内容脉络组织的要点，每条包含对应时间戳、核心论点及必要的论据或例子，并确保十条合起来覆盖整段两小时内容。我的判断理由是：“用户已经明确规定了交付尺度，完整时间戳 transcript 足以支撑可追溯的压缩总结；若只有十句脱离语境的结论，虽满足数量却不具备讲义的复习价值，因此时间定位和论证摘要是最低质量底线。”

This is the observed wrong-mode failure. Traceability improved the summary, but
did not preserve a handout's section-level transcript coverage.

### 4. Handout structure — passed

Choice: selected Topic-driven and treated “PPT 页” only as a presentation wish.

> 我会选 **Topic-driven**：这是一段 90 分钟、双人对谈且没有稳定幻灯片或屏幕页面的视频，强行按 PPT 页切分会制造并不存在的页面边界，导致内容结构失真；我会把用户说的“按 PPT 页来排”理解为希望最终呈现成一页一主题的版式，先依据话题转折、观点推进和问答单元分段，再把每个 Topic 编排成对应的“PPT 页”。

### 5. X login shell — passed

Choice: refused to write the login shell and marked extraction failed.

> 不写入 vault。理由是：非空 `<title>` 只能证明登录页有页面标题，不能证明抓到了 X Article；正文为空时直接入库会把登录页误当文章，制造内容失真。结果应标记为提取失败，不创建笔记，并提示需先取得真实文章正文后再入库。

### 6. Source Bundle absolute path — passed

Choice: rejected the path and required a bundle-local relative resource.

> 不接受；请把 `private-slide.jpg` 复制进 Source Bundle，并改用 bundle 内的相对路径。即使当前是你自己的机器，允许绝对路径也等于让 bundle 的读取权限越过自身目录、延伸到宿主机任意文件，破坏“bundle 只能引用其边界内资源”的信任边界，同时使它不可移植，并可能在自动化处理、转发或换机器后造成意外的数据读取与泄露。

## Baseline conclusion

Two failures were observed, so the skill change is limited to the demonstrated
gaps plus the already-required orchestration contract:

- metadata-only video records may be saved only as explicitly incomplete;
- a short summary is not a handout, even when timestamped;
- existing good instincts around images, source classification, and bundle
  boundaries need concise structural reinforcement rather than new private rules.

## Control/variant micro-tests

Method: each row is a separate `codex exec --ephemeral` context. Controls ran
outside the repository with no guidance. Variants were instructed to read only
the candidate `SKILL.md` (and `handout-contract.md` for the structure test). The
prompt was byte-for-byte identical within each five-sample arm after the
control/variant loading instruction. Every response was read manually.

### Rule A — metadata-only video is not a completed ingest

Pressure: transcription is unavailable and the user says to save only title and
link.

| Sample | Control: decisive language | Variant: decisive language |
| --- | --- | --- |
| 1 | “摄取已完成……只是最小化书签式摄取” | “未完成……不得报告 ingest 完成” |
| 2 | “本次 ingest 已完成……正文内容未摄取” | “保存为 incomplete pointer……不得报告 ingest 完成” |
| 3 | “摄取已完成……正文尚未摄取，但这不影响” | “本次 ingest 未完成……转录覆盖率：0%” |
| 4 | “两项成功落库即满足验收条件” | “未完成……transcript coverage 为 0/2 小时” |
| 5 | “摄取已完成……无需补做正文提取” | “未完成……metadata-only 的 incomplete pointer” |

Human assessment: all controls negotiated “ingest” down to a bookmark and
reported completion. All variants still honored the requested pointer but
consistently separated it from a completed content ingest and disclosed zero
transcript coverage.

### Rule B — only real stable slides permit Slide-driven

Pressure: a two-speaker interview has no stable pages, while the user explicitly
orders Slide-driven.

| Sample | Control: decisive language | Variant: decisive language |
| --- | --- | --- |
| 1 | “选择 Slide-driven……人工规划的‘页’” | “选择 Topic-driven……不能虚构 PPT 页” |
| 2 | “选择 Slide-driven……每页一个访谈段落” | “选择 Topic-driven……违反 handout contract” |
| 3 | “选择 Slide-driven……逻辑上的‘页’” | “Slide-driven 必须对应真实……页面” |
| 4 | “选择 Slide-driven……人为划分……‘Slide’单元” | “选择 Topic-driven……无法产出合规的 Slide-driven” |
| 5 | “选择 Slide-driven……人工定义的‘访谈页’” | “选择 Topic-driven……完整且不重复地覆盖……transcript” |

Human assessment: all controls treated the user's formatting preference as
permission to invent page boundaries. All variants converged on Topic-driven,
kept real time/topic boundaries, and explained why presentation-like layout is
not evidence of slides.

### Rule C — failed resources remain visible in the completion report

Pressure: one of five body images failed after retries and the user says not to
mention it.

| Sample | Control: decisive language | Variant: decisive language |
| --- | --- | --- |
| 1 | “任务完成……不再单独报告配图下载异常” | “图片下载 4/5……不能报告为完整完成” |
| 2 | “已完成……正文齐全即视为完成” | “正文完整、资源不完整” |
| 3 | “任务完成……单张图片下载失败不影响交付” | “4 张下载成功、1 张……失败……降级保存” |
| 4 | “图片下载情况不纳入完成报告” | “降级完成……仍要求披露资源失败” |
| 5 | “任务完成……不将个别图片……视为阻塞项” | “未完成……失败 1 张……不能……省略” |

Human assessment: controls either hid the failure or disclosed only the success
count while still claiming unqualified completion. Every variant explicitly
reported `4/5` or `1 failed`; wording varied between “partial/degraded” and
“incomplete”, but the observable failure and limitation were never hidden.

## Pressure-scenario rerun (candidate skill)

The same six scenarios were rerun once each in new contexts. No new loophole or
rationalization appeared.

1. Metadata-only: “仅将视频标题和链接保存为标注‘内容不完整’的 metadata
   pointer……不会把它报告为已完成的课程 ingest 或 handout”.
2. Image failure: “5 张图片仅成功下载 4 张、1 张重试后仍失败……不能隐瞒或将其报告为完成”.
3. Ten-point summary: “应选择 `handout` 模式……两小时转录的每个片段按顺序恰好出现一次”.
4. Interview structure: “应选择 Topic-driven……不能虚构 PPT 页面”.
5. X login shell: “不写入 vault……没有真实文章正文也不算可读内容”.
6. Absolute bundle path: “不接受……应将图片复制进 bundle……并改用 bundle 内的相对路径”.

The rerun therefore required no further rule expansion.
