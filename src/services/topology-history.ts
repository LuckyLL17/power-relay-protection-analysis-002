export type TopologyWindow = { asOf: string | null; changes: any[]; excludedAfterFault: any[]; skipped: { change: any; reason: string }[]; note: string };
const parseMs = (v: any) => { if (typeof v === 'number' && Number.isFinite(v)) return v; if (typeof v === 'string' && v) { const ms = Date.parse(v); if (Number.isFinite(ms)) return ms; } return NaN; };
// 追溯时间边界：只保留生效时间早于或等于故障时间的拓扑变更，按生效时间升序、同刻按登记顺序稳定排列
export function topologyHistoryAt(changes: any[], occurredAt: any): TopologyWindow {
  const list = Array.isArray(changes) ? changes : [];
  const asOfMs = parseMs(occurredAt);
  if (!Number.isFinite(asOfMs)) return { asOf: null, changes: [], excludedAfterFault: [], skipped: list.map(change => ({ change, reason: 'fault occurredAt missing or invalid' })), note: '故障时间缺失或非法，无法按时间边界筛选拓扑变更' };
  const effective: { change: any; ms: number; seq: number }[] = []; const excludedAfterFault: any[] = []; const skipped: { change: any; reason: string }[] = [];
  list.forEach((change, seq) => { const ms = parseMs(change?.effectiveAt); if (!Number.isFinite(ms)) { skipped.push({ change, reason: 'effectiveAt missing or invalid' }); return; } if (ms <= asOfMs) effective.push({ change, ms, seq }); else excludedAfterFault.push(change); });
  effective.sort((a, b) => a.ms - b.ms || a.seq - b.seq);
  const note = effective.length === 0 ? '故障发生时无已生效的拓扑变更' : `故障时间之前（含同刻）已生效的拓扑变更共 ${effective.length} 条`;
  return { asOf: new Date(asOfMs).toISOString(), changes: effective.map(x => x.change), excludedAfterFault, skipped, note };
}
