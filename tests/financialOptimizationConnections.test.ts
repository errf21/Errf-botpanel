import {test} from 'node:test';import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync,readFileSync,readdirSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
const code=`const {parentPort,workerData}=require('node:worker_threads');const {DatabaseSync}=require('node:sqlite');
(async()=>{const c=new DatabaseSync(workerData.path);c.exec('PRAGMA busy_timeout=10000;PRAGMA foreign_keys=ON');
 const db={prepare(sql){let args=[];const s={bind(...v){args=v;return s},async first(){return c.prepare(sql).get(...args)??null},async run(){return {meta:{changes:Number(c.prepare(sql).run(...args).changes)}}}};return s},async batch(stmts){c.exec('BEGIN IMMEDIATE');try{const out=[];for(const s of stmts)out.push(await s.run());c.exec('COMMIT');return out}catch(e){c.exec('ROLLBACK');throw e}}};
 const barrier=new Int32Array(workerData.barrier);Atomics.add(barrier,0,1);Atomics.notify(barrier,0);while(Atomics.load(barrier,0)<2)Atomics.wait(barrier,0,1,10000);
 const fn=(await import(workerData.module))[workerData.fn];const out=await fn(db,workerData.opts);c.close();parentPort.postMessage({out});})().catch(e=>{parentPort.postMessage({error:e.name+':'+e.message});process.exitCode=1});`;
for(const scenario of ['admin-same','admin-different','referral-same','referral-cap','topup-same','topup-cap'] as const)test(`independent SQLite connections preserve atomic ${scenario} intent`,async()=>{
 const dir=mkdtempSync(join(tmpdir(),'errf-financial-')),path=join(dir,'test.sqlite');const workers:Worker[]=[];
 try{
  const c=new DatabaseSync(path);c.exec('PRAGMA foreign_keys=ON');const migrations=new URL('../migrations/',import.meta.url);
  for(const f of readdirSync(migrations).filter(v=>v.endsWith('.sql')).sort()){c.exec('BEGIN');c.exec(readFileSync(new URL(f,migrations),'utf8'));c.exec('COMMIT');}
  c.exec(`INSERT INTO customers(id,telegram_user_id,balance_irt) VALUES(1,'1',${scenario==='topup-cap'?999999950000:100}),(2,'2',0),(3,'3',0);UPDATE customers SET referred_by=1 WHERE id IN (2,3);`);
  for(const id of ['a','b'])c.prepare("INSERT INTO wallet_topups(id,customer_id,amount_irt,state,idempotency_key) VALUES(?,1,45000,'approved',?)").run(id,id);c.close();
  const barrier=new SharedArrayBuffer(4);
  const results=await Promise.all([0,1].map(n=>new Promise<any>((resolve,reject)=>{
   const isAdmin=scenario.startsWith('admin'),isReferral=scenario.startsWith('referral');
   const module=new URL(isAdmin?'../src/db/wallet.ts':isReferral?'../src/db/referrals.ts':'../src/db/topups.ts',import.meta.url).href;
   const fn=isAdmin?'applyWalletMutation':isReferral?'maybePayReferralReward':'creditTopupOnce';
   const opts=isAdmin?{customerId:1,amountIrt:50,kind:'admin_grant',actor:'admin:9',operationKey:scenario==='admin-same'?'same':'key'+n}:
    isReferral?{refereeCustomerId:scenario==='referral-same'?2:2+n,orderId:'reward'+n,rewardIrt:10,config:{enabled:true,maxRewardsPerReferrer:scenario==='referral-cap'?1:10}}:
    {customerId:1,amountIrt:45000,topupId:scenario==='topup-same'?'a':['a','b'][n],actor:'admin:9'};
   const w=new Worker(code,{eval:true,workerData:{path,module,fn,opts,barrier}});workers.push(w);w.once('message',resolve);w.once('error',reject);w.once('exit',rc=>{if(rc)reject(Error('worker exit '+rc));});
  })));
  assert.ok(results.every(r=>!r.error),JSON.stringify(results));const check=new DatabaseSync(path,{readOnly:true});
  const n=scenario==='admin-different'?2:1,delta=scenario.startsWith('admin')?50:scenario.startsWith('referral')?10:45000;
  assert.equal(check.prepare('SELECT COUNT(*) n FROM wallet_entries').get()!.n,n);
  assert.equal(check.prepare('SELECT SUM(delta_irt) n FROM wallet_entries').get()!.n,n*delta);
  assert.equal(check.prepare('SELECT balance_irt n FROM customers WHERE id=1').get()!.n,(scenario==='topup-cap'?999999950000:100)+n*delta);
  if(scenario.startsWith('referral'))assert.equal(check.prepare('SELECT COUNT(*) n FROM referral_rewards').get()!.n,1);
  if(scenario==='topup-cap'){assert.equal(results.filter(r=>r.out.ok).length,1);assert.equal(check.prepare("SELECT COUNT(*) n FROM wallet_topups WHERE credit_status='blocked'").get()!.n,1);}
  assert.deepEqual(check.prepare('PRAGMA foreign_key_check').all(),[]);check.close();
 }finally{await Promise.all(workers.map(w=>w.terminate()));rmSync(dir,{recursive:true,force:true});}
});
