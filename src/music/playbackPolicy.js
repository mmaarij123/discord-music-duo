import { NoSubscriberBehavior } from '@discordjs/voice';

export function playbackBehaviors(config) {
  return { noSubscriber:NoSubscriberBehavior.Pause, maxMissedFrames:Math.ceil((config.audioStallMs ?? 20000)/20) };
}

export function prematureEnd(track,progress) {
  return Number.isFinite(track?.duration) && track.duration>0 && progress+2<track.duration;
}

export function mayRetry(error) {
  return !['ACCESS_DENIED','RESTRICTED','REGION','UNAVAILABLE','FORMAT','TOOL_MISSING','FFMPEG'].includes(error?.code);
}
