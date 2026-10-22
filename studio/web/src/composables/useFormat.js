/** Cell/number formatters shared by tables. */

export function fmtTs(ts) {
  return ts ? new Date(Number(ts)).toLocaleString('zh-CN', { hour12: false }) : '-';
}

export function fmtUptime(sec) {
  if (!sec) return '-';
  if (sec > 3600) return `${Math.floor(sec / 3600)}h${Math.floor((sec % 3600) / 60)}m`;
  return `${Math.floor(sec / 60)}m${Math.floor(sec % 60)}s`;
}

/** Megabytes with two decimals, used by firmware size columns and logs. */
export function mb(size) {
  return (size / 1024 / 1024).toFixed(2);
}

/** Table cell renderer: keeps objects readable and empties as "-". */
export function cell(v) {
  if (v === null || v === undefined) return '-';
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}
