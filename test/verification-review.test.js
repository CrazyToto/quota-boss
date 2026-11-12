'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const lib = require('../scripts/lib');
const hosts = require('../scripts/hosts');
const cli = require('../scripts/quota-boss');
const diagnostics = require('../scripts/diagnostics');
const {copyPrompt} = require('../scripts/pplx');
const {install} = require('../install');

test.describe('verification review regressions', () => {
  let dir, project, cwd, oldEnv, env;
  test.beforeEach(() => {
    dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'quota-boss-review-'));
    project = path.join(dir, 'checkout'); fs.mkdirSync(project);
    cwd = process.cwd(); process.chdir(project);
    env = {QUOTA_BOSS_HOME:path.join(dir,'boss'), CLAUDE_CONFIG_DIR:path.join(dir,'claude'), CODEX_HOME:path.join(dir,'codex'), QUOTA_BOSS_MCP:'1'};
    oldEnv = Object.fromEntries(Object.keys(env).map(k => [k,process.env[k]]));
    Object.assign(process.env,env);
  });
  test.afterEach(() => {
    process.chdir(cwd);
    for (const [k,v] of Object.entries(oldEnv)) {if(v === undefined)delete process.env[k];else process.env[k]=v;}
    fs.rmSync(dir,{recursive:true,force:true});
  });
  const settingsFile = () => path.join(env.CLAUDE_CONFIG_DIR,'settings.json');
  const manifestFile = () => path.join(env.QUOTA_BOSS_HOME,'install-manifest.json');
  function installer(args=[], extra={}) {return install({args:['--no-mcp',...args],env,log:()=>{},...extra});}

  test('item 2: doctor/probes and installer shims use a trusted cwd and disable Windows cwd lookup', () => {
    fs.writeFileSync(path.join(project,'node.exe'),'untrusted');
    fs.writeFileSync(path.join(project,'codex.cmd'),'untrusted');
    fs.mkdirSync(env.QUOTA_BOSS_HOME);
    const calls=[];
    const options={platform:'win32',env,findExecutable:name=>'C:\\trusted\\'+name+'.cmd',spawnSync:(file,args,options)=>{
      calls.push({file,args,options});return {status:0,stdout:'CLI 1.2.3'};
    }};
    diagnostics.doctor(true,options);
    installer([],{...options,args:[]});
    assert.ok(calls.length>5);
    for(const call of calls){
      assert.equal(call.options.cwd,env.QUOTA_BOSS_HOME);
      assert.notEqual(call.options.cwd,project);
      assert.equal(call.options.env.NoDefaultCurrentDirectoryInExePath,'1');
      assert.equal(call.options.shell,false);
      assert.match(call.file,/System32[\\/]cmd.exe$/);
    }
    assert.equal(env.NoDefaultCurrentDirectoryInExePath,undefined);
    let fallback;
    lib.runExecutable('C:\\trusted\\codex.cmd',['--version'],{...options,env:{},cwd:project,spawnSync:(_f,_a,o)=>{fallback=o;return {status:0};}});
    assert.equal(fallback.cwd,os.homedir());
    assert.equal(fallback.env.NoDefaultCurrentDirectoryInExePath,'1');
  });

  test('high node: fresh and upgraded settings quote absolute Node; doctor detects a removed executable', () => {
    const old='node "'+env.QUOTA_BOSS_HOME.replace(/\\/g,'/')+'/scripts/hook-session.js"';
    lib.writeJson(settingsFile(),{hooks:{SessionStart:[{hooks:[{command:old}]}]}});
    installer();
    const settings=lib.readJson(settingsFile());
    const commands=[settings.statusLine.command,...Object.values(settings.hooks).flatMap(entries=>entries.flatMap(e=>e.hooks.map(h=>h.command)))];
    for(const command of commands){assert.ok(command.startsWith('"'+process.execPath.replace(/\\/g,'/')+'" "'));assert.ok(!command.includes('\\'));}
    assert.doesNotMatch(diagnostics.doctor(false,{env:{PATH:''}}),/node path in settings no longer exists/);
    const missing=path.join(dir,'removed node.exe').replace(/\\/g,'/');
    settings.hooks.SessionStart[0].hooks[0].command='"'+missing+'" "'+env.QUOTA_BOSS_HOME.replace(/\\/g,'/')+'/scripts/hook-session.js"';
    lib.writeJson(settingsFile(),settings);
    assert.match(diagnostics.doctor(false,{env:{PATH:''}}),/node path in settings no longer exists - rerun install/);
  });

  test('high clip: Windows/macOS use system absolute clipboard tools with hardened child options', () => {
    for(const [platform,expected] of [['win32','D:\\Windows\\System32\\clip.exe'],['darwin','/usr/bin/pbcopy']]){
      const calls=[];
      assert.equal(copyPrompt('private prompt',{platform,env:{...env,SystemRoot:'D:\\Windows'},spawnSync:(file,args,options)=>{calls.push({file,args,options});return {status:0};}}),true);
      assert.equal(calls.length,1);assert.equal(calls[0].file,expected);assert.deepEqual(calls[0].args,[]);
      assert.equal(calls[0].options.input,'private prompt');assert.notEqual(calls[0].options.cwd,project);
      if(platform==='win32')assert.equal(calls[0].options.env.NoDefaultCurrentDirectoryInExePath,'1');
    }
  });

  test('high clip: Linux lookup excludes relative PATH, cwd and cwd aliases, and falls back to absolute xclip', () => {
    const bin=path.join(dir,'trusted');fs.mkdirSync(bin);
    const alias=path.join(dir,'alias');fs.symlinkSync(project,alias,process.platform==='win32'?'junction':'dir');
    for(const directory of [project,bin])for(const name of ['wl-copy','xclip'])fs.writeFileSync(path.join(directory,name),'fixture',{mode:0o700});
    // Simulated POSIX directories allow testing trusted PATH rules on Windows too.
    const original=lib.findExecutable,calls=[],lookups=[];
    lib.findExecutable=(name,searchEnv,platform)=>{lookups.push([name,searchEnv.PATH,platform]);return '/trusted/'+name;};
    try{assert.equal(copyPrompt('prompt',{platform:'linux',env:{PATH:':.:relative:/checkout:/trusted'},spawnSync:(file,args,options)=>{calls.push({file,args,options});return {status:calls.length===1?1:0};}}),true);}
    finally{lib.findExecutable=original;}
    assert.deepEqual(lookups.map(l=>l[0]),['wl-copy','xclip']);
    assert.deepEqual(calls.map(c=>[c.file,c.args]),[['/trusted/wl-copy',[]],['/trusted/xclip',['-selection','clipboard']]]);
    const platform=process.platform,sep=platform==='win32'?';':':';
    // The same resolver is used on Linux; exercise actual filesystem aliases on the host.
    const suffix=platform==='win32'?'.exe':'';
    fs.writeFileSync(path.join(bin,'cliptest'+suffix),'fixture',{mode:0o700});
    assert.equal(original('cliptest',{PATH:['','.','relative',project,alias,bin].join(sep)},platform),fs.realpathSync(path.join(bin,'cliptest'+suffix)));
    assert.ok(calls.every(c=>c.options.shell===false && c.options.cwd!==project));
  });

  test('item 8: exclusive settings lock covers transform; final temporary stat edits are rebased with mtime/size/hash checks', () => {
    const file=settingsFile();lib.writeJson(file,{revision:0});
    const original=fs.lstatSync;let edited=false,locksChecked=false;
    fs.lstatSync=(name,...args)=>{
      const result=original(name,...args);
      if(String(name).startsWith(file+'.tmp-') && !edited){
        edited=true;
        const lock=JSON.parse(fs.readFileSync(file+'.quota-boss.lock','utf8'));
        assert.equal(lock.pid,process.pid);assert.ok(lock.nonce);locksChecked=true;
        fs.writeFileSync(file,JSON.stringify({revision:1,permissions:{allow:['Read']}}));
      }
      return result;
    };
    try{installer();}finally{fs.lstatSync=original;}
    assert.ok(edited && locksChecked);
    assert.equal(lib.readJson(file).revision,1);assert.deepEqual(lib.readJson(file).permissions,{allow:['Read']});
    assert.ok(lib.readJson(file).hooks.SessionStart);
    assert.equal(fs.existsSync(file+'.quota-boss.lock'),false);
  });

  test('item 8: same-size same-mtime settings edits are detected by the content hash', () => {
    const file=settingsFile();lib.atomicWrite(file,'{"revision":0}');
    const original=fs.lstatSync;let edited=false;
    fs.lstatSync=(name,...args)=>{
      const stat=original(name,...args);
      if(String(name).startsWith(file+'.tmp-') && !edited){edited=true;fs.writeFileSync(file,'{"revision":1}');}
      // Mask mtime changes to prove that comparison includes file contents.
      if(String(name)===file)stat.mtimeMs=100;
      return stat;
    };
    try{installer();}finally{fs.lstatSync=original;}
    assert.equal(lib.readJson(file).revision,1);
  });

  test('item 11: uninstall scans unflagged registry projects and bounded untracked projects, preserving outside bytes', () => {
    installer();
    const tracked=path.join(dir,'old-tracked'),scanned=path.join(dir,'scanned');fs.mkdirSync(tracked);fs.mkdirSync(scanned);
    lib.saveProject(tracked,{enabled:false});
    const outside='User\r\n',suffix='\r\nEnd';
    const block=outside+hosts.START+'\nold generated rules\n'+hosts.END+suffix;
    fs.writeFileSync(path.join(tracked,'AGENTS.md'),block);fs.writeFileSync(path.join(scanned,'AGENTS.md'),block);
    const unmanaged=path.join(scanned,'plain');fs.mkdirSync(unmanaged);fs.writeFileSync(path.join(unmanaged,'AGENTS.md'),'Only user rules');
    let nested=scanned;
    for(let depth=1;depth<=7;depth++){nested=path.join(nested,'d');fs.mkdirSync(nested);fs.writeFileSync(path.join(nested,'AGENTS.md'),block);}
    const linked=path.join(dir,'linked-target');fs.mkdirSync(linked);fs.writeFileSync(path.join(linked,'AGENTS.md'),block);
    fs.symlinkSync(linked,path.join(scanned,'link'),process.platform==='win32'?'junction':'dir');
    const logs=[];installer(['--uninstall','--scan',scanned],{log:s=>logs.push(s)});
    for(const directory of [tracked,scanned])assert.equal(fs.readFileSync(path.join(directory,'AGENTS.md'),'utf8'),outside+suffix);
    assert.equal(fs.readFileSync(path.join(unmanaged,'AGENTS.md'),'utf8'),'Only user rules');
    assert.equal(fs.readFileSync(path.join(nested,'AGENTS.md'),'utf8'),block);
    assert.equal(fs.readFileSync(path.join(linked,'AGENTS.md'),'utf8'),block);
    assert.ok(logs.some(s=>s.includes('pre-upgrade')&&s.includes('--scan')));
    const original=fs.opendirSync;let reads=0;
    fs.opendirSync=()=>({readSync:()=>{reads++;return {name:'entry',isSymbolicLink:()=>false,isDirectory:()=>false,isFile:()=>true};},closeSync:()=>{}});
    try{assert.deepEqual(hosts.scanAgents(scanned),[]);}finally{fs.opendirSync=original;}
    assert.equal(reads,5000);
  });

  test('medium registry race: managed write holds the registry lock and overlapping off cannot run between commits', () => {
    const file=path.join(project,'AGENTS.md'),original=fs.renameSync;let checked=false;
    fs.renameSync=(from,to)=>{
      if(path.resolve(to).toLowerCase()===file.toLowerCase()&&!checked){
        checked=true;
        const owner=lib.readJson(lib.getPaths().projectsFile+'.lock');assert.equal(owner.pid,process.pid);assert.ok(owner.nonce);
        assert.throws(()=>cli.run(['off']),/registry is busy/);
      }
      return original(from,to);
    };
    try{cli.run(['on','--host','codex']);}finally{fs.renameSync=original;}
    assert.ok(checked);assert.equal(lib.findProjectConfig().enabled,true);assert.match(fs.readFileSync(file,'utf8'),/quota-boss:start/);
    cli.run(['off']);assert.equal(lib.findProjectConfig().enabled,false);assert.equal(fs.existsSync(file),false);
  });

  test('low installer race: manifest ownership is loaded inside the transaction lock after a preceding installer', () => {
    const original=lib.withLock;let interleaved=false;
    lib.withLock=(file,action,...rest)=>{
      if(path.basename(file)==='quota-boss-installer'&&!interleaved){interleaved=true;installer();}
      return original(file,action,...rest);
    };
    try{installer();}finally{lib.withLock=original;}
    assert.ok(interleaved);
    assert.equal(lib.readJson(manifestFile()).hooks.length,2);assert.ok(lib.readJson(manifestFile()).statusLine);
    installer(['--uninstall']);assert.deepEqual(lib.readJson(settingsFile()),{});
  });

  for(const next of ['install','uninstall'])test('low MCP journal: interrupted addition reconciles on next '+next, () => {
    let registered=false;const calls=[];
    const options={args:[],env,platform:'linux',findExecutable:name=>'/trusted/'+name,spawnSync:(_file,args)=>{
      calls.push(args);
      if(args[1]==='get')return {status:registered?0:1};
      if(args[1]==='add'){
        assert.equal(lib.readJson(manifestFile()).mcpPending,true);
        registered=true;throw new Error('interrupted after external registration');
      }
      if(args[1]==='remove'){registered=false;return {status:0};}
      throw Error('unexpected CLI call');
    }};
    installer([],options);assert.equal(lib.readJson(manifestFile()).mcpPending,true);
    installer([],{...options,args:next==='uninstall'?['--uninstall']:[]});
    assert.equal(calls.filter(a=>a[1]==='add').length,1);
    if(next==='install'){
      assert.equal(lib.readJson(manifestFile()).mcpPending,false);assert.equal(lib.readJson(manifestFile()).mcpAdded,true);
      installer([],{...options,args:['--uninstall']});
    }
    assert.equal(registered,false);assert.equal(fs.existsSync(manifestFile()),false);
  });

  test('a recovered stale lock gets one attempt even when the wait is used up', () => {
    const file=path.join(dir,'state-late.json'),lock=file+'.lock';
    fs.writeFileSync(lock,JSON.stringify({pid:2147483647,nonce:'late'}));
    assert.equal(lib.withLock(file,()=>true,0),true);assert.equal(fs.existsSync(lock),false);
  });

  test('a claim folder that cannot be removed yet does not fail the lock', () => {
    const file=path.join(dir,'state-busy.json'),lock=file+'.lock';
    fs.writeFileSync(lock,JSON.stringify({pid:2147483647,nonce:'busy'}));
    const original=fs.rmdirSync;let attempts=0;
    fs.rmdirSync=target=>{if(String(target).includes('.reclaim-')){attempts++;throw Object.assign(new Error('busy'),{code:'ENOTEMPTY'});}return original(target);};
    let result;try{result=lib.withLock(file,()=>true,5000);}finally{fs.rmdirSync=original;}
    assert.equal(result,true);assert.ok(attempts>1);assert.equal(fs.existsSync(lock),false);
    for(const name of fs.readdirSync(path.dirname(file)))if(name.includes('.reclaim-'))fs.rmdirSync(path.join(path.dirname(file),name));
  });

  test('low reclaim: dead and expired ownership claims and old empty directories are recoverable; fresh live claims remain', () => {
    const file=path.join(dir,'state.json'),lock=file+'.lock';
    const old=JSON.stringify({pid:2147483647,nonce:'dead'});
    const claim=lock+'.reclaim-'+crypto.createHash('sha256').update(old).digest('hex');
    for(const mode of ['dead','expired','empty','live']){
      fs.writeFileSync(lock,old);fs.mkdirSync(claim);
      if(mode!=='empty')fs.writeFileSync(path.join(claim,'owner.json'),JSON.stringify({pid:mode==='dead'?2147483647:process.pid,nonce:'claim-'+mode}));
      if(mode==='expired'||mode==='empty'){const past=new Date(Date.now()-11000);fs.utimesSync(claim,past,past);}
      let called=false;
      // Recovery can take longer than 40 ms on a busy machine; only the refusal needs the short wait.
      const result=lib.withLock(file,()=>{called=true;return true;},mode==='live'?40:5000);
      if(mode==='live'){assert.equal(result,null);assert.equal(called,false);fs.unlinkSync(lock);fs.unlinkSync(path.join(claim,'owner.json'));fs.rmdirSync(claim);}
      else {assert.equal(result,true);assert.equal(called,true);assert.equal(fs.existsSync(claim),false);assert.equal(fs.existsSync(lock),false);}
    }
    fs.writeFileSync(lock,old);
    const original=fs.renameSync;let checked=false;
    fs.renameSync=(from,to)=>{
      if(from===lock){const owner=JSON.parse(fs.readFileSync(path.join(claim,'owner.json'),'utf8'));assert.equal(owner.pid,process.pid);assert.ok(owner.nonce);checked=true;}
      return original(from,to);
    };
    try{assert.equal(lib.withLock(file,()=>true),true);}finally{fs.renameSync=original;}
    assert.ok(checked);
  });

  test('low missing projects: deleted tracked projects are already gone and do not prevent uninstall', () => {
    installer();cli.run(['on','--host','codex']);
    const key=lib.projectKey(project);process.chdir(dir);fs.rmSync(project,{recursive:true});
    const logs=[];installer(['--uninstall'],{log:s=>logs.push(s)});
    assert.ok(logs.some(s=>s.includes('already gone')&&s.includes(key)));
    assert.equal(fs.existsSync(manifestFile()),false);assert.deepEqual(lib.readJson(settingsFile()),{});
  });
});
