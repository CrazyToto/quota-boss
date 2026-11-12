'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const lib = require('../scripts/lib');
const cli = require('../scripts/quota-boss');
const hosts = require('../scripts/hosts');
const diagnostics = require('../scripts/diagnostics');
const { install } = require('../install');

test.describe('security review regressions', () => {
  let dir, project, cwd, env;
  test.beforeEach(() => {
    dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'quota-boss-security-'));
    project = path.join(dir, 'project'); fs.mkdirSync(project);
    cwd = process.cwd();
    env = Object.fromEntries(['QUOTA_BOSS_HOME','CLAUDE_CONFIG_DIR','CODEX_HOME'].map(k => [k, process.env[k]]));
    process.env.QUOTA_BOSS_HOME = path.join(dir, 'boss');
    process.env.CLAUDE_CONFIG_DIR = path.join(dir, 'claude');
    process.env.CODEX_HOME = path.join(dir, 'codex');
    process.chdir(project);
  });
  test.afterEach(() => {
    process.chdir(cwd);
    for (const [k,v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(dir, {recursive:true, force:true});
  });
  function installer(args = [], extra = {}) {
    return install({args:['--no-mcp', ...args], repo:path.join(__dirname,'..'),
      env:{QUOTA_BOSS_HOME:process.env.QUOTA_BOSS_HOME, CLAUDE_CONFIG_DIR:process.env.CLAUDE_CONFIG_DIR, CODEX_HOME:process.env.CODEX_HOME},
      log:()=>{}, ...extra});
  }
  // Exercise the link check on Windows accounts without file-symlink privileges too.
  function linkedFile(file, action) {
    const original = fs.lstatSync;
    fs.lstatSync = (name, ...args) => {
      const stat = original(name, ...args);
      if ((process.platform === 'win32' ? path.resolve(name).toLowerCase() === path.resolve(file).toLowerCase() : path.resolve(name) === path.resolve(file))) return { ...stat, isFile:()=>false, isSymbolicLink:()=>true };
      return stat;
    };
    try { action(); } finally { fs.lstatSync = original; }
  }

  test('finding 1: every host and hook uses installed absolute helpers despite checkout helpers', () => {
    lib.atomicWrite(path.join(project,'scripts','compact.js'), 'throw new Error("project helper executed")');
    lib.saveProject(project,{enabled:true});
    for (const host of lib.HOSTS) {
      const text = hosts.rules(host);
      // Codex and generic rules drop the quotes when the path needs none: Codex on Windows mangles them.
      // A path with other characters keeps them, such as the short name RUNNER~1 in the temporary folder of a Windows CI runner.
      const quote = host === 'claude-code' || !/^[A-Za-z0-9_:/.-]+$/.test(lib.trustedHomeText()) ? '"' : '';
      assert.ok(text.includes('node ' + quote + lib.trustedHomeText() + '/scripts/compact.js' + quote));
      assert.doesNotMatch(text, /node scripts\//);
      assert.doesNotMatch(text, /\{\{QUOTA_BOSS_HOME\}\}/);
    }
    const original = {input:lib.readInput,out:process.stdout.write}; let output='';
    lib.readInput=()=>({cwd:project}); process.stdout.write=s=>{output+=s;return true;};
    try {require('../scripts/hook-session').main();} finally {lib.readInput=original.input;process.stdout.write=original.out;}
    assert.ok(output.includes('node "' + lib.trustedHomeText() + '/scripts/compact.js"'));
  });

  test('finding 2: PATH excludes empty, relative, cwd and cwd aliases; shims and probes have no bare lookup', () => {
    const bin=path.join(dir,'trusted bin');fs.mkdirSync(bin);
    const platform=process.platform;
    const suffix=platform==='win32'?'.cmd':'';
    for(const name of ['claude','codex']) {
      fs.writeFileSync(path.join(project,name+suffix),'malicious');
      fs.writeFileSync(path.join(bin,name+suffix),'trusted',{mode:0o700});
    }
    const separator=platform==='win32'?';':':';
    const alias=path.join(dir,'cwd-alias');fs.symlinkSync(project,alias,platform==='win32'?'junction':'dir');
    const searchEnv={PATH:['','.','relative',project,alias,bin].join(separator)};
    for(const name of ['claude','codex']) assert.equal(lib.findExecutable(name,searchEnv,platform),fs.realpathSync(path.join(bin,name+suffix)));
    const calls=[];
    diagnostics.doctor(true,{platform,env:searchEnv,spawnSync:(file,args,options)=>{calls.push({file,args,options});return {status:0,stdout:args[0]==='exec'?'OK':'CLI 1.2.3'};}});
    assert.ok(calls.length>4);
    for(const call of calls){
      assert.equal(call.options.shell,false);assert.ok(path.isAbsolute(call.file));
      assert.ok(call.file!==path.join(project,'claude'+suffix));
      if(platform==='win32'){assert.deepEqual(call.args.slice(0,3),['/d','/s','/c']);assert.ok(call.args[3].includes(bin));}
    }
    for (const value of ['codex','C:codex.exe','\\codex.exe','/codex.exe']) assert.throws(()=>lib.executableInvocation(value,['--version'],'win32'));
    for(const arg of ['x&calc','%PATH%','!name!','x" y','x|calc','x^y']) assert.throws(()=>lib.executableInvocation('C:\\bin\\codex.cmd',[arg],'win32'));
    assert.ok(lib.executableInvocation('C:\\Users\\Zoë (Work)\\claude.cmd',['--version'],'win32').args[3].includes('Zoë (Work)'));
    const native=lib.executableInvocation('C:\\bin\\codex.exe',['--version'],'win32');
    assert.equal(native.file,'C:\\bin\\codex.exe');
  });

  test('finding 3: AGENTS.md links cannot copy secrets or be replaced', () => {
    const file=path.join(project,'AGENTS.md');fs.writeFileSync(file,'private content');
    let opened=false;const original=fs.openSync;
    fs.openSync=(name,...args)=>{if(name===file)opened=true;return original(name,...args);};
    try {linkedFile(file,()=>assert.throws(()=>cli.run(['on','--host','codex']),/regular file/));}
    finally {fs.openSync=original;}
    assert.equal(opened,false);assert.equal(fs.readFileSync(file,'utf8'),'private content');
    assert.equal(Object.keys(lib.readProjects()).length,0);
  });

  test('finding 4: clone settings cannot grant enablement, training consent or any project switch', () => {
    const malicious={enabled:true,host:'codex',profile:'frugal',allowTrainingProviders:true,terse:true,consensus:false,workers:{codex:false},caps:{codex:{weekly:null}}};
    for(const name of ['quota-boss.json','harness.json'])lib.writeJson(path.join(project,'.claude',name),malicious);
    assert.deepEqual(lib.normalizeProject(lib.findProjectConfig()),lib.normalizeProject({}));
    cli.run(['on']);
    assert.equal(lib.findProjectConfig().allowTrainingProviders,false);
    assert.equal(lib.findProjectConfig().profile,'balanced');
    const report=diagnostics.doctor(false,{env:{PATH:''}});
    assert.equal(report.split('ignored for security').length,3);
  });

  test('finding 5: null, off and larger project caps cannot relax global caps in routing', () => {
    cli.run(['cap','codex','weekly','20']);
    for(const cap of [null,100,40,10]){
      lib.saveProject(project,{enabled:true,caps:{codex:{weekly:cap}}});
      const config=lib.loadConfig();assert.equal(config.providers.caps.codex.weekly,cap===10?10:20);
      const result=require('../scripts/route').route({...config,...lib.findProjectConfig(),limits:{codex:{secondary:{used_percent:20}}}});
      assert.ok(result.rows.every(r=>r.pool!=='codex'&&r.ladder.every(s=>s.pool!=='codex')));
    }
  });

  test('finding 6: on/off never writes into linked checkout .claude directories; all writes reject linked parents', () => {
    const target=path.join(dir,'other-claude');fs.mkdirSync(target);
    const link=path.join(project,'.claude');fs.symlinkSync(target,link,process.platform==='win32'?'junction':'dir');
    cli.run(['on']);cli.run(['off']);assert.deepEqual(fs.readdirSync(target),[]);
    assert.throws(()=>lib.atomicWrite(path.join(link,'settings.json'),'{}'),/parent directory/);
    assert.equal(lib.findProjectConfig().enabled,false);
  });

  test('finding 7: compaction retains every active longest-window record and reset windows report real zero', () => {
    const now=Date.UTC(2026,10,20,12);
    const windows=Object.fromEntries(Object.keys(lib.QUOTA_WINDOWS).map(w=>[w,{budget:200,unit:'calls'}]));
    const config=lib.mergeProviders(lib.BUILTIN_PROVIDERS,{providers:{grok:{enabled:true,quota:{source:'counter',windows}}}});
    const earliest=Math.min(...Object.keys(windows).map(w=>lib.counterWindow(w,now).start));
    const entry=t=>JSON.stringify({t,provider:'grok',amount:0.01,unit:'calls'} )+'\n';
    lib.atomicWrite(lib.getPaths().usageFile,entry(earliest-1).repeat(6000)+entry(earliest).repeat(10000));
    const usage=lib.readUsage(now);assert.equal(usage.entries.length,10000);assert.equal(usage.truncated,false);
    assert.equal(fs.readFileSync(lib.getPaths().usageFile,'utf8').trim().split('\n').length,10000);
    const limits=lib.readProviderLimits(config,{},now);
    assert.ok(Math.abs(limits.grok.windows.monthly.counted-100)<1e-8);
    const reset=Math.max(...Object.keys(windows).map(w=>lib.counterWindow(w,now).end));
    const empty=lib.readProviderLimits(config,{},reset);
    assert.ok(Object.values(empty.grok.windows).every(w=>w.used_percent===0));
    lib.appendUsage('grok',1,'calls',config,reset);
    assert.equal(lib.readProviderLimits(config,{},reset).grok.windows.daily.used_percent,0.5);
  });

  test('finding 8: settings edits during copying and once during commit are rebased and preserved', () => {
    const file=path.join(process.env.CLAUDE_CONFIG_DIR,'settings.json');lib.writeJson(file,{permissions:{allow:['Read']}});
    let copied=false,committed=false;
    const original=fs.writeFileSync;
    fs.writeFileSync=(target,...args)=>{
      const result=original(target,...args);
      if(!copied&&typeof target==='number'){
        // The first runtime copy occurs after the initial settings read.
        copied=true;original(file,JSON.stringify({permissions:{allow:['Read','Write']},duringCopy:true}));
      }
      return result;
    };
    try {installer([], {log:message=>{
      if(copied&&!committed&&message.startsWith('Back up settings')){
        committed=true;original(file,JSON.stringify({permissions:{allow:['Read','Write','Bash']},duringCopy:true,duringCommit:true}));
      }
    }});} finally {fs.writeFileSync=original;}
    const saved=lib.readJson(file);assert.equal(saved.duringCopy,true);assert.equal(saved.duringCommit,true);
    assert.deepEqual(saved.permissions.allow,['Read','Write','Bash']);assert.ok(saved.hooks.SessionStart);
  });

  test('finding 8: three intervening settings edits abort clearly without losing the last edit', () => {
    const file=path.join(process.env.CLAUDE_CONFIG_DIR,'settings.json');lib.writeJson(file,{revision:0});let revision=0;
    assert.throws(()=>installer([], {log:message=>{if(message.startsWith('Back up settings'))fs.writeFileSync(file,JSON.stringify({revision:++revision}));}}),/changed during commit after 3 attempts/);
    assert.equal(revision,3);assert.equal(lib.readJson(file).revision,3);assert.equal(lib.readJson(file).hooks,undefined);
  });

  test('finding 9: live owners survive long pauses and release cannot unlink another owner', () => {
    const file=lib.getPaths().stateFile;lib.writeState({keep:true});const lock=file+'.lock';
    const token=JSON.stringify({pid:process.pid,nonce:'live'});fs.writeFileSync(lock,token);
    const past=new Date(Date.now()-3600000);fs.utimesSync(lock,past,past);
    assert.equal(lib.updateState(()=>({bad:true})),null);assert.equal(fs.readFileSync(lock,'utf8'),token);
    fs.unlinkSync(lock);
    lib.withLock(file,()=>{fs.writeFileSync(lock,token);});
    assert.equal(fs.readFileSync(lock,'utf8'),token);assert.deepEqual(lib.readState(),{keep:true});
  });

  test('finding 9: stale recovery renames the old token and rechecks newly acquired ownership', () => {
    const file=lib.getPaths().stateFile;lib.writeState({keep:true});const lock=file+'.lock';
    fs.writeFileSync(lock,JSON.stringify({pid:2147483647,nonce:'dead'}));
    const original=fs.renameSync;let quarantined=false;
    fs.renameSync=(from,to)=>{if(from===lock){assert.ok(to.startsWith(lock+'.stale-'));quarantined=true;}return original(from,to);};
    try{lib.updateState(()=>({recovered:true}));}finally{fs.renameSync=original;}
    assert.equal(quarantined,true);assert.equal(fs.existsSync(lock),false);assert.equal(lib.readState().recovered,true);
    assert.equal(fs.readdirSync(path.dirname(file)).some(n=>n.includes('.stale-')),false);
  });

  test('finding 10: interruption after activating settings leaves a pending, uninstallable manifest', () => {
    const file=path.join(process.env.CLAUDE_CONFIG_DIR,'settings.json');lib.writeJson(file,{user:true});
    const manifest=path.join(lib.getPaths().quotaBossHome,'install-manifest.json');
    const original=fs.renameSync;let activated=false;
    fs.renameSync=(from,to)=>{
      if(to===file){assert.equal(lib.readJson(manifest).pending,true);original(from,to);activated=true;throw new Error('interrupted activation');}
      return original(from,to);
    };
    try{assert.throws(()=>installer(),/interrupted activation/);}finally{fs.renameSync=original;}
    assert.equal(activated,true);assert.equal(lib.readJson(manifest).pending,true);
    installer(['--uninstall']);assert.deepEqual(lib.readJson(file),{user:true});assert.equal(fs.existsSync(manifest),false);
  });

  test('finding 11: uninstall cleans every registered managed block and preserves exact outside text', () => {
    installer();const paths=[];
    for(const name of ['one','two']){
      const directory=path.join(dir,name);fs.mkdirSync(directory);process.chdir(directory);
      fs.writeFileSync(path.join(directory,'AGENTS.md'),'User rules\r\n');
      cli.run(['on','--host','codex']);fs.appendFileSync(path.join(directory,'AGENTS.md'),'\r\nSuffix');paths.push(directory);
      assert.equal(lib.readProjects()[lib.projectKey(directory)].managedAgents,true);
    }
    const logs=[];installer(['--uninstall'],{log:s=>logs.push(s)});
    for(const directory of paths){assert.equal(fs.readFileSync(path.join(directory,'AGENTS.md'),'utf8'),'User rules\r\n\r\nSuffix');assert.ok(logs.some(s=>s.includes(lib.projectKey(directory))&&s.includes('Remove managed AGENTS.md')));}
  });

  test('finding 11: linked managed blocks are refused and the manifest survives for cleanup retry', () => {
    installer();cli.run(['on','--host','codex']);
    const file=path.join(project,'AGENTS.md');const before=fs.readFileSync(file,'utf8');
    const manifest=path.join(lib.getPaths().quotaBossHome,'install-manifest.json');let opened=false;
    const original=fs.openSync;
    fs.openSync=(name,...args)=>{if(path.resolve(String(name)).toLowerCase()===file.toLowerCase())opened=true;return original(name,...args);};
    try{linkedFile(file,()=>assert.throws(()=>installer(['--uninstall']),/cleanup failed; manifest retained/));}finally{fs.openSync=original;}
    assert.equal(opened,false);assert.equal(fs.readFileSync(file,'utf8'),before);assert.ok(fs.existsSync(manifest));
    installer(['--uninstall']);assert.equal(fs.existsSync(file),false);assert.equal(fs.existsSync(manifest),false);
  });

  test('finding 12: mutations inherit enablement, privacy, workers and caps from nearest registered real path', () => {
    lib.saveProject(project,{enabled:true,profile:'quality',allowTrainingProviders:true,host:'generic',terse:true,consensus:false,workers:{gpt:false},caps:{codex:{weekly:10}}});
    const nested=path.join(project,'nested');fs.mkdirSync(nested);process.chdir(nested);
    cli.run(['set', 'profile','frugal']);const effective=lib.findProjectConfig();
    assert.equal(effective.enabled,true);assert.equal(effective.allowTrainingProviders,true);assert.equal(effective.host,'generic');
    assert.equal(effective.workers.gpt,false);assert.equal(effective.terse,true);assert.equal(effective.consensus,false);assert.equal(effective.caps.codex.weekly,10);
    assert.equal(effective.directory,lib.projectKey(nested));assert.equal(lib.findProjectConfig(project).profile,'quality');
    assert.equal(lib.projectKey(project,'win32'),fs.realpathSync(project).toLowerCase());
    const link=path.join(dir,'alias');fs.symlinkSync(project,link,process.platform==='win32'?'junction':'dir');
    assert.equal(lib.findProjectConfig(path.join(link,'nested')).directory,lib.projectKey(nested));
    const registry=lib.getPaths().projectsFile;const before=fs.readFileSync(registry,'utf8');
    assert.throws(()=>lib.saveProject(project,{padding:'x'.repeat(lib.MAX_PROJECT_BYTES)}),/exceeds 1 MiB/);assert.equal(fs.readFileSync(registry,'utf8'),before);
    fs.writeFileSync(registry,' '.repeat(lib.MAX_PROJECT_BYTES+1));
    assert.throws(()=>lib.findProjectConfig(),/File too large/);
    fs.writeFileSync(registry,before);
  });

  test('finding 13: configs, state, outcomes and usage reject links and special files before opening', () => {
    const files=[path.join(lib.getPaths().quotaBossHome,'config','providers.json'),lib.getPaths().projectsFile,lib.getPaths().stateFile,lib.getPaths().outcomesFile,lib.getPaths().usageFile];
    for(const file of files){
      lib.atomicWrite(file,'{}');let opened=false;const original=fs.openSync;
      fs.openSync=(name,...args)=>{if(name===file)opened=true;return original(name,...args);};
      try{linkedFile(file,()=>{
        assert.throws(()=>lib.readBounded(file,1024),/regular file/);
        assert.throws(()=>lib.atomicWrite(file,'{}'),/regular file/);
        assert.throws(()=>lib.appendRegular(file,'{}'),/regular file/);
      });}finally{fs.openSync=original;}
      assert.equal(opened,false);fs.unlinkSync(file);fs.mkdirSync(file);
      assert.throws(()=>lib.readBounded(file,1024),/regular file/);
      fs.rmdirSync(file);
    }
    const file=path.join(dir,'raced.json');fs.writeFileSync(file,'{}');const original=fs.fstatSync;
    fs.fstatSync=(...args)=>({...original(...args),isFile:()=>false});
    try{assert.throws(()=>lib.readBounded(file,1024),/File changed|regular file/);}finally{fs.fstatSync=original;}
  });
});
