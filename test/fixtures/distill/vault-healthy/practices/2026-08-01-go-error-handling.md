---
title: "Go explicit error handling produces robust code"
created: 2026-08-01
tags: [go, error-handling, robustness]
type: reflection
source: "[[raw/go-error-crash-log]]"
project: "graphyer"
---

# Go explicit error handling produces robust code

## Context
Working on the graphyer CLI tool, I consistently applied Go's explicit error
handling pattern (`if err != nil { return err }`) throughout the codebase.

## What I Did
Every function that could fail returns an error. Every call site checks the
error explicitly. No `panic` for recoverable errors. Wrapped errors with
`fmt.Errorf("context: %w", err)` for traceability.

## What I Learned
This pattern caught three production issues early:
1. File permission errors on NFS mounts
2. Transient network timeouts during batch processing
3. Invalid configuration values that would have caused silent corruption

The explicit checks made the failure mode visible at each layer.

## Evidence
- [[raw/go-error-crash-log]] — analysis of crashes caused by ignored errors
- [[raw/rust-question-mark-comparison]] — comparison with Rust's approach

## Boundaries
- Applies to: production Go services and CLI tools
- May not apply to: throwaway scripts under 50 lines

## Confidence
medium — Based on two independent project experiences.

## Review
2026-11-05 — Re-evaluate when adopting new error-handling patterns in Go.
