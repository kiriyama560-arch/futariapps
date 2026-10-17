const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),crypto=require('node:crypto');
const source=fs.readFileSync(__dirname+'/Code.gs','utf8');
function setup(){
 let now=Date.parse('2026-10-18T09:00:00+09:00'),fail=false;
 const hash=s=>crypto.createHash('sha256').update(s).digest('hex'),tokens={A:'a'.repeat(64),B:'b'.repeat(64)};
 const members={A:{deviceHash:hash(tokens.A),topic:'fn-'+'a'.repeat(48)},B:{deviceHash:hash(tokens.B),topic:'fn-'+'b'.repeat(48)}};
 const props={STATE:JSON.stringify(members),ENABLED:'true',APP_ORIGIN:'https://example.com'},sent=[];
 const service={getProperty:k=>props[k]??null,setProperty:(k,v)=>{props[k]=v;},deleteProperty:k=>{delete props[k];},getProperties:()=>({...props})};
 class Clock extends Date{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
 const context=vm.createContext({Date:Clock,Utilities:{DigestAlgorithm:{SHA_256:1},Charset:{UTF_8:1},computeDigest:(_,s)=>[...crypto.createHash('sha256').update(s).digest()],formatDate:()=>new Date(now).toISOString().slice(0,10)},LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock(){}})},PropertiesService:{getScriptProperties:()=>service},UrlFetchApp:{fetch:(url,options)=>{sent.push({url,data:JSON.parse(options.payload)});return{getResponseCode:()=>fail?503:200};}}});
 vm.runInContext(source,context);
 return {context,props,sent,members,tokens,advance:ms=>now+=ms,fail:v=>fail=v,call:(member,action,data={})=>context.notificationRequest({token:tokens[member],action,...data}),at:ms=>new Date(now+ms).toISOString()};
}
test('authenticated partner-only return in both directions, repeat ID dedupe and cooldown',()=>{
 const x=setup();x.call('A','return',{requestId:'1'.repeat(32)});x.call('A','return',{requestId:'1'.repeat(32)});
 assert.equal(x.sent.length,1);assert.equal(x.sent[0].data.topic,x.members.B.topic);
 assert.throws(()=>x.call('A','return',{requestId:'2'.repeat(32)}),/1分/);
 x.call('B','return',{requestId:'3'.repeat(32)});assert.equal(x.sent[1].data.topic,x.members.A.topic);
 assert.throws(()=>x.context.notificationRequest({token:'c'.repeat(64),action:'return',requestId:'4'.repeat(32)}),/登録/);
});
test('disabled prevents writes and sends but authenticated cancellation remains available',()=>{
 const x=setup();x.call('A','save',{id:'memo1',remindAt:x.at(600000),target:'both'});x.props.ENABLED='false';
 assert.throws(()=>x.call('A','return',{requestId:'1'.repeat(32)}),/準備中/);
 x.call('B','cancel',{id:'memo1'});assert.equal(x.props.REMINDER_memo1,undefined);assert.equal(x.sent.length,0);
});
test('due reminders only, both recipient delivery, no duplicate on subsequent tick and no memo text sent',()=>{
 const x=setup();x.call('A','save',{id:'memo1',remindAt:x.at(600000),target:'both',content:'SECRET'});
 x.context.processReminders_();assert.equal(x.sent.length,0);x.advance(600001);x.context.processReminders_();
 assert.equal(x.sent.length,2);assert.equal(x.props.REMINDER_memo1,undefined);x.context.processReminders_();assert.equal(x.sent.length,2);
 assert.ok(!JSON.stringify(x.sent).includes('SECRET'));
});
test('reschedule replaces due time, cancellation prevents sending, invalid datetimes rejected',()=>{
 const x=setup();const save=(at)=>x.call('A','save',{id:'memo1',remindAt:at,target:'self'});
 save(x.at(600000));save(x.at(1200000));x.advance(600001);x.context.processReminders_();assert.equal(x.sent.length,0);
 x.call('B','cancel',{id:'memo1'});x.advance(600001);x.context.processReminders_();assert.equal(x.sent.length,0);
 assert.throws(()=>save(x.at(-1)),/日時/);assert.throws(()=>save('bad'),/日時/);assert.throws(()=>save(x.at(400*86400000)),/日時/);
});
test('failure retains queue and backs off; retry works, daily ceiling enforced',()=>{
 const x=setup();x.call('B','save',{id:'memo1',remindAt:x.at(1000),target:'partner'});x.advance(1001);x.fail(true);x.context.processReminders_();
 assert.ok(x.props.REMINDER_memo1);x.context.processReminders_();assert.equal(x.sent.length,1);
 x.fail(false);x.advance(15*60000);x.context.processReminders_();assert.equal(x.sent[1].data.topic,x.members.A.topic);assert.equal(x.props.REMINDER_memo1,undefined);
 x.props.BUDGET=JSON.stringify({day:new Date('2026-10-18T00:00Z').toISOString().slice(0,10),count:100});
 assert.throws(()=>x.call('A','return',{requestId:'9'.repeat(32)}),/上限/);
});
