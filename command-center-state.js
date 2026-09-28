// Bounded command-center mutations. Private cash records never enter the public shell.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const monthKey = () => new Intl.DateTimeFormat('en-CA', {timeZone:'America/Denver',year:'numeric',month:'2-digit'}).format(new Date());
const revision = raw => crypto.createHash('sha256').update(raw).digest('hex');
function validateRegistry(raw) {
  const r = JSON.parse(raw);
  if (!r || typeof r !== 'object' || Array.isArray(r)) throw new Error('Registry must be an object.');
  for (const key of ['businesses','pages','backends','inbox_queries','projects']) {
    if (!Array.isArray(r[key])) throw new Error(`Registry ${key} must remain an array.`);
    const ids = r[key].map(x => x && x.id);
    if (ids.some(x => typeof x !== 'string' || !x) || new Set(ids).size !== ids.length) throw new Error(`Registry ${key} needs unique IDs.`);
  }
  if (!r.targets || typeof r.targets !== 'object') throw new Error('Registry targets must be preserved.');
  return r;
}
function atomicWrite(file, raw) {
  fs.mkdirSync(path.dirname(file), {recursive:true,mode:0o700});
  const tmp = file + '.' + crypto.randomUUID() + '.tmp';
  fs.writeFileSync(tmp,raw,{mode:0o600});
  fs.renameSync(tmp,file);
}
function statePath(root) {return path.join(root,'private/cortana/command-center-goals.json');}
function readState(root) {
  const file=statePath(root);
  const raw=fs.existsSync(file)?fs.readFileSync(file,'utf8'):'{"months":{}}';
  const data=JSON.parse(raw);
  if (!data.months || typeof data.months !== 'object' || Array.isArray(data.months)) throw new Error('Goals file is invalid; restore it before saving.');
  return {data,revision:revision(raw)};
}
function getGoals(root, targets = {}) {
  const month=monthKey(), state=readState(root), saved=state.data.months[month] || {};
  const targetsCurrent = targets.target_month === month;
  return {
    month, revision:state.revision,
    cash_goal_usd: saved.cash_goal_usd ?? (targetsCurrent ? targets.cash_goal_usd ?? null : null),
    mrr_goal_usd: saved.mrr_goal_usd ?? (targetsCurrent ? targets.mrr_goal_usd ?? null : null),
    cash_collected_usd: saved.cash_collected_usd ?? null,
    confirmed_at: saved.confirmed_at || null,
    identity: saved.identity ?? targets.identity ?? '',
    focus_goal: saved.focus_goal ?? targets.focus_goal ?? '',
    updated_at:saved.updated_at || null,
  };
}
function updateGoals(root,input) {
  const r=validateRegistry(fs.readFileSync(path.join(root,'FGA-AIOS/command-center/registry.json'),'utf8'));
  const allowed=['revision','month','cash_goal_usd','mrr_goal_usd','cash_collected_usd','identity','focus_goal'];
  if (!input || Object.keys(input).some(k=>!allowed.includes(k))) throw new Error('Unsupported goal field.');
  const state=readState(root), month=monthKey();
  if (input.revision!==state.revision) throw new Error('Goals changed elsewhere. Refresh before saving.');
  if (input.month!==month) throw new Error('Only the current month can be updated here.');
  const changes={};
  for(const key of ['cash_goal_usd','mrr_goal_usd','cash_collected_usd']) {
    if (!(key in input)) continue;
    if (input[key]===null && key==='cash_collected_usd') {changes[key]=null;continue;}
    if (typeof input[key]!=='number' || !Number.isFinite(input[key]) || input[key]<0 || input[key]>1e9 || Math.abs(input[key]*100-Math.round(input[key]*100))>1e-5) throw new Error('Money must be a nonnegative amount with at most two decimal places.');
    if (key!=='cash_collected_usd' && input[key]===0) throw new Error('Targets must be greater than zero.');
    changes[key]=input[key];
  }
  for(const key of ['identity','focus_goal']) {
    if (!(key in input)) continue;
    if(typeof input[key]!=='string' || input[key].length>500) throw new Error('Goal text must be 500 characters or fewer.');
    changes[key]=input[key].trim();
  }
  const now=new Date().toISOString();
  if ('cash_collected_usd' in changes) changes.confirmed_at=changes.cash_collected_usd===null?null:now;
  const previous=state.data.months[month] || {};
  state.data.months[month]={...previous,...changes,updated_at:now};
  // A local audit trail records corrections to totals, not additional payments.
  state.data.history=state.data.history || [];
  state.data.history.push({month,at:now,previous,changes});
  atomicWrite(statePath(root),JSON.stringify(state.data,null,2)+'\n');
  return getGoals(root,r.targets);
}
const dayKey = () => new Intl.DateTimeFormat('en-CA', {timeZone:'America/Denver',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
function readWork(root) {
  const registryRaw=fs.readFileSync(path.join(root,'FGA-AIOS/command-center/registry.json'),'utf8');
  const registry=validateRegistry(registryRaw);
  const file=path.join(root,'private/cortana/command-center-work.json');
  const raw=fs.existsSync(file)?fs.readFileSync(file,'utf8'):'{"completed":{},"history":[]}';
  const data=JSON.parse(raw);
  if(!data.completed || typeof data.completed!=='object' || Array.isArray(data.completed) || !Array.isArray(data.history)) throw new Error('Work record is invalid. Restore it before making changes.');
  return {file,data,registry,revision:revision(registryRaw+'\n'+raw)};
}
function getWork(root) {
  const state=readWork(root), day=dayKey();
  return {revision:state.revision,day,projects:state.registry.projects.map(p=>{
    const entry=Object.prototype.hasOwnProperty.call(state.data.completed,p.id)?state.data.completed[p.id]:null;
    const done=entry && (p.repeat!=='daily'||entry.day===day);
    return {...p,...(done?{state:'done',completed_at:entry.at}:{})};
  })};
}
function updateWork(root,input) {
  if(!input || Object.keys(input).some(k=>!['id','completed','revision'].includes(k)) || typeof input.id!=='string' || typeof input.completed!=='boolean') throw new Error('Choose an existing item and a completion state.');
  const state=readWork(root);
  if(input.revision!==state.revision) throw new Error('Items changed elsewhere. Refresh before checking this off.');
  const item=state.registry.projects.find(p=>p.id===input.id);
  if(!item) throw new Error('Item was not found. Refresh the dashboard.');
  if(item.state==='done') throw new Error('This item is already recorded as complete.');
  const at=new Date().toISOString();
  if(input.completed)state.data.completed[input.id]={at,day:dayKey()};
  else delete state.data.completed[input.id];
  state.data.history.push({id:input.id,completed:input.completed,at});
  atomicWrite(state.file,JSON.stringify(state.data,null,2)+'\n');
  return getWork(root);
}
module.exports={getGoals,updateGoals,validateRegistry,monthKey,getWork,updateWork,dayKey};
