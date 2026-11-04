import { readFile,mkdir,writeFile,rename,rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Mutex,withAbort } from '../utils/async.js';
import { UserError } from '../utils/errors.js';
import { spotifyUrl,youtubeUrl,httpsUrl,integer } from '../utils/validators.js';
import { trackIdentity } from './TrackMatcher.js';

const validId=value=>typeof value==='string'&&/^\d{17,22}$/.test(value);
const MAX_BYTES=16*1024*1024,MAX_USERS=10000;
export function savedTrack(track){
  if(!track||typeof track.title!=='string'||!track.title.trim()||!['spotify','youtube','local','stream'].includes(track.source))throw new UserError('This track has no supported metadata to save.');
  const result={title:track.title.trim().slice(0,300),source:track.source};
  for(const field of ['artist','album','channel'])if(typeof track[field]==='string'&&track[field].trim())result[field]=track[field].trim().slice(0,300);
  if(Number.isFinite(track.duration)&&track.duration>0)result.duration=track.duration;
  if(track.source==='spotify'){
    result.sourceUrl=spotifyUrl(track.sourceUrl).url;
    // Re-match Spotify metadata at playback; never persist an extracted audio URL.
  }else if(track.source==='youtube'){
    const parsed=youtubeUrl(track.youtubeUrl??track.sourceUrl);
    if(parsed.type!=='video')throw new UserError('Save individual YouTube videos, not playlist URLs.');
    result.youtubeUrl=parsed.url;result.sourceUrl=parsed.url;
  }else{
    if(!/^[A-Za-z0-9_-]{1,80}$/.test(track.mediaId??''))throw new UserError('This library track has an invalid media ID.');
    result.mediaId=track.mediaId;
  }
  if(typeof track.artwork==='string'&&track.artwork.length<=2000){try{result.artwork=httpsUrl(track.artwork).href;}catch{/* Optional artwork does not invalidate a song. */}}
  return result;
}
const identities=track=>[
  ...(track.source==='spotify'?(spotifyUrl(track.sourceUrl).type==='track'?[track.sourceUrl]:[]):[track.source==='youtube'?track.youtubeUrl:`${track.source}:${track.mediaId}`]),
  ...(track.artist?[`metadata:${trackIdentity(track)}`]:[])
];

export class PlaylistStore {
  constructor(file=null,limit=500,values=[],shared=null){this.file=file;this.limit=limit;this.values=new Map(values);this.lock=new Mutex();this.pending=new Map();this.closed=false;this.shared=shared;}
  static async open(file,limit=500){
    try{
      const text=await readFile(file,'utf8');if(Buffer.byteLength(text)>MAX_BYTES)throw Error();
      const data=JSON.parse(text);
      if(data?.version!==1||!data.users||typeof data.users!=='object'||Array.isArray(data.users)||Object.keys(data.users).length>MAX_USERS)throw Error();
      const values=Object.entries(data.users).map(([userId,list])=>{
        if(!validId(userId)||!list||typeof list.id!=='string'||!list.id||!Array.isArray(list.tracks)||list.tracks.length>1000||!Number.isFinite(Date.parse(list.createdAt)))throw Error();
        return [userId,{id:list.id,createdAt:list.createdAt,tracks:list.tracks.map(savedTrack)}];
      });
      return new PlaylistStore(file,limit,values);
    }catch(error){if(error.code==='ENOENT')return new PlaylistStore(file,limit);throw new UserError('Saved playlists are invalid or unreadable. Check data/playlists.json before starting.','PLAYLIST_STORAGE');}
  }
  get(userId){
    if(this.shared){
      const row=this.shared.db.prepare('SELECT value FROM playlists WHERE user_id=?').get(userId);
      return row?JSON.parse(row.value):null;
    }
    const list=this.values.get(userId);return list?structuredClone(list):null;
  }
  require(userId){const list=this.get(userId);if(!list)throw new UserError('You do not have a playlist. Use the playlist create command first.');return list;}
  async change(userId,fn,{signal}={}){
    if(!validId(userId))throw new UserError('Invalid playlist owner.');
    return this.lock.run(async()=>{
      signal?.throwIfAborted();
      if(this.closed)throw new UserError('Playlist storage is shutting down.');
      if(this.shared)return this.shared.transaction(()=>{
        const {record,result}=fn(this.get(userId));
        const db=this.shared.db;
        if(record){
          const value=JSON.stringify(record);
          const usage=db.prepare('SELECT count(*) AS users, coalesce(sum(length(CAST(value AS BLOB))),0) AS bytes FROM playlists WHERE user_id<>?').get(userId);
          if(usage.users>=MAX_USERS||usage.bytes+Buffer.byteLength(value)>MAX_BYTES)throw new UserError('The shared playlist storage limit has been reached.');
          db.prepare('INSERT INTO playlists VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET value=excluded.value').run(userId,value);
        }else db.prepare('DELETE FROM playlists WHERE user_id=?').run(userId);
        return result;
      });
      const next=new Map(this.values),list=this.get(userId);
      const {record,result}=fn(list);
      if(record)next.set(userId,record);else next.delete(userId);
      if(next.size>MAX_USERS)throw new UserError('The saved playlist user limit has been reached.');
      if(this.file){
        const directory=path.dirname(this.file),temporary=path.join(directory,`.playlists-${randomUUID()}.tmp`);
        try{
          const text=JSON.stringify({version:1,users:Object.fromEntries(next)},null,2)+'\n';
          if(Buffer.byteLength(text)>MAX_BYTES)throw Error();
          await mkdir(directory,{recursive:true,mode:0o700});
          await writeFile(temporary,text,{mode:0o600,flag:'wx'});
          signal?.throwIfAborted();
          await rename(temporary,this.file);
        }catch{
          signal?.throwIfAborted();
          throw new UserError('Your playlist could not be saved. Check free space and write access to the data folder.','PLAYLIST_STORAGE');
        }
        finally{await rm(temporary,{force:true}).catch(()=>{});}
      }
      this.values=next;return result;
    });
  }
  create(userId){return this.change(userId,list=>{
    if(list)throw new UserError('You already have a playlist. Each user can have only one.');
    return {record:{id:randomUUID(),createdAt:new Date().toISOString(),tracks:[]}};
  });}
  add(userId,tracks,expectedId,{signal}={}){return this.change(userId,list=>{
    if(!list||list.id!==expectedId)throw new UserError('Your playlist changed or was deleted during this request. Try again.');
    const known=new Set(list.tracks.flatMap(identities));let added=0,duplicates=0,omitted=0,unavailable=0;
    for(const raw of tracks){
      let track;try{track=savedTrack(raw);}catch{unavailable++;continue;}
      const keys=identities(track);
      if(keys.some(key=>known.has(key))){duplicates++;continue;}
      keys.forEach(key=>known.add(key));
      if(list.tracks.length>=this.limit){omitted++;continue;}
      list.tracks.push(track);added++;
    }
    return {record:list,result:{added,duplicates,omitted,unavailable,total:list.tracks.length}};
  },{signal});}
  remove(userId,position){return this.change(userId,list=>{
    if(!list)throw new UserError('You do not have a playlist.');integer(position,1,list.tracks.length,'Position');
    const [removed]=list.tracks.splice(position-1,1);return {record:list,result:removed};
  });}
  delete(userId){return this.change(userId,list=>{if(!list)throw new UserError('You do not have a playlist.');return {record:null};});}
  async import(userId,fn){
    if(this.closed)throw new UserError('Playlist storage is shutting down.');
    if(this.pending.has(userId))throw new UserError('A playlist request is already running for you. Wait for it to finish.');
    if(this.pending.size>=100)throw new UserError('Playlist imports are busy. Try again shortly.');
    const controller=new AbortController();this.pending.set(userId,controller);
    const timeout=setTimeout(()=>controller.abort(new UserError('Playlist import timed out. Try again.')),120000);timeout.unref();
    try{return await withAbort(fn(controller.signal),controller.signal);}finally{clearTimeout(timeout);this.pending.delete(userId);}
  }
  async dispose(){this.closed=true;for(const controller of this.pending.values())controller.abort();await this.lock.run(()=>{});}
}
