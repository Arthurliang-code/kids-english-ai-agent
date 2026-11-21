/**
 * 相机启动与取帧兼容逻辑（针对 iPad Safari / iOS WebKit / 主屏幕 PWA）：
 * 1. 先检查 `navigator.mediaDevices?.getUserMedia`，避免非 HTTPS 或受限 WebKit 下同步 TypeError 导致白屏；
 * 2. 为 `getUserMedia` 增加超时与约束降级链（高分辨率后置 -> 后置 -> 任意摄像头），防止 iPad PWA 永久卡在“正在打开相机…”；
 * 3. 等待 `<video>` 真实出帧（`videoWidth > 0`），并区分低电量模式拦截自动播放等状态，避免点击拍照静默无响应；
 * 4. 释放摄像头流时同时停止所有 track 并清空 `video.srcObject = null`，防止 iOS PWA 再次打开相机时硬件锁死。
 */

export const CAMERA_OPEN_TIMEOUT_MS = 10_000;
export const VIDEO_READY_TIMEOUT_MS = 4_000;

export interface MediaTrackLike {
  stop: () => void;
}

export interface MediaStreamLike {
  getTracks: () => MediaTrackLike[];
}

export interface MediaDevicesLike {
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStreamLike>;
}

export interface VideoElementLike {
  srcObject: unknown;
  muted: boolean;
  playsInline: boolean;
  videoWidth: number;
  videoHeight: number;
  paused?: boolean;
  setAttribute?: (name: string, value: string) => void;
  play: () => Promise<void>;
  addEventListener: (event: string, listener: () => void) => void;
  removeEventListener: (event: string, listener: () => void) => void;
}

export type CameraOpenErrorCode = 'unsupported' | 'permission' | 'timeout' | 'unavailable';

export interface CameraOpenSuccess {
  ok: true;
  stream: MediaStreamLike;
}

export interface CameraOpenFailure {
  ok: false;
  code: CameraOpenErrorCode;
  message: string;
}

export type CameraOpenResult = CameraOpenSuccess | CameraOpenFailure;

export const CAMERA_CONSTRAINT_CHAIN: MediaStreamConstraints[] = [
  {
    video: {
      facingMode: { ideal: 'environment' },
      width: { ideal: 1920 },
      height: { ideal: 1440 },
    },
    audio: false,
  },
  {
    video: {
      facingMode: 'environment',
    },
    audio: false,
  },
  {
    video: true,
    audio: false,
  },
];

export function stopStreamTracks(stream: MediaStreamLike | null | undefined): void {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // 忽略已停止轨道的异常
    }
  }
}

export function detachVideoStream(
  video: Pick<VideoElementLike, 'srcObject'> | null | undefined,
  stream?: MediaStreamLike | null,
): void {
  stopStreamTracks(stream);
  if (video) {
    video.srcObject = null;
  }
}

function getErrorName(error: unknown): string {
  if (error && typeof error === 'object' && 'name' in error && typeof error.name === 'string') {
    return error.name;
  }
  return '';
}

function requestUserMediaWithTimeout(
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStreamLike>,
  constraints: MediaStreamConstraints,
  timeoutMs: number,
  isCancelled: () => boolean,
): Promise<MediaStreamLike> {
  return new Promise<MediaStreamLike>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const err = new Error('CAMERA_TIMEOUT');
      err.name = 'TimeoutError';
      reject(err);
    }, timeoutMs);

    void Promise.resolve()
      .then(() => getUserMedia(constraints))
      .then(
        (stream) => {
          clearTimeout(timer);
          if (settled || isCancelled()) {
            stopStreamTracks(stream);
            if (!settled) {
              settled = true;
              reject(new Error('CAMERA_CANCELLED'));
            }
            return;
          }
          settled = true;
          resolve(stream);
        },
        (error) => {
          clearTimeout(timer);
          if (settled) return;
          settled = true;
          reject(error);
        },
      );
  });
}

export async function openCameraStream(options: {
  mediaDevices?: MediaDevicesLike | null;
  timeoutMs?: number;
  isCancelled?: () => boolean;
}): Promise<CameraOpenResult> {
  const mediaDevices = options.mediaDevices;
  const timeoutMs = options.timeoutMs ?? CAMERA_OPEN_TIMEOUT_MS;
  const isCancelled = options.isCancelled ?? (() => false);

  if (!mediaDevices || typeof mediaDevices.getUserMedia !== 'function') {
    return {
      ok: false,
      code: 'unsupported',
      message: '当前页面无法直接调用实时相机，请点下方「用系统相机拍」或「从相册选一张」。',
    };
  }

  const boundGetUserMedia = (constraints: MediaStreamConstraints) =>
    mediaDevices.getUserMedia!(constraints);

  let lastError: unknown = null;
  for (const constraints of CAMERA_CONSTRAINT_CHAIN) {
    if (isCancelled()) {
      return { ok: false, code: 'unavailable', message: '相机已关闭。' };
    }
    try {
      const stream = await requestUserMediaWithTimeout(
        boundGetUserMedia,
        constraints,
        timeoutMs,
        isCancelled,
      );
      return { ok: true, stream };
    } catch (error) {
      lastError = error;
      const name = getErrorName(error);
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
        return {
          ok: false,
          code: 'permission',
          message: '没有相机权限，可以在 iPad 设置里允许 Safari 使用相机，或直接点下方「用系统相机拍」。',
        };
      }
      if (name === 'TimeoutError') {
        return {
          ok: false,
          code: 'timeout',
          message: '打开相机超时，请点下方「用系统相机拍」或「从相册选一张」。',
        };
      }
      // OverconstrainedError / NotFoundError / AbortError 等继续尝试下一档更宽松约束
    }
  }

  const name = getErrorName(lastError);
  return {
    ok: false,
    code: name === 'TimeoutError' ? 'timeout' : 'unavailable',
    message: '打不开实时相机，请点下方「用系统相机拍」或「从相册选一张」。',
  };
}

export type VideoReadyStatus = 'ready' | 'needs-gesture' | 'timeout';

export async function attachAndWaitForVideo(
  video: VideoElementLike,
  stream: MediaStreamLike,
  options?: { timeoutMs?: number; isCancelled?: () => boolean },
): Promise<VideoReadyStatus> {
  const timeoutMs = options?.timeoutMs ?? VIDEO_READY_TIMEOUT_MS;
  const isCancelled = options?.isCancelled ?? (() => false);

  video.muted = true;
  video.playsInline = true;
  video.setAttribute?.('muted', '');
  video.setAttribute?.('playsinline', '');
  video.srcObject = stream;

  let playBlocked = false;
  try {
    await video.play();
  } catch (error) {
    const name = getErrorName(error);
    if (name === 'NotAllowedError') {
      playBlocked = true;
    }
  }

  if (isCancelled()) return 'timeout';
  if (video.videoWidth > 0 && video.videoHeight > 0) {
    return playBlocked && video.paused ? 'needs-gesture' : 'ready';
  }
  if (playBlocked) {
    return 'needs-gesture';
  }

  return new Promise<VideoReadyStatus>((resolve) => {
    let settled = false;
    const events = ['loadedmetadata', 'loadeddata', 'canplay', 'playing'];
    const finish = (status: VideoReadyStatus) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      for (const evt of events) video.removeEventListener(evt, check);
      resolve(status);
    };
    const check = () => {
      if (isCancelled()) {
        finish('timeout');
        return;
      }
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        finish('ready');
      }
    };
    const timer = setTimeout(() => {
      finish(video.videoWidth > 0 && video.videoHeight > 0 ? 'ready' : 'timeout');
    }, timeoutMs);
    const poll = setInterval(check, 80);

    for (const evt of events) video.addEventListener(evt, check);
    check();
  });
}

export type VisibilityStateLike = 'visible' | 'hidden' | string;

export interface CameraPreviewControllerOptions {
  getMediaDevices: () => MediaDevicesLike | null | undefined;
  getVideo: () => VideoElementLike | null | undefined;
  /** 返回 false 时（例如已选图或正在拍照），页面恢复 visible 后不再重开实时预览 */
  shouldResume?: () => boolean;
  openStream?: typeof openCameraStream;
  attachVideo?: typeof attachAndWaitForVideo;
  openTimeoutMs?: number;
  videoReadyTimeoutMs?: number;
  onLive?: () => void;
  onNeedsPlay?: () => void;
  onSuspended?: () => void;
  onError?: (message: string) => void;
}

export interface CameraPreviewControllerState {
  disposed: boolean;
  inFlight: boolean;
  hasActiveStream: boolean;
}

export interface CameraPreviewController {
  start: () => Promise<void>;
  pause: () => void;
  handleVisibilityChange: (visibilityState: VisibilityStateLike) => void;
  releaseActiveStream: () => void;
  dispose: () => void;
  getState: () => CameraPreviewControllerState;
}

/**
 * 管理相机浮层的实时预览生命周期：
 * - 页面 hidden 时只释放摄像头轨道并清空 video.srcObject，不销毁控制器（不关闭浮层）；
 * - 页面恢复 visible 且尚未选图/拍照时重新开启实时预览，并防止与进行中的打开流程竞争或泄漏轨道；
 * - 浮层关闭/卸载时调用 dispose 彻底终止并清理。
 */
export function createCameraPreviewController(
  options: CameraPreviewControllerOptions,
): CameraPreviewController {
  const openStreamFn = options.openStream ?? openCameraStream;
  const attachVideoFn = options.attachVideo ?? attachAndWaitForVideo;

  let disposed = false;
  let sessionToken = 0;
  let inFlight = false;
  let activeStream: MediaStreamLike | null = null;

  const releaseActiveStream = () => {
    sessionToken += 1;
    inFlight = false;
    const streamToStop = activeStream;
    activeStream = null;
    detachVideoStream(options.getVideo(), streamToStop);
  };

  const pause = () => {
    if (disposed) return;
    releaseActiveStream();
    options.onSuspended?.();
  };

  const start = async (): Promise<void> => {
    if (disposed) return;
    if (options.shouldResume && !options.shouldResume()) return;
    if (inFlight || activeStream) return;

    const token = ++sessionToken;
    inFlight = true;
    const isStale = () => disposed || token !== sessionToken;

    try {
      const result = await openStreamFn({
        mediaDevices: options.getMediaDevices(),
        timeoutMs: options.openTimeoutMs,
        isCancelled: isStale,
      });

      if (isStale()) {
        if (result.ok) stopStreamTracks(result.stream);
        return;
      }

      if (!result.ok) {
        options.onError?.(result.message);
        return;
      }

      const video = options.getVideo();
      if (!video) {
        stopStreamTracks(result.stream);
        return;
      }

      activeStream = result.stream;
      const ready = await attachVideoFn(video, result.stream, {
        timeoutMs: options.videoReadyTimeoutMs,
        isCancelled: isStale,
      });

      if (isStale()) {
        if (activeStream === result.stream) {
          activeStream = null;
          stopStreamTracks(result.stream);
        }
        return;
      }

      if (ready === 'ready') {
        options.onLive?.();
      } else if (ready === 'needs-gesture') {
        options.onNeedsPlay?.();
      } else {
        if (activeStream === result.stream) {
          activeStream = null;
        }
        detachVideoStream(video, result.stream);
        options.onError?.('相机画面未能启动，请点下方「用系统相机拍」或「从相册选一张」。');
      }
    } finally {
      if (token === sessionToken) {
        inFlight = false;
      }
    }
  };

  const handleVisibilityChange = (visibilityState: VisibilityStateLike) => {
    if (disposed) return;
    if (visibilityState === 'hidden') {
      pause();
    } else if (visibilityState === 'visible') {
      void start();
    }
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    releaseActiveStream();
  };

  const getState = (): CameraPreviewControllerState => ({
    disposed,
    inFlight,
    hasActiveStream: activeStream !== null,
  });

  return {
    start,
    pause,
    handleVisibilityChange,
    releaseActiveStream,
    dispose,
    getState,
  };
}
