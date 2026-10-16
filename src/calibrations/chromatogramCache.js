// Bound background reads and share both in-flight and completed run data.
// Failed reads are evicted so returning to a chart can retry.
export function createChromatogramCache(load, {concurrency=2, limit=64, scope=()=>''}={}) {
  const entries=new Map(), queue=[]
  let active=0
  const key=id=>`${scope()}|${id}`
  const drain=()=>{
    while(active<concurrency&&queue.length){
      const task=queue.shift()
      active++
      Promise.resolve().then(()=>{
        if(task.key!==key(task.id))throw new Error('Account changed before preview loaded')
        return load(task.id)
      }).then(value=>{
        task.entry.value=value
        task.resolve(value)
        for(const [cachedKey,entry] of entries){
          if(entries.size<=limit)break
          if(entry.value!==undefined)entries.delete(cachedKey)
        }
      },error=>{
        entries.delete(task.key)
        task.reject(error)
      }).finally(()=>{active--;drain()})
    }
  }
  return {
    peek(id){return entries.get(key(id))?.value},
    get(id){
      const cacheKey=key(id),cached=entries.get(cacheKey)
      if(cached){entries.delete(cacheKey);entries.set(cacheKey,cached);return cached.promise}
      const entry={}
      entry.promise=new Promise((resolve,reject)=>queue.push({id,key:cacheKey,entry,resolve,reject}))
      entries.set(cacheKey,entry)
      drain()
      return entry.promise
    },
  }
}
