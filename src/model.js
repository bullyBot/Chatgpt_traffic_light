export const CONFIRM_MS = 2500;
export const STALE_MS = 90000;
export const LABELS = {
  running: '正在进行', attention: '需要你处理', complete: '已完成',
  idle: '空闲', stopped: '已停止', unknown: '未识别', error: '任务异常'
};

export function canonicalUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !['chatgpt.com', 'chat.openai.com'].includes(url.hostname)) return null;
    return url.origin + url.pathname;
  } catch { return null; }
}

// A completion is a confirmed transition within an observed run, never a timeout.
export function transition(previous, observation, now) {
  const sameDocument = previous?.documentId === observation.documentId && previous?.url === observation.url;
  const old = sameDocument ? previous : null;
  const task = {
    ...old, url: observation.url, documentId: observation.documentId,
    title: observation.title || 'ChatGPT 任务', lastSeen: now, diagnostics: observation.diagnostics || null,
    cycle: old?.cycle || 0, active: old?.active || false,
    status: 'unknown', reason: observation.reason || '', candidate: null, waitingForUser: false
  };
  const events = [];
  const startCycle = () => {
    task.cycle += 1;
    task.active = true;
    task.baseline = observation.completionKey || '';
    task.cancelled = false;
    task.notifiedAttention = null;
  };

  if (observation.cancelled) {
    task.status = 'stopped';
    task.active = false;
    task.cancelled = true;
    task.reason = '已停止；不会发送完成提醒';
    return { task, events };
  }
  const answered = observation.diagnostics?.reply?.latestRole === 'user';
  const terminalTask = observation.state === 'completed' && observation.completionKey?.startsWith('task:') && observation.completionKey !== old?.baseline;
  if ((old?.waitingForUser || old?.status === 'attention') && !answered && !terminalTask && ['unknown', 'idle', 'completed'].includes(observation.state)) {
    task.status = 'attention';
    task.waitingForUser = true;
    task.reason = '正在等待你处理；回复结束或输入框就绪不代表请求已解决';
    return { task, events };
  }
  if (observation.state === 'running') {
    if (old?.cancelled) {
      task.status = 'stopped';
      task.reason = '正在停止；不会发送完成提醒';
      return { task, events };
    }
    if (!task.active) startCycle();
    task.status = 'running';
    task.notifiedAttention = null;
  } else if (observation.state === 'attention') {
    if (!task.active) startCycle();
    task.cancelled = false;
    task.status = 'attention';
    task.waitingForUser = true;
    const key = observation.attentionKey || observation.reason;
    if (task.notifiedAttention !== key) events.push('attention');
    task.attentionKey = key;
    task.notifiedAttention = key;
  } else if (observation.state === 'completed') {
    task.cancelled = false;
    const key = observation.completionKey;
    if (old?.status === 'complete' && old?.finishedKey === key) {
      task.status = 'complete';
    } else if (task.active && key && key !== task.baseline) {
      const candidate = old?.candidate?.key === key && now - old.lastSeen <= STALE_MS ? old.candidate : { key, since: now };
      task.candidate = candidate;
      task.status = 'unknown';
      task.reason = '检测到结束标记，正在确认';
      if (now - candidate.since >= CONFIRM_MS) {
        task.status = 'complete';
        task.active = false;
        task.finishedKey = key;
        task.candidate = null;
        task.reason = '已确认本轮任务完成';
        events.push('complete');
      }
    } else {
      task.status = task.active ? 'unknown' : 'idle';
      task.reason = task.active ? '等待本轮任务的完成证据' : '已有结束标记；未观察到本轮执行，不发送通知';
    }
  } else if (observation.state === 'idle') {
    task.cancelled = false;
    task.status = task.active ? 'unknown' : 'idle';
    if (task.active) task.reason = '执行信号已消失，尚未确认完成';
  } else if (observation.state === 'error') {
    task.status = 'error';
    task.active = false;
    task.cancelled = false;
  } else if (observation.state === 'stopped') {
    task.status = 'stopped';
    task.active = false;
    task.cancelled = false;
  } else if (old?.status === 'stopped' && !task.active) {
    task.status = 'stopped';
    task.cancelled = false;
    task.reason = old.reason;
  }
  return { task, events };
}

export function displayedTask(task, now) {
  if (now - task.lastSeen > STALE_MS) return { ...task, status: 'unknown', reason: '页面暂未更新，请打开任务确认' };
  return task;
}

export function aggregate(tasks) {
  for (const status of ['attention', 'running', 'error', 'unknown', 'stopped', 'complete', 'idle']) {
    if (tasks.some(task => task.status === status)) return status;
  }
  return 'unknown';
}
