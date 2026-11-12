'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Worker } = require('node:worker_threads');
const lib = require('../scripts/lib');
test.describe('state locks and session discovery', () => {
  let dir, env;
  test.beforeEach(() => {
    dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'quota-boss-robustness-'));
    env = { QUOTA_BOSS_HOME: process.env.QUOTA_BOSS_HOME, CODEX_HOME: process.env.CODEX_HOME };
    process.env.QUOTA_BOSS_HOME = path.join(dir, 'boss'); process.env.CODEX_HOME = path.join(dir, 'codex');
  });
  test.afterEach(() => {
    for (const [k,v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(dir, {recursive:true, force:true});
  });
  test('state patch merges only owned keys and a lock collision gives up in about 200 ms', () => {
    lib.writeState({claude:{keep:true}, sessions:{one:{mode:'normal'}}, history:{codex:[{t:1,u5:2}]}});
    lib.updateState(current => ({sessions:{...current.sessions, two:{mode:'save'}}}));
    assert.deepEqual(lib.readState().claude, {keep:true});
    assert.deepEqual(lib.readState().history.codex, [{t:1,u5:2}]);
    const lock = lib.getPaths().stateFile + '.lock'; fs.writeFileSync(lock, 'held');
    const before = fs.readFileSync(lib.getPaths().stateFile,'utf8');
    let called = false; const start = performance.now();
    assert.equal(lib.updateState(() => {called=true; return {claude:{bad:true}};}), null);
    assert.ok(performance.now() - start >= 180); assert.ok(performance.now() - start < 1000);
    assert.equal(called,false); assert.equal(fs.readFileSync(lib.getPaths().stateFile,'utf8'),before);
    assert.equal(fs.existsSync(lock),true);
  });
  test('stale locks recover and thrown updates release the lock without replacing state', () => {
    lib.writeState({keep:1}); const lock = lib.getPaths().stateFile + '.lock'; fs.writeFileSync(lock,JSON.stringify({pid:2147483647,nonce:'dead'}));
    const past = new Date(Date.now()-3000); fs.utimesSync(lock,past,past);
    lib.updateState(() => ({other:2})); assert.deepEqual(lib.readState(),{keep:1,other:2});
    assert.equal(fs.existsSync(lock),false);
    assert.throws(() => lib.updateState(() => {throw new Error('failed update');}), /failed update/);
    assert.equal(fs.existsSync(lock),false); assert.deepEqual(lib.readState(),{keep:1,other:2});
  });
  test('simultaneous stale-lock recovery and writers preserve Claude, Codex history and all session updates', async () => {
    const script = path.join(dir,'writer.cjs');
    fs.writeFileSync(script, "'use strict';\nconst {workerData,parentPort}=require('node:worker_threads');\nconst lib=require(workerData.lib);\nlet ok=false;\nfor(let i=0;i<10&&!ok;i++){ok=!!lib.updateState(s=>workerData.kind==='claude'?{claude:{updated_at:1},history:{...s.history,claude:[{t:1,u5:10}]}}:workerData.kind==='codex'?{history:{...s.history,codex:[{t:1,u5:20}]}}:{sessions:{...s.sessions,[workerData.kind]:{mode:'normal'}}});}\nparentPort.postMessage(ok);\n");
    lib.writeState({});
    fs.writeFileSync(lib.getPaths().stateFile + '.lock', JSON.stringify({pid:2147483647, nonce:'shared-stale'}));
    const results = await Promise.all(['claude','codex','session-a','session-b'].map(kind => new Promise((resolve,reject) => {
      const worker=new Worker(script,{workerData:{kind,lib:path.join(__dirname,'..','scripts','lib.js')},env:{...process.env}});
      let result; worker.once('message',value=>{result=value;}); worker.once('error',reject);
      worker.once('exit',code=>code===0?resolve(result):reject(new Error('writer exit '+code)));
    })));
    assert.ok(results.every(Boolean)); const state=lib.readState();
    assert.equal(state.claude.updated_at,1); assert.equal(state.history.claude[0].u5,10); assert.equal(state.history.codex[0].u5,20);
    assert.deepEqual(Object.keys(state.sessions).sort(),['session-a','session-b']);
  });
  test('date folders are visited newest first, stop at ten and never stat old trees', () => {
    const sessions=path.join(process.env.CODEX_HOME,'sessions');
    for (const date of ['2025/12/31','2026/01/01','2026/11/07','2026/11/08']) {
      for(let i=0;i<12;i++) lib.atomicWrite(path.join(sessions,...date.split('/'),'rollout-'+String(i).padStart(2,'0')+'.jsonl'),'{}\n');
    }
    const original={open:fs.opendirSync,stat:fs.statSync}; const opened=[];
    fs.opendirSync=(file,...args)=>{opened.push(file);return original.open(file,...args);};
    fs.statSync=()=>{throw new Error('dated discovery must not stat files');};
    let logs; try {logs=lib.newestLogs(sessions);} finally {fs.opendirSync=original.open;fs.statSync=original.stat;}
    assert.equal(logs.length,10); assert.ok(logs.every(l=>l.file.includes(path.join('2026','11','08'))));
    assert.equal(path.basename(logs[0].file),'rollout-11.jsonl'); assert.equal(path.basename(logs.at(-1).file),'rollout-02.jsonl');
    assert.ok(opened.every(p=>!p.includes('2025')&&!p.endsWith(path.join('11','07'))&&!p.endsWith(path.join('2026','01'))));
  });
  test('fallback layouts use mtimes and enumerate at most 5000 entries', () => {
    const sessions=path.join(process.env.CODEX_HOME,'sessions');
    for(let i=0;i<12;i++){
      const file=path.join(sessions,'nested',i+'.jsonl'); lib.atomicWrite(file,'{}\n');fs.utimesSync(file,new Date(10000+i),new Date(10000+i));
    }
    assert.equal(path.basename(lib.newestLogs(sessions)[0].file),'11.jsonl');
    const real=fs.opendirSync; let reads=0;
    fs.opendirSync=()=>({readSync:()=>{reads++;return {name:'entry-'+reads+'.txt',isDirectory:()=>false,isFile:()=>true};},closeSync:()=>{}});
    try {assert.deepEqual(lib.newestLogs('fake'),[]);} finally {fs.opendirSync=real;}
    assert.equal(reads,5000);
  });
  test('busy locks keep hook and status line processes successful and quiet', () => {
    const project=path.join(dir,'project');fs.mkdirSync(project);lib.saveProject(project,{enabled:true});
    lib.writeState({keep:true});fs.writeFileSync(lib.getPaths().stateFile+'.lock','held');
    const old={input:lib.readInput,stdin:lib.readStdin,out:process.stdout.write}; let output='';
    lib.readInput=()=>({cwd:project,session_id:'new'}); lib.readStdin=()=>JSON.stringify({cwd:project,rate_limits:{five_hour:{used_percentage:1}}});
    process.stdout.write=s=>{output+=s;return true;};
    try {require('../scripts/hook-prompt').main();require('../scripts/statusline').main();} finally {lib.readInput=old.input;lib.readStdin=old.stdin;process.stdout.write=old.out;}
    assert.match(output,/\[quota-boss\]/);assert.match(output,/boss on:balanced/);assert.deepEqual(lib.readState(),{keep:true});
  });
});
