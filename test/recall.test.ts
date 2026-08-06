import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseRecallArguments } from '../bin/recall';
import {
  isCorrection,
  parseJsonlLine,
  scanCodexSessionDir,
} from '../bin/recall/codex-local';
import { redactText } from '../bin/recall/redact';
import type { RecallWarning } from '../bin/recall/contracts';

const pluginRoot = path.resolve(import.meta.dir, '..');
const cli = path.join(pluginRoot, 'bin/recall.ts');
const fixtureDir = path.join(pluginRoot, 'test/fixtures/recall');
const fixtures: string[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

function makeTemp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fixtures.push(dir);
  return dir;
}

function writeSession(dir: string, name: string, lines: string[]): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

const noopWarn = (): void => undefined;

// ── redactText ─────────────────────────────────────────────────────

describe('redactText', () => {
  test('redacts API-key prefixed secrets', () => {
    const result = redactText('token glpat-test-abcdefghijklmnop123456789 end');
    expect(result.redacted).toBeTrue();
    expect(result.text).not.toContain('glpat-test-abcdefghijklmnop123456789');
    expect(result.text).toContain('[REDACTED:api-key]');
    expect(result.tokens['api-key']).toBe(1);
  });

  test('redacts emails', () => {
    const result = redactText('contact wuke@example.com now');
    expect(result.redacted).toBeTrue();
    expect(result.text).not.toContain('wuke@example.com');
    expect(result.text).toContain('[REDACTED:email]');
  });

  test('redacts URL credentials while preserving the host', () => {
    const result = redactText('https://alice:secret@example.com/repo');
    expect(result.text).toBe('https://[REDACTED:credential]@example.com/repo');
    expect(result.tokens['credential']).toBe(1);
  });

  test('redacts SCREAMING_CASE env assignments', () => {
    const result = redactText('run with CODEX_HOME=/secret/path');
    expect(result.text).toContain('CODEX_HOME=[REDACTED:env-value]');
    expect(result.text).not.toContain('/secret/path');
  });

  test('redacts env references', () => {
    const result = redactText('path is ${CODEX_HOME} and $GITHUB_TOKEN');
    expect(result.text).toContain('[REDACTED:env]');
    expect(result.text).not.toContain('${CODEX_HOME}');
    expect(result.text).not.toContain('$GITHUB_TOKEN');
  });

  test('redacts IPv4 addresses', () => {
    const result = redactText('server at 192.168.1.1');
    expect(result.text).toContain('[REDACTED:ip-address]');
    expect(result.text).not.toContain('192.168.1.1');
  });

  test('redacts private key blocks', () => {
    const result = redactText(
      'key:\n-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDbg\n-----END PRIVATE KEY-----',
    );
    expect(result.text).toContain('[REDACTED:private-key]');
    expect(result.text).not.toContain('MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDbg');
  });

  test('redacts mixed-case long secrets', () => {
    const secret = 'AbCdEf1234567890AbCdEf1234567890XYZ';
    const result = redactText(`the value is ${secret}`);
    expect(result.text).toContain('[REDACTED:secret]');
    expect(result.text).not.toContain(secret);
  });

  test('leaves benign text and lowercase identifiers unchanged', () => {
    const text = 'Hello world 你好，normal sentence with 019f286ac0167df2900a1cab97a048c2';
    const result = redactText(text);
    expect(result.redacted).toBeFalse();
    expect(result.text).toBe(text);
  });

  test('is deterministic', () => {
    const input = 'glpat-test-abcdefghijklmnop123456789 and wuke@example.com';
    expect(redactText(input).text).toBe(redactText(input).text);
  });
});

// ── isCorrection ───────────────────────────────────────────────────

describe('isCorrection', () => {
  test('detects explicit Chinese correction markers', () => {
    expect(isCorrection('更正：应该用 B 方案')).toBeTrue();
    expect(isCorrection('纠正一下，之前说得不对')).toBeTrue();
    expect(isCorrection('修正：路径是 src/ 不是 lib/')).toBeTrue();
    expect(isCorrection('其实问题是环境变量导致的')).toBeTrue();
    expect(isCorrection('不对，应该检查配置文件')).toBeTrue();
  });

  test('detects explicit English correction markers', () => {
    expect(isCorrection('correction: use v2')).toBeTrue();
    expect(isCorrection('Actually, the fix is in another file')).toBeTrue();
    expect(isCorrection('on second thought, drop the index')).toBeTrue();
    expect(isCorrection('scratch that, keep the old plan')).toBeTrue();
    expect(isCorrection('I was wrong about the port')).toBeTrue();
  });

  test('does not flag ordinary statements', () => {
    expect(isCorrection('我完成了任务')).toBeFalse();
    expect(isCorrection('The project looks good')).toBeFalse();
    expect(isCorrection('Let me summarize the findings')).toBeFalse();
    expect(isCorrection('修复 issue： 用多agent帮我调试 ahsir #37 的问题')).toBeFalse();
  });
});

// ── parseJsonlLine ─────────────────────────────────────────────────

describe('parseJsonlLine', () => {
  test('parses a valid record', () => {
    const parsed = parseJsonlLine('{"timestamp":"2026-08-03T09:00:00.000Z","type":"session_meta"}');
    expect(parsed.ok).toBeTrue();
    if (parsed.ok) {
      expect(parsed.record.type).toBe('session_meta');
    }
  });

  test('rejects malformed JSON', () => {
    const parsed = parseJsonlLine('NOT VALID JSON');
    expect(parsed.ok).toBeFalse();
  });

  test('rejects empty lines', () => {
    expect(parseJsonlLine('').ok).toBeFalse();
  });
});

// ── scanCodexSessionDir ────────────────────────────────────────────

describe('scanCodexSessionDir', () => {
  test('extracts the four evidence kinds and a derived title', () => {
    const result = scanCodexSessionDir({
      sessionsDir: fixtureDir,
      scopeWorkspace: '/recall-fixture/workspace-a',
      limit: 20,
      warn: noopWarn,
    });
    const task = result.tasks.find(t => t.taskId === 'task-a-001');
    expect(task).toBeDefined();
    expect(task!.derivedTitle).toContain('修复 issue');
    expect(task!.titleLabel).toBe('derived');
    const kinds = task!.evidence.map(e => e.kind);
    expect(kinds).toContain('user_statement');
    expect(kinds).toContain('agent_conclusion');
    expect(kinds).toContain('tool_result');
    expect(kinds).toContain('correction');
    for (const e of task!.evidence) {
      expect(['user_statement', 'agent_conclusion', 'tool_result', 'correction']).toContain(e.kind);
      expect(['conversation', 'tool']).toContain(e.sourceCategory);
      expect(typeof e.provenance.sourcePath).toBe('string');
      expect(typeof e.provenance.recordIndex).toBe('number');
    }
  });

  test('default scoping excludes sessions from other workspaces', () => {
    const result = scanCodexSessionDir({
      sessionsDir: fixtureDir,
      scopeWorkspace: '/recall-fixture/workspace-a',
      limit: 20,
      warn: noopWarn,
    });
    expect(result.tasks.some(t => t.taskId === 'task-a-001')).toBeTrue();
    expect(result.tasks.some(t => t.taskId === 'task-b-001')).toBeFalse();
  });

  test('coalesces duplicate user content into one statement', () => {
    const result = scanCodexSessionDir({
      sessionsDir: fixtureDir,
      scopeWorkspace: '/recall-fixture/workspace-a',
      limit: 20,
      warn: noopWarn,
    });
    const task = result.tasks.find(t => t.taskId === 'task-a-001')!;
    const statements = task.evidence.filter(e => e.kind === 'user_statement' && e.text.includes('修复 issue'));
    expect(statements.length).toBe(1);
    expect(result.stats.coalescedDuplicates).toBeGreaterThanOrEqual(1);
  });

  test('matches tool call output to its call by call_id', () => {
    const result = scanCodexSessionDir({
      sessionsDir: fixtureDir,
      scopeWorkspace: '/recall-fixture/workspace-a',
      limit: 20,
      warn: noopWarn,
    });
    const task = result.tasks.find(t => t.taskId === 'task-a-001')!;
    const tool = task.evidence.find(e => e.kind === 'tool_result');
    expect(tool).toBeDefined();
    expect(tool!.text).toContain('apply_patch');
    expect(tool!.text).toContain('Updated README.md');
    expect(tool!.sourceCategory).toBe('tool');
  });

  test('chains corrections: later correction supersedes the earlier one', () => {
    const dir = makeTemp('me-recall-chain-');
    writeSession(dir, 'chain.jsonl', [
      '{"timestamp":"2026-08-03T09:00:00.000Z","type":"session_meta","payload":{"session_id":"chain-1","id":"chain-1","cwd":"/recall-fixture/workspace-a","timestamp":"2026-08-03T09:00:00.000Z"}}',
      '{"timestamp":"2026-08-03T09:00:01.000Z","type":"turn_context","payload":{"turn_id":"t1","cwd":"/recall-fixture/workspace-a","workspace_roots":["/recall-fixture/workspace-a"]}}',
      '{"timestamp":"2026-08-03T09:00:02.000Z","type":"event_msg","payload":{"type":"user_message","message":"先用方案 A"}}',
      '{"timestamp":"2026-08-03T09:00:03.000Z","type":"event_msg","payload":{"type":"user_message","message":"其实应该用方案 B"}}',
      '{"timestamp":"2026-08-03T09:00:04.000Z","type":"event_msg","payload":{"type":"user_message","message":"不对，方案 C 最稳"}}',
    ]);
    const result = scanCodexSessionDir({
      sessionsDir: dir,
      scopeWorkspace: '/recall-fixture/workspace-a',
      limit: 20,
      warn: noopWarn,
    });
    const task = result.tasks.find(t => t.taskId === 'chain-1')!;
    const corrections = task.evidence.filter(e => e.kind === 'correction');
    expect(corrections.length).toBe(2);
    const b = corrections.find(c => c.text.includes('方案 B'))!;
    const c = corrections.find(c => c.text.includes('方案 C'))!;
    expect(b.supersedes).toBe(task.evidence.find(e => e.text.includes('方案 A'))!.key);
    expect(c.supersedes).toBe(b.key);
    const entryB = result.corrections.find(entry => entry.key === b.key)!;
    expect(entryB.supersededBy).toBe(c.key);
    expect(entryB.conflicts).toBeTrue();
  });

  test('survives malformed JSONL records and counts them', () => {
    const result = scanCodexSessionDir({
      sessionsDir: fixtureDir,
      scopeWorkspace: '/recall-fixture/workspace-a',
      limit: 20,
      warn: noopWarn,
    });
    expect(result.stats.malformedRecords).toBeGreaterThanOrEqual(2);
    expect(result.tasks.some(t => t.taskId === 'task-m-001')).toBeTrue();
  });

  test('keeps evidence text bounded', () => {
    const result = scanCodexSessionDir({
      sessionsDir: fixtureDir,
      scopeWorkspace: '/recall-fixture/workspace-a',
      limit: 20,
      warn: noopWarn,
    });
    for (const t of result.tasks) {
      for (const e of t.evidence) {
        expect(e.text.length).toBeLessThanOrEqual(400);
      }
    }
  });

  test('filters by time window', () => {
    const result = scanCodexSessionDir({
      sessionsDir: fixtureDir,
      scopeWorkspace: '/recall-fixture/workspace-a',
      after: '2026-08-03T09:03:00',
      limit: 20,
      warn: noopWarn,
    });
    expect(result.tasks.some(t => t.taskId === 'task-a-001')).toBeFalse();
  });

  test('filters by topic', () => {
    const result = scanCodexSessionDir({
      sessionsDir: fixtureDir,
      scopeWorkspace: '/recall-fixture/workspace-a',
      topic: '环境变量',
      limit: 20,
      warn: noopWarn,
    });
    expect(result.tasks.some(t => t.taskId === 'task-a-001')).toBeTrue();
    const miss = scanCodexSessionDir({
      sessionsDir: fixtureDir,
      scopeWorkspace: '/recall-fixture/workspace-a',
      topic: 'totally-missing-topic',
      limit: 20,
      warn: noopWarn,
    });
    expect(miss.tasks.length).toBe(0);
  });

  test('filters by task title', () => {
    const result = scanCodexSessionDir({
      sessionsDir: fixtureDir,
      scopeWorkspace: '/recall-fixture/workspace-a',
      title: '修复 issue',
      limit: 20,
      warn: noopWarn,
    });
    expect(result.tasks.some(t => t.taskId === 'task-a-001')).toBeTrue();
    expect(result.tasks.some(t => t.taskId === 'task-s-001')).toBeFalse();
    const miss = scanCodexSessionDir({
      sessionsDir: fixtureDir,
      scopeWorkspace: '/recall-fixture/workspace-a',
      title: '知识库',
      limit: 20,
      warn: noopWarn,
    });
    expect(miss.tasks.length).toBe(0);
  });

  test('emits tool_result evidence for mcp_tool_call_end', () => {
    const dir = makeTemp('me-recall-mcp-');
    writeSession(dir, 'mcp.jsonl', [
      '{"timestamp":"2026-08-03T09:00:00.000Z","type":"session_meta","payload":{"session_id":"mcp-1","id":"mcp-1","cwd":"/recall-fixture/workspace-a"}}',
      '{"timestamp":"2026-08-03T09:00:00.100Z","type":"turn_context","payload":{"workspace_roots":["/recall-fixture/workspace-a"]}}',
      '{"timestamp":"2026-08-03T09:00:02.000Z","type":"event_msg","payload":{"type":"mcp_tool_call_end","call_id":"c1","invocation":{"server":"node_repl","tool":"js"},"result":{"Ok":{"content":[{"type":"text","text":"42"}]}}}}',
      '{"timestamp":"2026-08-03T09:00:03.000Z","type":"event_msg","payload":{"type":"user_message","message":"跑一下计算"}}',
    ]);
    const result = scanCodexSessionDir({
      sessionsDir: dir,
      scopeWorkspace: '/recall-fixture/workspace-a',
      limit: 20,
      warn: noopWarn,
    });
    const task = result.tasks.find(t => t.taskId === 'mcp-1');
    expect(task).toBeDefined();
    const tool = task!.evidence.find(e => e.kind === 'tool_result');
    expect(tool).toBeDefined();
    expect(tool!.text).toContain('tool js');
    expect(tool!.sourceCategory).toBe('tool');
  });

  test('skips system-injected AGENTS.md user content', () => {
    const dir = makeTemp('me-recall-injected-');
    writeSession(dir, 'injected.jsonl', [
      '{"timestamp":"2026-08-03T09:00:00.000Z","type":"session_meta","payload":{"session_id":"inj-1","id":"inj-1","cwd":"/recall-fixture/workspace-a"}}',
      '{"timestamp":"2026-08-03T09:00:00.100Z","type":"turn_context","payload":{"workspace_roots":["/recall-fixture/workspace-a"]}}',
      '{"timestamp":"2026-08-03T09:00:01.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"# AGENTS.md instructions for /w\\n\\n<INSTRUCTIONS> huge dump"}]}}',
      '{"timestamp":"2026-08-03T09:00:02.000Z","type":"event_msg","payload":{"type":"user_message","message":"真实需求"}}',
    ]);
    const result = scanCodexSessionDir({
      sessionsDir: dir,
      scopeWorkspace: '/recall-fixture/workspace-a',
      limit: 20,
      warn: noopWarn,
    });
    const task = result.tasks.find(t => t.taskId === 'inj-1');
    expect(task).toBeDefined();
    expect(task!.derivedTitle).toBe('真实需求');
    expect(task!.evidence.some(e => e.text.includes('AGENTS.md'))).toBeFalse();
  });

  test('counts a truncated trailing record separately and recovers the task', () => {
    const dir = makeTemp('me-recall-truncated-');
    const file = writeSession(dir, 'trunc.jsonl', [
      '{"timestamp":"2026-08-03T09:00:00.000Z","type":"session_meta","payload":{"session_id":"tr-1","id":"tr-1","cwd":"/recall-fixture/workspace-a"}}',
      '{"timestamp":"2026-08-03T09:00:00.100Z","type":"turn_context","payload":{"workspace_roots":["/recall-fixture/workspace-a"]}}',
      '{"timestamp":"2026-08-03T09:00:02.000Z","type":"event_msg","payload":{"type":"user_message","message":"截断测试"}}',
    ]);
    // Append a cut-off JSONL record (no closing brace).
    fs.appendFileSync(file, '{"timestamp":"2026-08-03T09:00:03.000Z","type":"event_msg","payload":{"type":"user');
    const warns: string[] = [];
    const result = scanCodexSessionDir({
      sessionsDir: dir,
      scopeWorkspace: '/recall-fixture/workspace-a',
      limit: 20,
      warn: w => warns.push(w.code),
    });
    expect(result.stats.truncatedRecords).toBe(1);
    expect(result.stats.malformedRecords).toBe(0);
    expect(warns).toContain('TRUNCATED_RECORD');
    expect(result.tasks.some(t => t.taskId === 'tr-1')).toBeTrue();
  });

  test('keeps two distinct user statements with different secrets after redaction', () => {
    const dir = makeTemp('me-recall-secrets-');
    writeSession(dir, 'secrets.jsonl', [
      '{"timestamp":"2026-08-03T09:00:00.000Z","type":"session_meta","payload":{"session_id":"sec-1","id":"sec-1","cwd":"/recall-fixture/workspace-a"}}',
      '{"timestamp":"2026-08-03T09:00:00.100Z","type":"turn_context","payload":{"workspace_roots":["/recall-fixture/workspace-a"]}}',
      '{"timestamp":"2026-08-03T09:00:01.000Z","type":"event_msg","payload":{"type":"user_message","message":"key 是 glpat-one-abcdefghijklmnop123456"}}',
      '{"timestamp":"2026-08-03T09:00:02.000Z","type":"event_msg","payload":{"type":"user_message","message":"key 是 glpat-two-abcdefghijklmnop123456"}}',
    ]);
    const result = scanCodexSessionDir({
      sessionsDir: dir,
      scopeWorkspace: '/recall-fixture/workspace-a',
      limit: 20,
      warn: noopWarn,
    });
    const task = result.tasks.find(t => t.taskId === 'sec-1');
    expect(task).toBeDefined();
    const statements = task!.evidence.filter(e => e.kind === 'user_statement');
    expect(statements.length).toBe(2);
    expect(statements[0].text).toContain('REDACTED:api-key');
    expect(statements[1].text).toContain('REDACTED:api-key');
  });

  test('reads response_item assistant output_text content as agent_conclusion', () => {
    const dir = makeTemp('me-recall-outputtext-');
    writeSession(dir, 'outputtext.jsonl', [
      '{"timestamp":"2026-08-03T09:00:00.000Z","type":"session_meta","payload":{"session_id":"ot-1","id":"ot-1","cwd":"/recall-fixture/workspace-a"}}',
      '{"timestamp":"2026-08-03T09:00:00.100Z","type":"turn_context","payload":{"workspace_roots":["/recall-fixture/workspace-a"]}}',
      '{"timestamp":"2026-08-03T09:00:01.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"结论：用方案 B"}]}}',
      '{"timestamp":"2026-08-03T09:00:02.000Z","type":"event_msg","payload":{"type":"user_message","message":"真实需求"}}',
    ]);
    const result = scanCodexSessionDir({
      sessionsDir: dir,
      scopeWorkspace: '/recall-fixture/workspace-a',
      limit: 20,
      warn: noopWarn,
    });
    const task = result.tasks.find(t => t.taskId === 'ot-1');
    expect(task).toBeDefined();
    const agent = task!.evidence.find(e => e.kind === 'agent_conclusion');
    expect(agent).toBeDefined();
    expect(agent!.text).toContain('结论：用方案 B');
  });

  test('populates truthful provenance threadId and sessionId', () => {
    const dir = makeTemp('me-recall-thread-');
    writeSession(dir, 'thread.jsonl', [
      '{"timestamp":"2026-08-03T09:00:00.000Z","type":"session_meta","payload":{"session_id":"th-1","id":"th-1","cwd":"/recall-fixture/workspace-a"}}',
      '{"timestamp":"2026-08-03T09:00:00.100Z","type":"turn_context","payload":{"workspace_roots":["/recall-fixture/workspace-a"]}}',
      '{"timestamp":"2026-08-03T09:00:01.000Z","type":"event_msg","payload":{"type":"user_message","message":"测试线程"}}',
    ]);
    const result = scanCodexSessionDir({
      sessionsDir: dir,
      scopeWorkspace: '/recall-fixture/workspace-a',
      limit: 20,
      warn: noopWarn,
    });
    const task = result.tasks.find(t => t.taskId === 'th-1');
    expect(task).toBeDefined();
    for (const e of task!.evidence) {
      expect(e.provenance.threadId).toBe('th-1');
      expect(e.provenance.sessionId).toBe('th-1');
    }
  });

  test('prefers an explicit payload thread_id over session_id', () => {
    const dir = makeTemp('me-recall-threadid-');
    writeSession(dir, 'threadid.jsonl', [
      '{"timestamp":"2026-08-03T09:00:00.000Z","type":"session_meta","payload":{"session_id":"th-2","id":"th-2","thread_id":"custom-thread","cwd":"/recall-fixture/workspace-a"}}',
      '{"timestamp":"2026-08-03T09:00:00.100Z","type":"turn_context","payload":{"workspace_roots":["/recall-fixture/workspace-a"]}}',
      '{"timestamp":"2026-08-03T09:00:01.000Z","type":"event_msg","payload":{"type":"user_message","message":"显式线程"}}',
    ]);
    const result = scanCodexSessionDir({
      sessionsDir: dir,
      scopeWorkspace: '/recall-fixture/workspace-a',
      limit: 20,
      warn: noopWarn,
    });
    const task = result.tasks.find(t => t.taskId === 'th-2');
    expect(task).toBeDefined();
    for (const e of task!.evidence) {
      expect(e.provenance.threadId).toBe('custom-thread');
    }
  });

  test('coalesces root and child subagent sessions into one task without losing child evidence', () => {
    const dir = makeTemp('me-recall-subagent-');
    writeSession(dir, 'root.jsonl', [
      '{"timestamp":"2026-08-03T09:00:00.000Z","type":"session_meta","payload":{"session_id":"root-1","id":"root-1","cwd":"/recall-fixture/workspace-a","source":"vscode","thread_source":"user"}}',
      '{"timestamp":"2026-08-03T09:00:00.100Z","type":"turn_context","payload":{"workspace_roots":["/recall-fixture/workspace-a"]}}',
      '{"timestamp":"2026-08-03T09:00:01.000Z","type":"event_msg","payload":{"type":"user_message","message":"调试主任务"}}',
      '{"timestamp":"2026-08-03T09:00:02.000Z","type":"event_msg","payload":{"type":"agent_message","message":"主 agent 开始"}}',
    ]);
    writeSession(dir, 'child1.jsonl', [
      '{"timestamp":"2026-08-03T09:00:00.000Z","type":"session_meta","payload":{"session_id":"root-1","id":"child-1","parent_thread_id":"root-1","cwd":"/recall-fixture/workspace-a","thread_source":"subagent","source":{"subagent":{"thread_spawn":{"parent_thread_id":"root-1","depth":1,"agent_path":"/root/task1","agent_nickname":"Socrates"}}}}}',
      '{"timestamp":"2026-08-03T09:00:00.100Z","type":"turn_context","payload":{"workspace_roots":["/recall-fixture/workspace-a"]}}',
      '{"timestamp":"2026-08-03T09:00:01.000Z","type":"event_msg","payload":{"type":"user_message","message":"调试主任务"}}',
      '{"timestamp":"2026-08-03T09:00:03.000Z","type":"event_msg","payload":{"type":"agent_message","message":"子 agent 1 发现原因 A"}}',
    ]);
    writeSession(dir, 'child2.jsonl', [
      '{"timestamp":"2026-08-03T09:00:00.000Z","type":"session_meta","payload":{"session_id":"root-1","id":"child-2","parent_thread_id":"root-1","cwd":"/recall-fixture/workspace-a","thread_source":"subagent","source":{"subagent":{"thread_spawn":{"parent_thread_id":"root-1","depth":1,"agent_path":"/root/task2","agent_nickname":"Plato"}}}}}',
      '{"timestamp":"2026-08-03T09:00:00.100Z","type":"turn_context","payload":{"workspace_roots":["/recall-fixture/workspace-a"]}}',
      '{"timestamp":"2026-08-03T09:00:01.000Z","type":"event_msg","payload":{"type":"user_message","message":"调试主任务"}}',
      '{"timestamp":"2026-08-03T09:00:04.000Z","type":"event_msg","payload":{"type":"agent_message","message":"子 agent 2 发现原因 B"}}',
    ]);
    const result = scanCodexSessionDir({
      sessionsDir: dir,
      scopeWorkspace: '/recall-fixture/workspace-a',
      limit: 20,
      warn: noopWarn,
    });
    expect(result.tasks.length).toBe(1);
    const task = result.tasks[0];
    expect(task.taskId).toBe('root-1');
    expect(task.sources.length).toBe(3);
    // Copied root prompt counted once across root + children.
    const prompts = task.evidence.filter(e => e.kind === 'user_statement' && e.text.includes('调试主任务'));
    expect(prompts.length).toBe(1);
    // Distinct child evidence retained.
    const texts = task.evidence.map(e => e.text).join('\n');
    expect(texts).toContain('主 agent 开始');
    expect(texts).toContain('子 agent 1 发现原因 A');
    expect(texts).toContain('子 agent 2 发现原因 B');
    // Child evidence carries distinct child session ids + thread id.
    const child1 = task.evidence.find(e => e.text.includes('原因 A'));
    expect(child1!.provenance.sessionId).toBe('child-1');
    expect(child1!.provenance.sourcePath).toContain('child1.jsonl');
    const child2 = task.evidence.find(e => e.text.includes('原因 B'));
    expect(child2!.provenance.sessionId).toBe('child-2');
    expect(child2!.provenance.sourcePath).toContain('child2.jsonl');
    for (const e of task.evidence) {
      expect(e.provenance.threadId).toBe('root-1');
    }
    expect(result.stats.coalescedDuplicates).toBeGreaterThanOrEqual(2);
  });

  test('filters by a --before time window', () => {
    const before = scanCodexSessionDir({
      sessionsDir: fixtureDir,
      scopeWorkspace: '/recall-fixture/workspace-a',
      before: '2026-08-03T09:00:00',
      limit: 20,
      warn: noopWarn,
    });
    // task-a-001 (2026-08-03) has every evidence record after the cutoff →
    // excluded. Earlier-date sessions (2026-08-01) remain in scope.
    expect(before.tasks.some(t => t.taskId === 'task-a-001')).toBeFalse();
    expect(before.tasks.some(t => t.taskId === 'task-s-001')).toBeTrue();
    // Inclusive window: task-a-001 has evidence at/before 09:01:00 → included.
    const inclusive = scanCodexSessionDir({
      sessionsDir: fixtureDir,
      scopeWorkspace: '/recall-fixture/workspace-a',
      before: '2026-08-03T09:01:00',
      limit: 20,
      warn: noopWarn,
    });
    expect(inclusive.tasks.some(t => t.taskId === 'task-a-001')).toBeTrue();
  });

  test('handles legacy function_call and function_call_output as tool_result', () => {
    const dir = makeTemp('me-recall-legacy-');
    writeSession(dir, 'legacy.jsonl', [
      '{"timestamp":"2026-08-03T09:00:00.000Z","type":"session_meta","payload":{"session_id":"leg-1","id":"leg-1","cwd":"/recall-fixture/workspace-a"}}',
      '{"timestamp":"2026-08-03T09:00:00.100Z","type":"turn_context","payload":{"workspace_roots":["/recall-fixture/workspace-a"]}}',
      '{"timestamp":"2026-08-03T09:00:01.000Z","type":"response_item","payload":{"type":"function_call","id":"fc-1","name":"exec_command","arguments":"{\\"cmd\\":\\"ls\\"}","call_id":"call-leg"}}',
      '{"timestamp":"2026-08-03T09:00:02.000Z","type":"response_item","payload":{"type":"function_call_output","call_id":"call-leg","output":"file1.md\\nfile2.md"}}',
      '{"timestamp":"2026-08-03T09:00:03.000Z","type":"event_msg","payload":{"type":"user_message","message":"跑一下"}}',
    ]);
    const result = scanCodexSessionDir({
      sessionsDir: dir,
      scopeWorkspace: '/recall-fixture/workspace-a',
      limit: 20,
      warn: noopWarn,
    });
    const task = result.tasks.find(t => t.taskId === 'leg-1');
    expect(task).toBeDefined();
    const tool = task!.evidence.find(e => e.kind === 'tool_result');
    expect(tool).toBeDefined();
    expect(tool!.text).toContain('exec_command');
    expect(tool!.text).toContain('file1.md');
    expect(tool!.sourceCategory).toBe('tool');
  });

  test('truncates a task with more than 20 evidence entries', () => {
    const dir = makeTemp('me-recall-many-');
    const lines = [
      '{"timestamp":"2026-08-03T09:00:00.000Z","type":"session_meta","payload":{"session_id":"many-1","id":"many-1","cwd":"/recall-fixture/workspace-a"}}',
      '{"timestamp":"2026-08-03T09:00:00.100Z","type":"turn_context","payload":{"workspace_roots":["/recall-fixture/workspace-a"]}}',
    ];
    for (let i = 0; i < 25; i++) {
      lines.push(`{"timestamp":"2026-08-03T09:00:${String(i).padStart(2, '0')}.000Z","type":"event_msg","payload":{"type":"user_message","message":"消息 ${i}"}}`);
    }
    writeSession(dir, 'many.jsonl', lines);
    const result = scanCodexSessionDir({
      sessionsDir: dir,
      scopeWorkspace: '/recall-fixture/workspace-a',
      limit: 20,
      warn: noopWarn,
    });
    const task = result.tasks.find(t => t.taskId === 'many-1');
    expect(task).toBeDefined();
    expect(task!.evidence.length).toBe(20);
    expect(task!.evidenceTruncated).toBeTrue();
  });

  test('emits structured warnings for malformed and truncated sources', () => {
    const warns: string[] = [];
    const result = scanCodexSessionDir({
      sessionsDir: fixtureDir,
      scopeWorkspace: '/recall-fixture/workspace-a',
      limit: 20,
      warn: w => warns.push(w.code),
    });
    expect(warns).toContain('MALFORMED_RECORD');
    expect(result.stats.malformedRecords).toBeGreaterThanOrEqual(2);
    expect(result.tasks.some(t => t.taskId === 'task-m-001')).toBeTrue();
  });
});

// ── parseRecallArguments ───────────────────────────────────────────

describe('parseRecallArguments', () => {
  test('parses vault-dir and a positional query', () => {
    const args = parseRecallArguments(['--vault-dir', '/vault', 'fix issue']);
    expect(args.vaultDir).toBe('/vault');
    expect(args.query).toBe('fix issue');
    expect(args.adapters).toEqual(['codex-local']);
    expect(args.limit).toBe(20);
  });

  test('parses the full flag surface', () => {
    const args = parseRecallArguments([
      '--vault-dir', '/vault',
      '--query', '调试',
      '--after', '2026-08-01',
      '--before', '2026-08-05T10:00:00.000Z',
      '--workspace', '/other',
      '--authorize-cross-workspace',
      '--adapter', 'codex-local',
      '--limit', '5',
      '--sessions-dir', '/sessions',
    ]);
    expect(args.after).toBe('2026-08-01T00:00:00.000Z');
    expect(args.before).toBe('2026-08-05T10:00:00.000Z');
    expect(args.workspace).toBe('/other');
    expect(args.authorizeCrossWorkspace).toBeTrue();
    expect(args.limit).toBe(5);
    expect(args.sessionsDir).toBe('/sessions');
  });

  test('normalizes a bare datetime to UTC regardless of host timezone', () => {
    // A bare `--after 2026-08-03T09:03:00` must mean 09:03 UTC on every
    // machine, not 09:03 in the local timezone.
    const args = parseRecallArguments(['--vault-dir', '/v', '--after', '2026-08-03T09:03:00']);
    expect(args.after).toBe('2026-08-03T09:03:00.000Z');
    const args2 = parseRecallArguments(['--vault-dir', '/v', '--before', '2026-08-03T09:03:00']);
    expect(args2.before).toBe('2026-08-03T09:03:00.000Z');
  });

  test('rejects missing vault-dir', () => {
    expect(() => parseRecallArguments(['--query', 'x'])).toThrow();
  });

  test('rejects unknown flags', () => {
    expect(() => parseRecallArguments(['--vault-dir', '/v', '--bogus', 'x'])).toThrow();
  });

  test('rejects a missing flag value', () => {
    expect(() => parseRecallArguments(['--vault-dir'])).toThrow();
  });

  test('rejects both a positional query and --query', () => {
    expect(() => parseRecallArguments(['--vault-dir', '/v', 'pos', '--query', 'flag'])).toThrow();
  });

  test('rejects an unparseable date', () => {
    expect(() => parseRecallArguments(['--vault-dir', '/v', '--after', 'not-a-date'])).toThrow();
  });

  test('rejects a non-numeric limit', () => {
    expect(() => parseRecallArguments(['--vault-dir', '/v', '--limit', 'many'])).toThrow();
  });
});

// ── CLI integration ────────────────────────────────────────────────

function invoke(args: string[]) {
  return spawnSync('bun', ['run', cli, ...args], {
    cwd: pluginRoot,
    encoding: 'utf8',
  });
}

describe('recall CLI', () => {
  test('rejects malformed arguments with one stable JSON error', () => {
    const result = invoke([]);
    expect(result.status).toBe(2);
    expect(result.stderr).toBe('');
    const parsed = JSON.parse(result.stdout);
    expect(parsed.status).toBe('error');
    expect(parsed.error.code).toBe('INVALID_ARGUMENTS');
  });

  test('emits a versioned session-evidence bundle on a valid run', () => {
    const result = invoke([
      '--vault-dir', '/recall-fixture/workspace-a',
      '--sessions-dir', fixtureDir,
      '--query', '调试',
    ]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const bundle = JSON.parse(result.stdout);
    expect(bundle.version).toBe(1);
    expect(bundle.contract).toBe('session-evidence');
    expect(bundle.tasks.some(t => t.taskId === 'task-a-001')).toBeTrue();
    expect(bundle.scope.authorized).toBeTrue();
  });

  test('empty results explicitly succeed', () => {
    const result = invoke([
      '--vault-dir', '/recall-fixture/workspace-a',
      '--sessions-dir', fixtureDir,
      '--query', 'totally-missing-query',
    ]);
    expect(result.status).toBe(0);
    const bundle = JSON.parse(result.stdout);
    expect(bundle.tasks.length).toBe(0);
  });

  test('cross-workspace without authorization fails closed', () => {
    const result = invoke([
      '--vault-dir', '/recall-fixture/workspace-a',
      '--sessions-dir', fixtureDir,
      '--workspace', '/recall-fixture/workspace-b',
      '--query', '知识库',
    ]);
    expect(result.status).toBe(0);
    const bundle = JSON.parse(result.stdout);
    expect(bundle.scope.crossWorkspace).toBeTrue();
    expect(bundle.scope.authorized).toBeFalse();
    expect(bundle.tasks.length).toBe(0);
    expect(bundle.warnings.some(w => w.code === 'CROSS_WORKSPACE_UNAUTHORIZED')).toBeTrue();
  });

  test('unsupported adapter fails closed with a structured warning', () => {
    const result = invoke([
      '--vault-dir', '/recall-fixture/workspace-a',
      '--sessions-dir', fixtureDir,
      '--adapter', 'claude-local',
    ]);
    expect(result.status).toBe(0);
    const bundle = JSON.parse(result.stdout);
    expect(bundle.adapters.active).toEqual([]);
    expect(bundle.adapters.unsupported).toContain('claude-local');
    expect(bundle.tasks.length).toBe(0);
    expect(bundle.warnings.some(w => w.code === 'ADAPTER_UNSUPPORTED')).toBeTrue();
  });

  test('redacts sensitive fixture content end to end', () => {
    const result = invoke([
      '--vault-dir', '/recall-fixture/workspace-a',
      '--sessions-dir', fixtureDir,
      '--query', '服务',
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('glpat-test-abcdefghijklmnop123456789');
    expect(result.stdout).not.toContain('wuke@example.com');
    expect(result.stdout).toContain('[REDACTED:api-key]');
    const bundle = JSON.parse(result.stdout);
    const task = bundle.tasks.find((t: { taskId: string }) => t.taskId === 'task-s-001');
    expect(task).toBeDefined();
    expect(task.evidence.some((e: { redacted: boolean }) => e.redacted)).toBeTrue();
  });
});

// silence unused import type in some TS configs
void (null as unknown as RecallWarning);
