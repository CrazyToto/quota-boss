'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const child = require('node:child_process');
const lib = require('../scripts/lib');
const cli = path.resolve(__dirname, '../scripts/quota-boss.js');
function fixture(t, committed = true) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'qb-verify-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo'), home = path.join(root, 'home');
  fs.mkdirSync(repo); fs.mkdirSync(home);
  const env = { ...process.env, HOME: home, USERPROFILE: home, QUOTA_BOSS_HOME: home, CLAUDE_CONFIG_DIR: home, CODEX_HOME: home };
  const git = (...args) => {
    const r = lib.runExecutable(lib.findExecutable('git'), args, { workingDirectory: repo, env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.error?.message || r.stderr); return r.stdout;
  };
  git('init'); git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'Test');
  fs.writeFileSync(path.join(repo, 'tracked'), 'initial');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'ignored\n');
  if (committed) { git('add', '.'); git('commit', '-m', 'initial'); }
  const counter = path.join(root, 'counter');
  const runner = path.join(root, 'runner.js');
  fs.writeFileSync(runner, `const fs=require('node:fs'); const p=${JSON.stringify(counter)}; fs.appendFileSync(p,'x'); if(process.env.FAIL_VERIFY) process.exit(7);`);
  const command = `"${process.execPath}" "${runner}"`;
  const run = (cmd = command, fresh = false, extra = {}) => child.spawnSync(process.execPath, [cli, 'verify', ...(fresh ? ['--fresh'] : []), '--', cmd], { cwd: repo, env: { ...env, ...extra }, encoding: 'utf8' });
  const evidence = path.join(home, 'verification.json');
  return { repo, root, env, git, command, run, evidence, counter, count: () => fs.existsSync(counter) ? fs.readFileSync(counter,'utf8').length : 0 };
}
test('first pass records and second pass reuses exactly one line without executing', t => {
  const f=fixture(t); assert.equal(f.run().status,0); assert.equal(f.count(),1);
  const entries=JSON.parse(fs.readFileSync(f.evidence)); assert.equal(entries.length,1);
  const r=f.run(); assert.equal(r.status,0); assert.equal(f.count(),1);
  assert.equal(r.stdout, `[quota-boss] Reused: "${f.command}" passed at ${entries[0].passedAt} on this revision; not run again.\n`);
});
for (const kind of ['tracked edit','untracked addition','tracked deletion','HEAD change','staged change','untracked contents']) {
  test(kind+' forces rerun',t=>{
    const f=fixture(t);
    if(kind==='untracked contents') fs.writeFileSync(path.join(f.repo,'new'),'a');
    f.run();
    if(kind==='tracked edit') fs.writeFileSync(path.join(f.repo,'tracked'),'edited');
    if(kind==='untracked addition') fs.writeFileSync(path.join(f.repo,'new'),'a');
    if(kind==='tracked deletion') fs.unlinkSync(path.join(f.repo,'tracked'));
    if(kind==='HEAD change') f.git('commit','--allow-empty','-m','next');
    if(kind==='staged change') { fs.writeFileSync(path.join(f.repo,'tracked'),'staged'); f.git('add','.'); }
    if(kind==='untracked contents') fs.writeFileSync(path.join(f.repo,'new'),'b');
    assert.equal(f.run().status,0); assert.equal(f.count(),2);
  });
}
test('ignored files do not invalidate evidence',t=>{const f=fixture(t);f.run();fs.writeFileSync(path.join(f.repo,'ignored'),'x');assert.match(f.run().stdout,/Reused:/);assert.equal(f.count(),1);});
test('--fresh reruns',t=>{const f=fixture(t);f.run();assert.equal(f.run(undefined,true).status,0);assert.equal(f.count(),2);});
test('the same command in another folder of the repo does not reuse',t=>{
 const f=fixture(t);f.run();
 const sub=path.join(f.repo,'packages','a');fs.mkdirSync(sub,{recursive:true});
 const inSub=()=>child.spawnSync(process.execPath,[cli,'verify','--',f.command],{cwd:sub,env:f.env,encoding:'utf8'});
 assert.equal(inSub().status,0);assert.equal(f.count(),2);
 assert.match(inSub().stdout,/Reused:/);assert.equal(f.count(),2);
});
test('different command does not reuse',t=>{const f=fixture(t);f.run();assert.equal(f.run(f.command+' other').status,0);assert.equal(f.count(),2);});
test('failure preserves exit code, clears earlier pass and is never recorded',t=>{
 const f=fixture(t);f.run();assert.equal(f.run(undefined,true,{FAIL_VERIFY:'1'}).status,7);
 assert.deepEqual(JSON.parse(fs.readFileSync(f.evidence)),[]);
 assert.equal(f.run(undefined,false,{FAIL_VERIFY:'1'}).status,7);assert.equal(f.count(),3);
});
test('command changing tracked files is not recorded',t=>{
 const f=fixture(t);const runner=path.join(f.root,'modify.js');fs.writeFileSync(runner,"require('node:fs').appendFileSync('tracked','x')");
 assert.equal(f.run(`"${process.execPath}" "${runner}"`).status,0);assert.deepEqual(JSON.parse(fs.readFileSync(f.evidence)),[]);
});
test('expired evidence is not reused',t=>{const f=fixture(t);f.run();const entries=JSON.parse(fs.readFileSync(f.evidence));entries[0].passedAt=new Date(Date.now()-6*3600000-1).toISOString();fs.writeFileSync(f.evidence,JSON.stringify(entries));f.run();assert.equal(f.count(),2);});
test('evidence retains only the 50 newest entries',t=>{
 const f=fixture(t);const entries=Array.from({length:50},(_,i)=>({key:i.toString(16).padStart(64,'0'),passedAt:new Date(Date.now()-1000-i).toISOString()}));
 fs.writeFileSync(f.evidence,JSON.stringify(entries));f.run();const saved=JSON.parse(fs.readFileSync(f.evidence));assert.equal(saved.length,50);assert.ok(!saved.some(e=>e.key===entries[49].key));
});
for(const invalid of ['{broken','null','{}','[null,{}, {"key":"bad","passedAt":"bad"}]']) test('corrupt evidence is empty: '+invalid,t=>{const f=fixture(t);fs.writeFileSync(f.evidence,invalid);assert.equal(f.run().status,0);assert.equal(f.count(),1);});
test('outside Git runs without evidence with one notice',t=>{const f=fixture(t);fs.renameSync(path.join(f.repo,'.git'),path.join(f.root,'git-backup'));const r=f.run();assert.equal(r.status,0);assert.equal(r.stderr.trim().split('\n').length,1);assert.equal(f.count(),1);assert.ok(!fs.existsSync(f.evidence));});
test('missing command is a usage error',t=>{const f=fixture(t);const r=f.run('');assert.notEqual(r.status,0);assert.match(r.stderr,/Usage:/);assert.equal(f.count(),0);});
test('fingerprinting preserves real index and object count',t=>{
 const f=fixture(t);fs.writeFileSync(path.join(f.repo,'tracked'),'changed');fs.writeFileSync(path.join(f.repo,'new'),'new');
 const index=fs.readFileSync(path.join(f.repo,'.git','index'));const objects=f.git('count-objects','-v');
 assert.equal(lib.revisionFingerprint(f.repo).fingerprint,lib.revisionFingerprint(f.repo).fingerprint);
 assert.deepEqual(fs.readFileSync(path.join(f.repo,'.git','index')),index);assert.equal(f.git('count-objects','-v'),objects);
});
test('unborn repository supports passing evidence',t=>{const f=fixture(t,false);assert.equal(f.run().status,0);assert.match(f.run().stdout,/Reused:/);});
test('unknown command fails without recording',t=>{const f=fixture(t);assert.notEqual(f.run('quota-boss-command-does-not-exist').status,0);assert.deepEqual(JSON.parse(fs.readFileSync(f.evidence)),[]);});
test('runs in current subdirectory',t=>{const f=fixture(t);const sub=path.join(f.repo,'sub');fs.mkdirSync(sub);const r=child.spawnSync(process.execPath,[cli,'verify','--',f.command],{cwd:sub,env:f.env,encoding:'utf8'});assert.equal(r.status,0);assert.equal(f.count(),1);});

for (const failure of ['spawn error', 'spawn throws', 'signal']) {
  test('reports '+failure+' and returns nonzero', async t => {
    const { EventEmitter } = require('node:events');
    const output=[];
    t.mock.method(process.stderr,'write', text => { output.push(text); return true; });
    const stdout=[];
    t.mock.method(process.stdout,'write', text => { stdout.push(text); return true; });
    // The test runner also writes to stdout while the mock is active, so look for the line only.
    t.after(() => assert.match(stdout.join(''), /\[quota-boss\] Check failed with exit code 1\.\n/));
    // Force the documented fingerprint fallback without starting any Git process.
    t.mock.method(child,'spawnSync', () => ({status:null,error:new Error('Git unavailable')}));
    t.mock.method(child,'spawn', () => {
      if(failure==='spawn throws') throw new Error('spawn denied');
      const proc=new EventEmitter();
      process.nextTick(()=> failure==='signal' ? proc.emit('close',null,'SIGTERM') : proc.emit('error',new Error('spawn denied')));
      return proc;
    });
    assert.equal(await lib.verifyCommand(['--','example command']),1);
    assert.match(output.join(''), /Revision fingerprint unavailable/);
    assert.match(output.join(''),failure==='signal' ? /signal SIGTERM/ : /Could not run command: spawn denied/);
  });
}
test('requires -- and rejects unknown options before executing',async t=>{
 let calls=0;t.mock.method(child,'spawn',()=>{calls++;throw new Error('must not execute');});
 for(const args of [[],['echo','hi'],['--fresh','--'],['--unknown','--','echo hi']]) {
   await assert.rejects(lib.verifyCommand(args),/Usage:/);
 }
 assert.equal(calls,0);
});

test('split node -e arguments execute and print a stdout verdict for success and failure', t => {
  const f=fixture(t);
  for (const code of [0, 7]) {
    const r=child.spawnSync(process.execPath,[cli,'verify','--',process.execPath,'-e',`process.exit(${code})`],{cwd:f.repo,env:f.env,encoding:'utf8'});
    assert.equal(r.status,code,r.stderr);
    assert.equal(r.stdout,code===0 ? '[quota-boss] Check passed.\n' : `[quota-boss] Check failed with exit code ${code}.\n`);
    assert.equal(r.stderr,'');
  }
});
