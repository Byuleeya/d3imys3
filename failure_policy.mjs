// Read-only schedule monitoring: persistent HTTP errors must never look like unopened schedules.
// Repeated 502 is an upstream failure, NOT evidence of a sold-out/unopened date.
export function summarizeSourceErrors(err) {
  if (!err?.errors?.length) return String(err?.message || err).replace(/\s+/g,' ').slice(0,240);
  return err.errors.map(x=>{
    const code=x.http ? `HTTP ${x.http}` : '응답 형식/연결 오류';
    const source=x.source==='relay'?'Relay':x.source==='direct'?'CGV 직접':'조회';
    // Do not forward full HTML error pages, tokens, or upstream diagnostics to Telegram.
    return `${source}: ${code}`;
  }).join(' | ');
}
export function classifyFailure(err) {
  if (err?.errors?.some(x=>x.http===403||x.http===429)) return 'BLOCKED';
  if (err?.errors?.some(x=>x.http===502||x.http===503||x.http===504)) return 'UPSTREAM_UNAVAILABLE';
  if (err?.errors?.some(x=>x.http>=500)) return 'SERVER_ERROR';
  return 'UNKNOWN';
}
export function nextFailureDelayMs(err, failures, minSeconds=60, maxSeconds=90, random=Math.random) {
  const category=classifyFailure(err);
  if (category==='BLOCKED') return null; // stop; no automatic repeated retries after a clear access refusal.
  const lo=Math.max(30,Math.min(minSeconds,maxSeconds));
  const hi=Math.max(lo,maxSeconds,minSeconds);
  // Never turn an outage into a 5-second request flood. Retain a chance to discover recovery.
  const base=Math.round((lo+Math.max(0,Math.min(1,random()))*(hi-lo))*1000);
  return Math.min(300000,base+(failures>=12?30000:0));
}
