import test from 'node:test'
import assert from 'node:assert/strict'
import { NucleusAgent, passageLight, TRANSIT_MS } from './nucleus-agent.js'
const event=(type,id,time=100000)=>({type,sessionId:'s',sourceSeq:id,time})
test('one input and output per turn; waiting persists; chunks/tools do not refire',()=>{
 const m=new NucleusAgent()
 assert.equal(m.mode(0),'idle')
 assert.equal(m.accept(event('user/message',1),0,100000),'input')
 assert.equal(m.accept(event('user/message',1),20,100000),null)
 assert.equal(m.mode(100),'conversing')
 assert.equal(m.mode(TRANSIT_MS+1),'waiting')
 m.accept(event('stream/start',2),3000,100000)
 assert.equal(m.mode(100000),'waiting')
 assert.equal(m.accept(event('stream/data',3),3100,100000),'output')
 assert.equal(m.accept(event('assistant/message',4),3200,100000),null)
 m.accept(event('tool/call',5),3300,100000)
 m.accept(event('stream/start',6),3400,100000)
 assert.equal(m.accept(event('stream/data',7),3500,100000),null)
 m.accept(event('turn/end',8),4000,100000)
 assert.equal(m.mode(4001),'idle')
 assert.equal(m.accept(event('user/message',9),5000,100000),'input')
 assert.equal(m.accept(event('stream/data',10),5100,100000),'output')
})
test('SSE replay and stale history never restart an idle nucleus',()=>{
 const m=new NucleusAgent()
 assert.equal(m.accept({...event('user/message',1),replay:true},0,100000),null)
 assert.equal(m.accept(event('stream/start',2,0),0,100000),null)
 assert.equal(m.mode(1),'idle')
})
test('one pass, exact zero endpoints; brightness advances smoothly',()=>{
 for(const t of [0,.25,.5,.75,1]) {assert.equal(passageLight(t,0),0);assert.equal(passageLight(t,TRANSIT_MS),0);assert.equal(passageLight(t,TRANSIT_MS*2),0)}
 const peaks=[400,900,1500,2000].map(age=>{
  let best=0,level=-1
  for(let k=0;k<=1000;k++){const l=passageLight(k/1000,age);if(l>level){level=l;best=k/1000}}
  return best
 })
 for(let i=1;i<peaks.length;i++)assert.ok(peaks[i]>peaks[i-1])
 let jump=0
 for(let age=0;age<TRANSIT_MS;age++)jump=Math.max(jump,Math.abs(passageLight(.5,age+1)-passageLight(.5,age)))
 assert.ok(jump<.005,`per-ms jump ${jump}`)
})
