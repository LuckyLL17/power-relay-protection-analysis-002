import test from 'node:test'; import assert from 'node:assert/strict';
import { topologyHistoryAt } from '../src/services/topology-history.js';
import { buildApp } from '../src/app.js';
import { analyses, audits, events, topologyChanges } from '../src/domain/state.js';

const T = '2026-10-01T12:00:00.000Z';

test('boundary: pre-fault and same-time changes included, post-fault excluded, stable order', () => {
  const changes = [
    { id: 'after', effectiveAt: '2026-10-02T00:00:00.000Z' },
    { id: 'same-1', effectiveAt: T },
    { id: 'before-2', effectiveAt: '2026-09-30T08:00:00.000Z' },
    { id: 'same-2', effectiveAt: T },
    { id: 'before-1', effectiveAt: '2026-09-01T00:00:00.000Z' },
  ];
  const w = topologyHistoryAt(changes, T);
  assert.deepEqual(w.changes.map((c: any) => c.id), ['before-1', 'before-2', 'same-1', 'same-2']);
  assert.deepEqual(w.excludedAfterFault.map((c: any) => c.id), ['after']);
  assert.equal(w.asOf, T);
  assert.equal(w.skipped.length, 0);
  assert.match(w.note, /4 条/);
});

test('no changes: empty window with explanation', () => {
  const w = topologyHistoryAt([], T);
  assert.deepEqual(w.changes, []);
  assert.equal(w.note, '故障发生时无已生效的拓扑变更');
});

test('change with missing or invalid effectiveAt is skipped with reason, not dropped silently', () => {
  const w = topologyHistoryAt([{ id: 'ok', effectiveAt: T }, { id: 'bad' }, { id: 'bad2', effectiveAt: 'not-a-date' }], T);
  assert.deepEqual(w.changes.map((c: any) => c.id), ['ok']);
  assert.deepEqual(w.skipped.map((s: any) => s.change.id), ['bad', 'bad2']);
  assert.equal(w.skipped[0].reason, 'effectiveAt missing or invalid');
});

test('missing or invalid fault occurredAt: explainable empty window', () => {
  for (const occurredAt of [undefined, null, '', 'not-a-date']) {
    const w = topologyHistoryAt([{ id: 'c1', effectiveAt: T }], occurredAt);
    assert.equal(w.asOf, null);
    assert.deepEqual(w.changes, []);
    assert.equal(w.skipped.length, 1);
    assert.equal(w.note, '故障时间缺失或非法，无法按时间边界筛选拓扑变更');
  }
});

test('trace endpoint: topology window added, event/analyses/audit semantics unchanged', async () => {
  events.length = 0; analyses.length = 0; topologyChanges.length = 0; audits.length = 0;
  const app = await buildApp();
  const mk = (effectiveAt: any, targetId: string) => app.inject({ method: 'POST', url: '/api/topology/changes', payload: { type: 'breaker-state', targetId, toState: 'open', ...(effectiveAt !== undefined ? { effectiveAt } : {}) } }).then(r => r.json());
  const before = await mk('2026-09-30T08:00:00.000Z', 'BR-A1');
  const same1 = await mk(T, 'BR-B1');
  const same2 = await mk(T, 'BR-C1');
  const after = await mk('2026-10-02T00:00:00.000Z', 'BR-A1');
  const invalid = await mk('not-a-date', 'BR-B1');

  const event = await app.inject({ method: 'POST', url: '/api/fault-events', payload: { lineId: 'L-AB', type: 'single-line-ground', occurredAt: T } }).then(r => r.json());
  await app.inject({ method: 'POST', url: `/api/fault-events/${event.id}/replay`, payload: {} });

  const res = await app.inject({ method: 'GET', url: `/api/fault-events/${event.id}/trace` });
  assert.equal(res.statusCode, 200);
  const body = res.json();

  // 事件和分析不丢失，字段保持原样（replay 后状态推进为 analyzed 是既有行为）
  assert.deepEqual(body.event, { ...event, status: 'analyzed' });
  assert.equal(body.analyses.length, 1);
  assert.equal(body.analyses[0].eventId, event.id);

  // 故障前 + 同刻生效，故障后排除，非法时间进入 skipped，按生效时间稳定排序
  assert.deepEqual(body.topology.changes.map((c: any) => c.id), [before.id, same1.id, same2.id]);
  assert.deepEqual(body.topology.excludedAfterFault.map((c: any) => c.id), [after.id]);
  assert.deepEqual(body.topology.skipped.map((s: any) => s.change.id), [invalid.id]);
  assert.equal(body.topology.asOf, T);

  // 其他拓扑查询与审计语义不变
  const topo = await app.inject({ method: 'GET', url: '/api/grid/topology' }).then(r => r.json());
  assert.equal(topo.topologyVersion, 6);
  assert.equal(audits.filter(a => a.action === 'topology.change').length, 5);
  await app.close();
});
