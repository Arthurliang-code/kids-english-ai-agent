const MAX_MS = 5000;

function preferredMime(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  if (MediaRecorder.isTypeSupported('audio/mp4')) return 'audio/mp4';
  if (MediaRecorder.isTypeSupported('audio/webm')) return 'audio/webm';
  return '';
}

/** 录一段最长 5 秒的声音，只返回本机 Blob。 */
export function recordClip(maxMs = MAX_MS): { stop: () => void; done: Promise<Blob> } {
  let recorder: MediaRecorder | null = null;
  let timer = 0;
  let cancel = false;

  const done = (async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = preferredMime();
    const active = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    recorder = active;
    const chunks: Blob[] = [];
    active.addEventListener('dataavailable', (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    });
    const stopped = new Promise<Blob>((resolve) => {
      active.addEventListener('stop', () => {
        window.clearTimeout(timer);
        for (const track of stream.getTracks()) track.stop();
        resolve(new Blob(chunks, { type: active.mimeType || mime || 'audio/mp4' }));
      });
    });
    active.start();
    if (cancel) active.stop();
    else {
      timer = window.setTimeout(() => {
        if (active.state !== 'inactive') active.stop();
      }, maxMs);
    }
    return stopped;
  })();

  return {
    stop() {
      cancel = true;
      window.clearTimeout(timer);
      if (recorder && recorder.state !== 'inactive') recorder.stop();
    },
    done,
  };
}
