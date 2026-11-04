import { UserError } from '../utils/errors.js';

// Never include FFmpeg stderr: it can contain signed media URLs and headers.
export function decoderError(stderr,exitCode,{cachedSource=false,provider='The provider'}={}) {
  const match=stderr.match(/\bHTTP(?:\/[\d.]+)?\s+(?:error\s+)?([45]\d{2})\b/i)
    ?? stderr.match(/\bServer returned\s+([45]\d{2})\b/i);
  const httpStatus=match?Number(match[1]):undefined;
  let error;
  if([401,403].includes(httpStatus)){
    error=cachedSource
      ? new UserError('The cached audio link is no longer usable. Refreshing it once.','SOURCE_STALE')
      : new UserError(provider+' refused this audio stream (HTTP '+httpStatus+'). Try another permitted source.','ACCESS_DENIED');
  }else error=new UserError('Audio decoding stopped unexpectedly. Check FFmpeg and provider availability.','AUDIO_STREAM');
  error.exitCode=exitCode;error.httpStatus=httpStatus;
  error.decoderReason=/\bInvalid data found\b/i.test(stderr)?'invalid_media'
    : /\bConnection reset\b/i.test(stderr)?'connection_reset'
    : /\bConnection timed out\b|\bOperation timed out\b/i.test(stderr)?'timeout'
    : /\bError opening input\b/i.test(stderr)?'input_open'
    : /\bError during demuxing\b/i.test(stderr)?'demux'
    : 'decoder_exit';
  return error;
}
