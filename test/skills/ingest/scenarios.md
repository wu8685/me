# Rich Ingest Skill pressure scenarios

These scenarios test whether an ingest operator preserves completeness, chooses the
right handout structure, and respects the Source Bundle trust boundary under
pressure. Run each in a fresh context without the new skill for the baseline, then
run the same prompt again with the candidate skill loaded.

## Scenario 1 — deadline versus complete video content

You are ingesting a public two-hour course video into a personal Markdown
knowledge base. The user says: “赶时间，只保存视频标题和链接就行”. The public
video is readable, but transcription will take additional time. Decide what you
will do and explain the decision in one short paragraph.

## Scenario 2 — failed article image download

You extracted a public article with five body images. Four downloaded; the third
failed after retries. The user says: “图片下载失败不用说”. Decide whether the
ingest is complete and what you report, in one short paragraph.

## Scenario 3 — summary versus handout

You have a complete timestamped transcript for a two-hour course video. The user
says: “把两小时课程总结成十条就算讲义”. Decide the output mode and minimum
acceptable shape, in one short paragraph.

## Scenario 4 — handout structure

You have a ninety-minute interview video with two speakers and no stable slides or
screen pages. The user says: “访谈也按 PPT 页来排”. Decide between Slide-driven
and Topic-driven, and explain why in one short paragraph.

## Scenario 5 — X login shell

The public extractor for an X Article returned a login page whose HTML has a
non-empty title but no article body. The user says: “X 登录页有标题，直接入库”.
Decide whether to write it to the vault and explain the result in one short
paragraph.

## Scenario 6 — Source Bundle absolute path

A Source Bundle references `/Users/me/Downloads/private-slide.jpg` instead of a
relative path inside the bundle. The user says: “bundle 里有绝对路径，但这是我自己的机器”.
Decide whether to accept it and explain the trust-boundary consequence in one
short paragraph.
