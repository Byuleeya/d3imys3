import fs from 'node:fs';
import path from 'node:path';
import { addDays, prettyDate, pickDate } from './parser.mjs';
import { querySchedule } from './sources.mjs';
import { classifyFailure, summarizeSourceErrors, nextFailureDelayMs } from './failure_policy.mjs';

const env=(k,d='')=>String(process.env[k]??d).trim();
const nenv=(k,d,min)=>Math.max(min,Number(env(k,String(d)))||d);
const CFG={
 token:env('TELEGRAM_BOT_TOKEN'),chatId:env('TELEGRAM_CHAT_ID'),
 theaterCode:env('THEATER_CODE','0013'), movieNo:env('MOVIE_NO','30001790'),
 start:env('START_DATE','20261221'),end:env('END_DATE','20270110'),
 knownOpenDate:env('KNOWN_OPEN_DATE','20261220'),
 relayUrl:env('RELAY_URL','https://mcp.aka.page/api/cgv/timetable'),
 // CGV returned 403 from Railway. Disable repeated direct requests by default.
 // If your account/site explicitly allows access, this can be enabled using an env variable.
 directUrl:env('ENABLE_DIRECT_FALLBACK','false').toLowerCase()==='true'
   ? env('DIRECT_URL','https://cgv.co.kr/api/v1/booking/searchMovScnInfo') : '',
 pollMin:nenv('POLL_MIN_SECONDS',5,5),pollMax:nenv('POLL_MAX_SECONDS',7,5),
 errorPollMin:nenv('ERROR_POLL_MIN_SECONDS',60,30),errorPollMax:nenv('ERROR_POLL_MAX_SECONDS',90,30),
 timeoutMs:nenv('REQUEST_TIMEOUT_MS',8000,2500),
 cacheBust:env('CACHE_BUST','true').toLowerCase()!=='false',
 errorCooldownMs:nenv('ERROR_ALERT_COOLDOWN_SECONDS',1800,300)*1000,
 baselineRecheckMs:nenv('BASELINE_RECHECK_MINUTES',15,5)*60000,
 imaxCapacity:nenv('IMAX_CAPACITY',624,1),
 stateFile:env('STATE_FILE','/data/dune3-imax-state.json')
};
if(!/^\d{8}$/.test(CFG.start)||!/^\d{8}$/.test(CFG.end)||CFG.end<CFG.start) throw new Error('START_DATE/END_DATE는 YYYYMMDD 순서로 설정');
if (!CFG.token || !CFG.chatId) throw new Error('TELEGRAM_BOT_TOKEN 과 TELEGRAM_CHAT_ID 설정 필요');
const BASE_LINK='https://cgv.co.kr/cnm/movieBook/movie';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const log=(...a)=>console.log(`[${new Date().toLocaleString('ko-KR',{timeZone:'Asia/Seoul',hour12:false})} KST]`,...a);
function kstDate(){const p=new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());const q=Object.fromEntries(p.map(x=>[x.type,x.value]));return q.year+q.month+q.day;}
const jitter=()=>1000*(Math.min(CFG.pollMin,CFG.pollMax)+Math.random()*Math.abs(CFG.pollMax-CFG.pollMin));
function newState(){return {version:2,cursor:CFG.start,openedDates:{},seen:{},baselineVerified:false};}
function loadState(){try{return {...newState(),...JSON.parse(fs.readFileSync(CFG.stateFile,'utf8'))};}catch{return newState();}}
let state=loadState();
function saveState(){fs.mkdirSync(path.dirname(CFG.stateFile),{recursive:true});const tmp=CFG.stateFile+'.tmp';fs.writeFileSync(tmp,JSON.stringify(state,null,2));fs.renameSync(tmp,CFG.stateFile);}
async function tg(text,{silent=false}={}){
 const ctrl=new AbortController(), timer=setTimeout(()=>ctrl.abort(),12000);
 try{const r=await fetch(`https://api.telegram.org/bot${CFG.token}/sendMessage`,{method:'POST',headers:{'Content-Type':'application/json'},signal:ctrl.signal,body:JSON.stringify({chat_id:CFG.chatId,text,disable_notification:silent,disable_web_page_preview:true})});if(!r.ok)throw new Error(`Telegram HTTP ${r.status}: ${(await r.text()).slice(0,100)}`);}finally{clearTimeout(timer);}
}
function bookingLink(date){return `${BASE_LINK}?${new URLSearchParams({movNo:CFG.movieNo,siteNo:CFG.theaterCode,scnYmd:date})}`;}
function formatShow(s){let x=`• ${s.time}${s.end?`~${s.end}`:''} / ${s.hall}`;if(s.remaining!=null)x+=` / 잔여 ${s.remaining}${s.total!=null?`/${s.total}`:''}석`;return x;}
async function handleShows(date,shows,source){
 const known=new Set(state.seen[date]||[]), fresh=shows.filter(x=>!known.has(x.key));
 if(fresh.length){const summary=fresh.slice(0,12).map(formatShow).join('\n');
  await tg(`🚨 [CGV 용산 IMAX 예매 오픈!]\n\n🎬 듄: 파트 3\n📅 ${prettyDate(date)}\n📍 용산아이파크몰 IMAX\n🆕 새 회차 ${fresh.length}건\n\n${summary}${fresh.length>12?'\n(나머지 회차 생략)':''}\n\n좌석 확인: ${bookingLink(date)}`);
  log(`OPEN ${date}: 신규=${fresh.length}, 전체=${shows.length}, source=${source}`);
  state.seen[date]=[...new Set([...known,...shows.map(x=>x.key)])];
 }
 state.openedDates[date]=true;
 if(date===state.cursor){let next=addDays(date,1);while(next<=CFG.end&&state.openedDates[next])next=addDays(next,1);state.cursor=next;}
 saveState();
}
let stopping=false, startupSent=false, baselineLastTry=0, baselineFailureCount=0, targetFailureCount=0, targetErrorAlertAt=0, lastTargetErrorCategory='';
process.on('SIGTERM',()=>{stopping=true;log('SIGTERM: 종료 처리');});process.on('SIGINT',()=>{stopping=true;log('SIGINT: 종료 처리');});
async function alertFailure(date,err){
 const cls=classifyFailure(err), brief=summarizeSourceErrors(err),now=Date.now();
 log(`조회불가 ${date}: 상태=${cls}, 대상날짜 연속실패=${targetFailureCount}, ${brief}`);
 if(now-targetErrorAlertAt>=CFG.errorCooldownMs||!targetErrorAlertAt||cls!==lastTargetErrorCategory){
  targetErrorAlertAt=now;lastTargetErrorCategory=cls;
  try{await tg(`⚠️ [듄3 용산 IMAX] ${prettyDate(date)} 조회 불가\n${brief}\n연속 실패 ${targetFailureCount}회\n\n12/20 기준일 정상조회와 별개로, 이 날짜의 예매 오픈은 확인할 수 없습니다. 정상 미오픈으로 간주하지 않습니다.`);}catch(e){log('오류 알림 전송 실패:',e.message);}
 }
}
async function main(){
 log('CGV 용산 IMAX 듄 파트3 오픈 감시 v1.2 (Docker import fix; 로그인/좌석선점 없음)');
 log(`감시: ${CFG.start}~${CFG.end} / 성공 시 ${CFG.pollMin}~${CFG.pollMax}초, 조회 오류 시 ${CFG.errorPollMin}~${CFG.errorPollMax}초`);
 log(`Relay=${CFG.relayUrl}, CGV 직접=${CFG.directUrl?'활성':'비활성(기존 403 때문에)'} / 기준일 ${CFG.knownOpenDate} 15분 간격 검증`);
 let tick=0;
 while(!stopping){
  if(kstDate()>CFG.end||(state.cursor>CFG.end&&tick>0)){
   log('감시 종료: 지정한 날짜 범위 완료');try{await tg('⏹ [듄3 용산 IMAX] 감시 날짜 범위가 종료됐습니다.',{silent:true});}catch{}return;
  }
  const needsBaseline=kstDate()<=CFG.knownOpenDate&&(!state.baselineVerified||!state.lastVerifiedAt||Date.now()-Date.parse(state.lastVerifiedAt)>=CFG.baselineRecheckMs);
  if(needsBaseline){
   if(Date.now()-baselineLastTry<CFG.baselineRecheckMs){await sleep(Math.min(30000,CFG.baselineRecheckMs-(Date.now()-baselineLastTry)));continue;}
   baselineLastTry=Date.now();
   try{
    const x=await querySchedule(CFG.knownOpenDate,CFG,undefined,{requireShows:true});
    state.baselineVerified=true;state.lastVerifiedAt=new Date().toISOString();saveState();baselineFailureCount=0;
    // IMPORTANT: Do not reset targetFailureCount: known-date success does not imply target-date success.
    log(`기준일 ${CFG.knownOpenDate} 검증 성공: 듄3 IMAX ${x.shows.length}회차 / ${x.source}. 대상 날짜 연속실패=${targetFailureCount}`);
   }catch(err){
    state.baselineVerified=false;saveState();baselineFailureCount++;
    const brief=summarizeSourceErrors(err);
    log(`기준일 조회 실패 ${baselineFailureCount}회: ${brief}`);
    if(baselineFailureCount===1||baselineFailureCount%4===0){try{await tg(`⚠️ [듄3 용산 IMAX] 기존 열린 ${prettyDate(CFG.knownOpenDate)}도 조회 실패\n${brief}\n현재 감시 검증 중단`);}catch{}}
    if(classifyFailure(err)==='BLOCKED'){log('접근 제한 명시, 조회 자동 중단');return;}
    await sleep(Math.max(60000,nextFailureDelayMs(err,baselineFailureCount,CFG.errorPollMin,CFG.errorPollMax)||60000));continue;
   }
  }
  if(!startupSent){
   try{await tg(`✅ [CGV 용산 IMAX 듄: 파트 3] 감시 프로그램 실행\n12/16~12/20 제외\n감시 날짜 ${prettyDate(CFG.start)}부터 ${prettyDate(CFG.end)}\n\n⚠️ 기준일 정상조회는 미래 날짜 정상조회를 보장하지 않습니다. 신규 날짜 조회 오류 발생 시 별도 알림이 갑니다.\n로그인·좌석 선택 없음`,{silent:true});startupSent=true;}
   catch(e){log('Telegram 시작 알림 실패:',e.message);await sleep(30000);continue;}
  }
  const date=pickDate(state,CFG.start,CFG.end,tick++,7);if(!date){log('설정된 모든 날짜가 이미 열렸음');return;}
  try{
   const r=await querySchedule(date,CFG);
   if(targetFailureCount){
    log(`조회 복구: ${date} / ${r.source} / 직전 대상 날짜 조회 실패 ${targetFailureCount}회`);
    try{await tg(`✅ [듄3 용산 IMAX] ${prettyDate(date)} 조회 복구\n${r.source} 경로 정상 응답\n이번 조회 IMAX ${r.shows.length}회차`,{silent:true});}catch(e){log('복구 알림 실패:',e.message);}
    targetFailureCount=0;lastTargetErrorCategory='';
   }
   if(r.shows.length>0)await handleShows(date,r.shows,r.source);
   else if(tick<=4||tick%10===0)log(`${date}: 정상 API 응답, 듄3 IMAX 신규 회차 0건 / ${r.source} / 후보 ${r.candidateCount}`);
   await sleep(jitter());
  }catch(err){
   targetFailureCount++;await alertFailure(date,err);
   const delay=nextFailureDelayMs(err,targetFailureCount,CFG.errorPollMin,CFG.errorPollMax);
   if(delay===null){
    log('접근 제한 응답이 확인되어 감시를 중단합니다. 차단 우회 및 반복 재시도 없음.');
    try{await tg(`⛔ [듄3 용산 IMAX] 서버 접근 거부. ${summarizeSourceErrors(err)}\n자동 재시도를 중단했습니다.`);}catch{}
    return;
   }
   await sleep(delay);
  }
 }
 log('감시 종료');
}
main().catch(async e=>{log('FATAL',e.stack||e);try{await tg('🚨 [듄3 용산 IMAX] 감시봇 오류\n'+String(e.message||e).slice(0,200));}catch{}process.exitCode=1;});
