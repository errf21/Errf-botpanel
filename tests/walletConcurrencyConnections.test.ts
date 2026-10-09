/** Independent real SQLite connections/threads, not a mocked balance store.
 * Cloudflare D1 network/distributed execution itself is still not tested. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync,readFileSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const code=`const {parentPort,workerData}=require('node:worker_threads');const {DatabaseSync}=require('node:sqlite');
(async()=>{const {payOrderWithWallet}=await import(workerData.module);const c=new DatabaseSync(workerData.path);c.exec('PRAGMA busy_timeout=10000;PRAGMA foreign_keys=ON');const barrier=new Int32Array(workerData.barrier);let first=true;
 const db={prepare(sql){let args=[];const s={bind(...v){args=v;return s},async first(){const row=c.prepare(sql).get(...args)??null;if(first&&sql==='SELECT balance_irt FROM customers WHERE id = ?1'){first=false;Atomics.add(barrier,0,1);Atomics.notify(barrier,0);while(Atomics.load(barrier,0)<2)Atomics.wait(barrier,0,1,10000);}return row},async run(){return {meta:{changes:Number(c.prepare(sql).run(...args).changes)}}}};return s},async batch(stmts){c.exec('BEGIN IMMEDIATE');try{const result=[];for(const s of stmts)result.push(await s.run());c.exec('COMMIT');return result}catch(e){c.exec('ROLLBACK');throw e}}};
 const result=await payOrderWithWallet(db,{customerId:1,amountIrt:100,orderId:workerData.token,actor:'synthetic-thread'});c.close();parentPort.postMessage(result)})().catch(e=>{parentPort.postMessage({error:e.name+':'+e.message});process.exitCode=1});`;
for(const scenario of ['different','same','insufficient'] as const)test(`two independent SQLite connections: ${scenario} wallet claims preserve balance and ledger`,async()=>{
 const dir=mkdtempSync(join(tmpdir(),'errf-wallet-concurrency-')),path=join(dir,'isolated.sqlite');let workers:Worker[]=[];
 try{
  const c=new DatabaseSync(path);c.exec('PRAGMA foreign_keys=ON');const migrationDir=new URL('../migrations/',import.meta.url);
  for(const f of readdirSync(migrationDir).filter(f=>f.endsWith('.sql')).sort()){c.exec('BEGIN');c.exec(readFileSync(new URL(f,migrationDir),'utf8'));c.exec('COMMIT');}
  c.prepare('INSERT INTO customers(id,telegram_user_id,balance_irt) VALUES(1,?,?)').run('999991',scenario==='insufficient'?150:500);c.close();
  const barrier=new SharedArrayBuffer(4),module=new URL('../src/db/wallet.ts',import.meta.url).href;
  const results=await Promise.all([0,1].map(n=>new Promise<any>((resolve,reject)=>{const w=new Worker(code,{eval:true,workerData:{path,barrier,module,token:scenario==='same'?'THREAD-SAME':'THREAD-'+n}});workers.push(w);w.once('message',resolve);w.once('error',reject);w.once('exit',v=>{if(v!==0)reject(Error('synthetic worker exit '+v));});})));
  assert.ok(results.every(r=>!r.error),JSON.stringify(results));const check=new DatabaseSync(path,{readOnly:true});
  const expected=scenario==='different'?300:scenario==='same'?400:50;
  assert.equal(check.prepare('SELECT balance_irt n FROM customers WHERE id=1').get()!.n,expected);
  assert.equal(check.prepare("SELECT COUNT(*) n FROM wallet_entries WHERE kind='order_payment'").get()!.n,scenario==='different'?2:1);
  assert.equal(check.prepare('SELECT SUM(delta_irt) n FROM wallet_entries').get()!.n,scenario==='different'?-200:-100);
  assert.equal(results.filter(r=>r.ok).length,scenario==='insufficient'?1:2);assert.deepEqual(check.prepare('PRAGMA foreign_key_check').all(),[]);check.close();
 }finally{await Promise.all(workers.map(w=>w.terminate()));rmSync(dir,{recursive:true,force:true});}
});
