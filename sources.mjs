import { parseTimetable } from './parser.mjs';

export async function fetchJSON(url, timeoutMs, abortSignal) {
  const ctrl=new AbortController();
  const timer=setTimeout(()=>ctrl.abort(new Error('request timeout')), timeoutMs);
  const abort=()=>ctrl.abort(); abortSignal?.addEventListener('abort',abort,{once:true});
  try {
    const r=await fetch(url,{signal:ctrl.signal,headers:{
      Accept:'application/json','Accept-Language':'ko-KR,ko;q=0.9',
      'Cache-Control':'no-cache',Pragma:'no-cache'
    }});
    const raw=await r.text();
    if(!r.ok) {
      const e=new Error(`HTTP ${r.status}: ${raw.replace(/\s+/g,' ').slice(0,250)}`); e.http=r.status;
      const retry=Number(r.headers.get('retry-after')); e.retryAfter=Number.isFinite(retry)?retry:null;
      throw e;
    }
    let payload;
    try {payload=JSON.parse(raw);} catch {throw new Error(`비JSON 응답: ${raw.replace(/\s+/g,' ').slice(0,250)}`);}
    return {payload, headers:r.headers};
  } finally {clearTimeout(timer);abortSignal?.removeEventListener('abort',abort);}
}

export function buildUrl(source, date, cfg, now=Date.now()) {
  const url=new URL(source==='relay' ? cfg.relayUrl:cfg.directUrl);
  if (source==='relay') {
    url.searchParams.set('playDate',date);
    url.searchParams.set('theaterCode',cfg.theaterCode);
    url.searchParams.set('limit','500');
    url.searchParams.set('timeoutMs',String(cfg.timeoutMs));
  } else {
    url.searchParams.set('coCd','A420');
    url.searchParams.set('siteNo',cfg.theaterCode);
    url.searchParams.set('scnYmd',date);
    url.searchParams.set('rtctlScopCd','08');
  }
  if (cfg.cacheBust) url.searchParams.set('_cb',String(now));
  return url.toString();
}

export async function querySchedule(date,cfg,network=fetchJSON,{requireShows=false}={}) {
  const errors=[];
  for(const source of ['relay','direct']) {
    if (source==='relay'&&!cfg.relayUrl) continue;
    if (source==='direct'&&!cfg.directUrl) continue;
    try {
      const url=buildUrl(source,date,cfg);
      const {payload,headers}=await network(url,cfg.timeoutMs);
      const parsed=parseTimetable(payload,date,{movieNo:cfg.movieNo,siteNo:cfg.theaterCode,capacity:cfg.imaxCapacity});
      if (requireShows && parsed.shows.length===0) throw new Error(`${date} 기준일의 듄 파트3 IMAX 상영이 확인되지 않음 (API 검증 필요)`);
      const cacheAge=Number(headers?.get?.('age'));
      return {...parsed,source,cacheAge:Number.isFinite(cacheAge)?cacheAge:null, errors};
    } catch(e) {
      errors.push({source, message:String(e.message||e).slice(0,500),http:e.http||null, retryAfter:e.retryAfter||null});
    }
  }
  const err=new Error(`모든 시간표 조회 경로 실패: ${errors.map(x=>`${x.source}:${x.message}`).join(' | ')}`);
  err.errors=errors;
  err.http=errors.find(x=>x.http===429)?.http || errors.find(x=>x.http===403)?.http || errors.find(x=>x.http)?.http || null;
  err.retryAfter=Math.max(0,...errors.map(x=>x.retryAfter||0));
  throw err;
}
