import { withAbort } from './async.js';

// Only metadata requests are shared, never live audio streams or Discord resources.
export class SharedRequests {
  constructor() { this.pending=new Map(); }
  async run(key,start,signal) {
    signal?.throwIfAborted();
    let entry=this.pending.get(key);
    if(!entry){
      entry={controller:new AbortController(),users:0,settled:false};
      entry.promise=Promise.resolve().then(()=>start(entry.controller.signal)).finally(()=>{
        entry.settled=true;
        if(this.pending.get(key)===entry)this.pending.delete(key);
      });
      this.pending.set(key,entry);
    }
    entry.users++;
    try{return structuredClone(await withAbort(entry.promise,signal));}
    finally{
      entry.users--;
      if(!entry.users&&!entry.settled){
        if(this.pending.get(key)===entry)this.pending.delete(key);
        entry.controller.abort();
      }
    }
  }
}
