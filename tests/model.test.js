import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregate, canonicalUrl, CONFIRM_MS, displayedTask, STALE_MS, transition } from '../src/model.js';

const observation = (state, extra = {}) => ({ state, kind: 'chat', documentId: 'document-1', url: 'https://chatgpt.com/c/one', title: 'Test task', completionKey: 'old', ...extra });
function step(previous, state, time = 0, extra = {}) { return transition(previous, observation(state, extra), time); }
test('old replies and a fresh idle page never send completion notifications', () => {
  for (const state of ['completed', 'idle']) {
    const result = step(null, state);
    assert.equal(result.task.status, 'idle');
    assert.deepEqual(result.events, []);
  }
});
test('yellow is immediate and repeated observations are deduplicated', () => {
  const first = step(null, 'attention', 0, { attentionKey: 'approval-1' });
  assert.equal(first.task.status, 'attention');
  assert.deepEqual(first.events, ['attention']);
  const repeat = step(first.task, 'attention', 10, { attentionKey: 'approval-1' });
  assert.deepEqual(repeat.events, []);
  const gap = step(repeat.task, 'unknown', 20);
  assert.deepEqual(step(gap.task, 'attention', 30, { attentionKey: 'approval-1' }).events, []);
});
test('a distinct request and a request after resumed execution notify again', () => {
  const first = step(null, 'attention', 0, { attentionKey: 'one' });
  assert.deepEqual(step(first.task, 'attention', 1, { attentionKey: 'two' }).events, ['attention']);
  const resumed = step(first.task, 'running', 2);
  assert.deepEqual(step(resumed.task, 'attention', 3, { attentionKey: 'one' }).events, ['attention']);
});
test('completion requires an observed run, fresh evidence and a stable confirmation window', () => {
  const start = step(null, 'running');
  const oldReply = step(start.task, 'completed', 100);
  assert.equal(oldReply.task.status, 'unknown');
  assert.deepEqual(oldReply.events, []);
  const candidate = step(oldReply.task, 'completed', 200, { completionKey: 'new' });
  assert.equal(candidate.task.status, 'unknown');
  assert.deepEqual(step(candidate.task, 'completed', 200 + CONFIRM_MS - 1, { completionKey: 'new' }).events, []);
  const final = step(candidate.task, 'completed', 200 + CONFIRM_MS, { completionKey: 'new' });
  assert.equal(final.task.status, 'complete');
  assert.deepEqual(final.events, ['complete']);
  assert.deepEqual(step(final.task, 'completed', 9000, { completionKey: 'new' }).events, []);
});
test('task status completion supports repeated runs at the same task URL', () => {
  let previous;
  for (let i = 0; i < 2; i++) {
    const start = step(previous, 'running', i * 10000, { kind: 'task', completionKey: '' });
    const candidate = step(start.task, 'completed', i * 10000 + 100, { kind: 'task', completionKey: 'task:1' });
    const final = step(candidate.task, 'completed', i * 10000 + 100 + CONFIRM_MS, { kind: 'task', completionKey: 'task:1' });
    assert.deepEqual(final.events, ['complete']);
    previous = final.task;
  }
});
test('historical completed task markers cannot finish a different active task', () => {
  const start = step(null, 'running', 0, { kind: 'task', completionKey: 'old-task' });
  const result = step(start.task, 'completed', 5000, { kind: 'task', completionKey: 'old-task' });
  assert.equal(result.task.status, 'unknown');
  assert.deepEqual(result.events, []);
});
test('streaming resumes or evidence changes: completion confirmation starts over', () => {
  const start = step(null, 'running');
  const candidate = step(start.task, 'completed', 100, { completionKey: 'new' });
  const changed = step(candidate.task, 'completed', 2000, { completionKey: 'newer' });
  assert.deepEqual(step(changed.task, 'completed', 2700, { completionKey: 'newer' }).events, []);
  const resumed = step(changed.task, 'running', 3000);
  assert.equal(resumed.task.candidate, null);
  assert.deepEqual(step(resumed.task, 'completed', 10000, { completionKey: 'newer' }).events, []);
});
test('disappearing run controls, errors and silence cannot complete a task', () => {
  const start = step(null, 'running');
  for (const state of ['idle', 'unknown', 'error']) {
    const result = step(start.task, state, 999999);
    assert.notEqual(result.task.status, 'complete');
    assert.deepEqual(result.events, []);
  }
  assert.equal(displayedTask(start.task, STALE_MS + 1).status, 'unknown');
});
test('reload and SPA navigation invalidate the previous run', () => {
  const start = step(null, 'running');
  for (const extra of [{ documentId: 'new-document' }, { url: 'https://chatgpt.com/c/two' }]) {
    const result = step(start.task, 'completed', 5000, { ...extra, completionKey: 'new' });
    assert.equal(result.task.status, 'idle');
    assert.deepEqual(result.events, []);
  }
});
test('cancellation suppresses late running and completion signals, but permits a new run', () => {
  const start = step(null, 'running');
  const cancel = step(start.task, 'running', 10, { cancelled: true });
  assert.equal(cancel.task.status, 'stopped');
  const lateRunning = step(cancel.task, 'running', 20);
  assert.equal(lateRunning.task.status, 'stopped');
  assert.equal(lateRunning.task.active, false);
  const lateComplete = step(lateRunning.task, 'completed', 30, { completionKey: 'partial' });
  assert.deepEqual(lateComplete.events, []);
  const again = step(lateComplete.task, 'running', 100, { completionKey: 'partial' });
  assert.equal(again.task.status, 'running');
  assert.equal(again.task.active, true);
});
test('persisted state survives serialization without duplicate completion', () => {
  const start = step(null, 'running');
  const candidate = step(start.task, 'completed', 100, { completionKey: 'new' });
  const restored = JSON.parse(JSON.stringify(candidate.task));
  const final = step(restored, 'completed', 3000, { completionKey: 'new' });
  assert.deepEqual(final.events, ['complete']);
  assert.deepEqual(step(JSON.parse(JSON.stringify(final.task)), 'completed', 4000, { completionKey: 'new' }).events, []);
});
test('stopping stays red while signals disappear and permits the next run without a final reply', () => {
  const start = step(null, 'running');
  const cancel = step(start.task, 'running', 10, { cancelled: true });
  const quiet = step(cancel.task, 'unknown', 20);
  assert.equal(quiet.task.status, 'stopped');
  assert.deepEqual(quiet.events, []);
  assert.equal(step(quiet.task, 'running', 30).task.status, 'running');
  const explicit = step(start.task, 'stopped', 40);
  assert.equal(explicit.task.status, 'stopped');
  assert.deepEqual(explicit.events, []);
  assert.equal(step(explicit.task, 'completed', 50, { completionKey: 'partial' }).task.status, 'idle');
});
test('a stale completion candidate must be confirmed again after reconnecting', () => {
  const start = step(null, 'running');
  const candidate = step(start.task, 'completed', 100, { completionKey: 'new' });
  const resumed = step(candidate.task, 'completed', STALE_MS + 200, { completionKey: 'new' });
  assert.equal(resumed.task.status, 'unknown');
  assert.deepEqual(resumed.events, []);
});
test('aggregate prioritizes attention, then running, then uncertainty over idle', () => {
  assert.equal(aggregate([]), 'unknown');
  assert.equal(aggregate([{ status: 'running' }, { status: 'attention' }]), 'attention');
  assert.equal(aggregate([{ status: 'complete' }, { status: 'running' }]), 'running');
  assert.equal(aggregate([{ status: 'complete' }, { status: 'unknown' }]), 'unknown');
});
test('URL identities discard query strings and reject unrelated origins', () => {
  assert.equal(canonicalUrl('https://chatgpt.com/c/one?secret=value#anchor'), 'https://chatgpt.com/c/one');
  for (const url of ['http://chatgpt.com/', 'https://evil.test/', 'https://chatgpt.com.evil.test/', 'not a url']) assert.equal(canonicalUrl(url), null);
});
test('yellow persists when a pending card vanishes, the composer is ready or its reply ends', () => {
  let task = step(null, 'attention', 0, { attentionKey: 'question' }).task;
  for (const [index, state] of ['unknown', 'idle', 'completed', 'unknown'].entries()) {
    const result = step(task, state, 100 + index * 5000, { completionKey: 'question-reply' });
    assert.equal(result.task.status, 'attention');
    assert.equal(result.task.waitingForUser, true);
    assert.deepEqual(result.events, []);
    task = result.task;
  }
  assert.equal(displayedTask(task, task.lastSeen + STALE_MS + 1).status, 'unknown');
});
test('replying, resuming, cancellation, errors and a new document release the waiting state', () => {
  const wait = step(null, 'attention', 0, { attentionKey: 'question' }).task;
  const answer = step(wait, 'unknown', 100, { diagnostics: { reply: { latestRole: 'user' } } });
  assert.equal(answer.task.status, 'unknown');
  assert.equal(answer.task.waitingForUser, false);
  for (const state of ['running', 'error', 'stopped']) assert.equal(step(wait, state, 200).task.waitingForUser, false);
  assert.equal(step(wait, 'attention', 300, { cancelled: true }).task.status, 'stopped');
  assert.equal(step(wait, 'idle', 400, { documentId: 'new-document' }).task.status, 'idle');
});
test('an explicit task terminal marker can finish after attention without replaying yellow', () => {
  const wait = step(null, 'attention', 0, { attentionKey: 'question', completionKey: '' }).task;
  const candidate = step(wait, 'completed', 100, { completionKey: 'task:done' });
  const final = step(candidate.task, 'completed', 100 + CONFIRM_MS, { completionKey: 'task:done' });
  assert.equal(final.task.status, 'complete');
  assert.deepEqual(final.events, ['complete']);
  const withOldTerminal = step(null, 'attention', 0, { attentionKey: 'question', completionKey: 'task:old' }).task;
  assert.equal(step(withOldTerminal, 'completed', 9999, { completionKey: 'task:old' }).task.status, 'attention');
});
