import { useEffect, useRef, useState } from 'react';

interface CameraSheetProps {
  open: boolean;
  onClose: () => void;
  onCapture: (dataUrl: string, width: number, height: number) => void;
}

export function CameraSheet({ open, onClose, onCapture }: CameraSheetProps) {
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
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : '无法访问摄像头，请改用相册选图');
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
    <div className="sheet-backdrop" role="dialog" aria-modal="true">
      <div className="sheet">
        <div className="sheet-head">
          <span>拍照</span>
          <button className="ghost" onClick={onClose}>
            关闭
          </button>
        </div>

        <div className="video-wrap">
          <video ref={videoRef} playsInline muted autoPlay />
          {!live && !error && <div className="video-hint">正在打开摄像头…</div>}
          {error && <div className="video-hint error">{error}</div>}
        </div>

        <div className="sheet-foot">
          <button className="primary big" onClick={handleCapture} disabled={!live}>
            拍下这一页
          </button>
        </div>
      </div>
    </div>
  );
}
