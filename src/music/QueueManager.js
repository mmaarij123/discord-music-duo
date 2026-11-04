import { integer } from '../utils/validators.js';
import { UserError } from '../utils/errors.js';
export class QueueManager {
  constructor(limit = 500) { this.limit = limit; this.tracks = []; this.history = []; this.loop = 'off'; }
  get length() { return this.tracks.length; }
  add(tracks) {
    const accepted = tracks.slice(0,Math.max(0,this.limit-this.length));
    this.tracks.push(...accepted);
    return { added:accepted.length, omitted:tracks.length-accepted.length };
  }
  take() { return this.tracks.shift(); }
  remember(track) { if (track) { this.history.push(track); if (this.history.length>50) this.history.shift(); } }
  complete(track) { this.remember(track); if (this.loop === 'queue' && track) this.add([track]); }
  remove(position) { integer(position,1,this.length,'Position'); return this.tracks.splice(position-1,1)[0]; }
  setLoop(mode) { if (!['off','track','queue'].includes(mode)) throw new UserError('Loop must be off, track, or queue.'); this.loop = mode; }
  shuffle(random = Math.random) {
    for (let i=this.length-1;i>0;i--) { const j=Math.floor(random()*(i+1)); [this.tracks[i],this.tracks[j]]=[this.tracks[j],this.tracks[i]]; }
  }
  clear() { this.tracks.length=0; }
}
