import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createChromatogramCache} from '../src/calibrations/chromatogramCache.js'

test('shares pending requests and keeps real heights ready for synchronous hover', async()=>{
  let calls=0
  const cache=createChromatogramCache(async()=>{calls++;return {points:[{x:13.04,y:75800000}]}})
  const first=cache.get('run-a'),second=cache.get('run-a')
  assert.equal(first,second)
  await first
  assert.equal(cache.peek('run-a').points[0].y,75800000)
  await cache.get('run-a')
  assert.equal(calls,1)
})

test('limits concurrent preloads and retries failures',async()=>{
  let active=0,max=0,failed=false
  const cache=createChromatogramCache(async id=>{
    active++;max=Math.max(max,active)
    await new Promise(resolve=>setTimeout(resolve,5))
    active--
    if(id==='bad'&&!failed){failed=true;throw new Error('offline')}
    return {points:[]}
  })
  const results=await Promise.allSettled(['a','b','bad','c','d'].map(id=>cache.get(id)))
  assert.equal(max,2)
  assert.equal(results[2].status,'rejected')
  assert.equal(cache.peek('bad'),undefined)
  await cache.get('bad')
  assert.deepEqual(cache.peek('bad'),{points:[]})
})

test('bounds completed cache entries and isolates accounts',async()=>{
  let account='one'
  const cache=createChromatogramCache(async id=>({id}),{limit:2,scope:()=>account})
  await cache.get('a');await cache.get('b');await cache.get('c')
  assert.equal(cache.peek('a'),undefined)
  assert.deepEqual(cache.peek('c'),{id:'c'})
  account='two'
  assert.equal(cache.peek('c'),undefined)
})
