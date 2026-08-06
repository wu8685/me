---
title: "Go error crash log analysis"
created: 2026-07-20
tags: [go, debugging, errors]
type: raw
---

# Go error crash log analysis

Analyzed three production crashes in a Go microservice. All three were caused
by ignored errors:

1. **nil pointer dereference**: `config.Load()` returned an error that was
   assigned to `_`. The nil config caused a panic later.
2. **file not found**: `os.Open` error was ignored; subsequent read on nil
   file handle crashed.
3. **JSON unmarshal failure**: `json.Unmarshal` error was ignored; zero-value
   struct caused incorrect business logic.

In all three cases, adding `if err != nil` checks at the call site would have
prevented the crash.
