import { useEffect, useRef, useState } from 'react';

interface CameraSheetProps {
  open: boolean;
  onClose: () => void;
  onCapture: (dataUrl: string, width: number, height: number) => void;
  onPickFile?: (file: File) => void;
}

export function CameraSheet({ open, onClose, onCapture, onPickFile }: CameraSheetProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(false);

  useEffect(() => {
    if (!open) return;

    let cancelled = false;
    let stream: MediaStream | null = null;
    setError(null);
    setLive(false);

    void navigator.mediaDevices
      .getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 2560 },
          height: { ideal: 1440 },
        },
        audio: false,
      })
      .then(async (mediaStream) => {
        if (cancelled) {
          mediaStream.getTracks().forEach((track) => track.stop());
          return;
        }
        stream = mediaStream;
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = mediaStream;
        await video.play().catch(() => undefined);
        if (!cancelled) setLive(true);
      })
      .catch(() => {
        if (cancelled) return;
        setError('打不开相机，可以直接从相册里选一张。');
      });

    return () => {
      cancelled = true;
      stream?.getTracks().forEach((track) => track.stop());
      setLive(false);
    };
  }, [open]);

  if (!open) return null;

  const handleCapture = () => {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0) return;

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    onCapture(canvas.toDataURL('image/jpeg', 0.95), canvas.width, canvas.height);
  };

  return (
    <div className="sheet-backdrop" role="dialog" aria-modal="true" aria-labelledby="camera-sheet-title">
      <div className="sheet">
        <div className="sheet-head">
          <span id="camera-sheet-title">把书放平，对齐四角框框</span>
          <button className="ghost" type="button" onClick={onClose}>
            返回
          </button>
        </div>

        <div className="video-wrap">
          <video ref={videoRef} playsInline muted autoPlay />
          {live ? (
            <div className="camera-guide" aria-hidden="true">
              <span className="corner tl" />
              <span className="corner tr" />
              <span className="corner bl" />
              <span className="corner br" />
            </div>
          ) : null}
          {!live && !error && <div className="video-hint">正在打开相机…</div>}
          {error && (
            <div className="video-hint error">
              <p>{error}</p>
              {onPickFile ? (
                <label className="kid-album">
                  从相册选一张
                  <input
                    type="file"
                    accept="image/*"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      event.target.value = '';
                      if (file) {
                        onClose();
                        onPickFile(file);
                      }
                    }}
                  />
                </label>
              ) : null}
            </div>
          )}
        </div>

        <div className="sheet-foot">
          <button className="primary big" type="button" onClick={handleCapture} disabled={!live}>
            📷 拍下这一页
          </button>
        </div>
      </div>
    </div>
  );
}
