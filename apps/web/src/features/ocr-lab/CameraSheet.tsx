import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import {
  createCameraPreviewController,
  type CameraPreviewController,
} from './camera-utils';

interface CameraSheetProps {
  open: boolean;
  onClose: () => void;
  onCapture: (url: string, fromObjectUrl: boolean) => void;
  onPickFile?: (file: File) => void;
}

const CAPTURE_MAX_EDGE = 2048;

const HIDDEN_FILE_INPUT_STYLE: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: 'hidden',
  clip: 'rect(0, 0, 0, 0)',
  whiteSpace: 'nowrap',
  border: 0,
  pointerEvents: 'none',
};

export function CameraSheet({ open, onClose, onCapture, onPickFile }: CameraSheetProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const controllerRef = useRef<CameraPreviewController | null>(null);
  const capturingRef = useRef(false);
  const selectedImageRef = useRef(false);
  const systemCameraInputId = useId();
  const albumInputId = useId();
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [needsPlay, setNeedsPlay] = useState(false);
  const [capturing, setCapturing] = useState(false);

  useEffect(() => {
    if (!open) return;

    capturingRef.current = false;
    selectedImageRef.current = false;
    setError(null);
    setLive(false);
    setNeedsPlay(false);
    setCapturing(false);

    const controller = createCameraPreviewController({
      getMediaDevices: () => (typeof navigator !== 'undefined' ? navigator.mediaDevices : null),
      getVideo: () => videoRef.current,
      shouldResume: () => !capturingRef.current && !selectedImageRef.current,
      onLive: () => {
        setError(null);
        setLive(true);
        setNeedsPlay(false);
      },
      onNeedsPlay: () => {
        setError(null);
        setLive(false);
        setNeedsPlay(true);
      },
      onSuspended: () => {
        setLive(false);
        setNeedsPlay(false);
      },
      onError: (message) => {
        setLive(false);
        setNeedsPlay(false);
        setError(message);
      },
    });
    controllerRef.current = controller;

    const handleVisibilityChange = () => {
      controller.handleVisibilityChange(document.visibilityState);
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    if (document.visibilityState !== 'hidden') {
      void controller.start();
    }

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      controller.dispose();
      if (controllerRef.current === controller) {
        controllerRef.current = null;
      }
      capturingRef.current = false;
      setLive(false);
      setNeedsPlay(false);
      setCapturing(false);
    };
  }, [open]);

  if (!open) return null;

  const handleResumeVideo = async () => {
    const video = videoRef.current;
    if (!video) return;
    try {
      await video.play();
      if (!controllerRef.current?.getState().hasActiveStream) return;
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        setNeedsPlay(false);
        setLive(true);
        return;
      }
    } catch {
      // 回落到系统相机/相册兜底
    }
    if (!controllerRef.current?.getState().hasActiveStream) return;
    controllerRef.current?.releaseActiveStream();
    setNeedsPlay(false);
    setError('当前模式无法自动开启取景画面，请点下方「用系统相机拍」或「从相册选一张」。');
  };

  const handleCapture = () => {
    if (capturing) return;
    const video = videoRef.current;
    if (!video || video.videoWidth === 0 || video.videoHeight === 0) {
      setError('相机画面还没准备好，请点下方「用系统相机拍」或返回重试。');
      return;
    }

    capturingRef.current = true;
    setCapturing(true);
    const scale = Math.min(1, CAPTURE_MAX_EDGE / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      capturingRef.current = false;
      setCapturing(false);
      setError('拍照画布初始化失败，请点下方「用系统相机拍」或「从相册选一张」。');
      return;
    }
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    // 拍下瞬间先停掉实时摄像头流并清空 srcObject，释放 iPad 内存与 GPU 给后续识别
    controllerRef.current?.releaseActiveStream();

    let settled = false;
    const finishCapture = (url: string, fromObjectUrl: boolean) => {
      if (settled) return;
      settled = true;
      selectedImageRef.current = true;
      window.clearTimeout(fallbackTimer);
      onCapture(url, fromObjectUrl);
    };
    const failCapture = () => {
      if (settled) return;
      settled = true;
      capturingRef.current = false;
      window.clearTimeout(fallbackTimer);
      setCapturing(false);
      setLive(false);
      setError('拍照导出失败，请点下方「用系统相机拍」或「从相册选一张」。');
    };

    const fallbackTimer = window.setTimeout(() => {
      try {
        finishCapture(canvas.toDataURL('image/jpeg', 0.88), false);
      } catch {
        failCapture();
      }
    }, 1200);

    if (typeof canvas.toBlob === 'function') {
      try {
        canvas.toBlob(
          (blob) => {
            if (blob) {
              finishCapture(URL.createObjectURL(blob), true);
            } else {
              try {
                finishCapture(canvas.toDataURL('image/jpeg', 0.88), false);
              } catch {
                failCapture();
              }
            }
          },
          'image/jpeg',
          0.88,
        );
        return;
      } catch {
        // 回退到同步导出
      }
    }

    try {
      finishCapture(canvas.toDataURL('image/jpeg', 0.88), false);
    } catch {
      failCapture();
    }
  };

  const handleFallbackFile = (file: File | undefined) => {
    if (!file || !onPickFile) return;
    selectedImageRef.current = true;
    controllerRef.current?.dispose();
    onClose();
    onPickFile(file);
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
          {!live && !needsPlay && !error && <div className="video-hint">正在打开相机…</div>}
          {needsPlay && !error ? (
            <div className="video-hint">
              <p>点一下开启实时取景画面（如处于低电量模式）</p>
              <button className="primary" type="button" onClick={() => void handleResumeVideo()}>
                开启相机画面
              </button>
            </div>
          ) : null}
          {error && (
            <div className="video-hint error">
              <p>{error}</p>
              {onPickFile ? (
                <div className="video-hint-actions">
                  <label
                    className="kid-album"
                    htmlFor={systemCameraInputId}
                    onClick={() => controllerRef.current?.pause()}
                  >
                    📷 用系统相机拍
                  </label>
                  <label
                    className="kid-album"
                    htmlFor={albumInputId}
                    onClick={() => controllerRef.current?.pause()}
                  >
                    🖼️ 从相册选一张
                  </label>
                </div>
              ) : null}
            </div>
          )}
        </div>

        {onPickFile ? (
          <>
            <input
              id={systemCameraInputId}
              type="file"
              accept="image/*"
              capture="environment"
              style={HIDDEN_FILE_INPUT_STYLE}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                handleFallbackFile(file);
              }}
            />
            <input
              id={albumInputId}
              type="file"
              accept="image/*"
              style={HIDDEN_FILE_INPUT_STYLE}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                handleFallbackFile(file);
              }}
            />
          </>
        ) : null}

        <div className="sheet-foot">
          <button
            className="primary big"
            type="button"
            onClick={handleCapture}
            disabled={!live || capturing}
          >
            {capturing ? '正在处理照片…' : '📷 拍下这一页'}
          </button>
          {onPickFile ? (
            <div className="sheet-foot-alt">
              <label
                className="sheet-alt-btn"
                htmlFor={systemCameraInputId}
                onClick={() => controllerRef.current?.pause()}
              >
                📷 用系统相机拍
              </label>
              <label
                className="sheet-alt-btn"
                htmlFor={albumInputId}
                onClick={() => controllerRef.current?.pause()}
              >
                🖼️ 从相册选一张
              </label>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
