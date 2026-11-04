export class Mutex {
  #tail = Promise.resolve();
  run(fn) {
    const result = this.#tail.then(fn);
    this.#tail = result.catch(() => {});
    return result;
  }
}
export async function withAbort(promise,signal) {
  if(signal?.aborted){
    // The caller may already have started a rejecting operation. Observe it
    // even when cancellation wins before we attach the normal race handlers.
    Promise.resolve(promise).catch(()=>{});
    throw signal.reason;
  }
  if(!signal)return promise;
  let abort;
  const cancelled=new Promise((resolve,reject)=>{abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});});
  try{return await Promise.race([promise,cancelled]);}
  finally{signal.removeEventListener('abort',abort);}
}
export class Semaphore {
  constructor(limit) { this.limit = limit; this.active = 0; this.waiters = []; }
  async run(fn, signal) {
    signal?.throwIfAborted();
    if (this.active >= this.limit) await new Promise((resolve, reject) => {
      const item = { resolve, reject };
      item.abort = () => { this.waiters = this.waiters.filter(w => w !== item); reject(signal.reason); };
      item.signal = signal;
      signal?.addEventListener('abort', item.abort, { once: true });
      this.waiters.push(item);
    });
    else this.active++;
    try { signal?.throwIfAborted(); return await fn(); }
    finally {
      const next = this.waiters.shift();
      if (next) { next.signal?.removeEventListener('abort', next.abort); next.resolve(); }
      else this.active--;
    }
  }
}
