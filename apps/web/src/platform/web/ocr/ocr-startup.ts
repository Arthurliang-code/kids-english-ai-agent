/**
 * OCR 引擎启动与运行环境兼容工具（尤其针对 iPad Safari / iOS WebKit / 主屏幕 PWA）。
 * 保持纯函数与可注入环境参数，方便直接用 node:test 做回归测试。
 */

/** wasm-feature-detect 标准探测字节码 */
export const RELAXED_SIMD_WASM = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 15, 1, 13, 0, 65, 1, 253,
  15, 65, 2, 253, 15, 253, 128, 2, 11,
]);

export const SIMD_WASM = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15,
  253, 98, 11,
]);

export interface NavigatorLike {
  userAgent?: string;
  platform?: string;
  maxTouchPoints?: number;
}

export interface WasmLike {
  validate?: (bytes: Uint8Array<ArrayBuffer>) => boolean;
}

export interface RuntimeEnv {
  navigator?: NavigatorLike;
  WebAssembly?: WasmLike;
  Worker?: unknown;
}

export function isAppleTouchDevice(nav?: NavigatorLike): boolean {
  const target = nav ?? (typeof navigator !== 'undefined' ? navigator : undefined);
  if (!target) return false;
  const ua = target.userAgent ?? '';
  return (
    /iPad|iPhone|iPod/.test(ua) ||
    (target.platform === 'MacIntel' && (target.maxTouchPoints ?? 0) > 1)
  );
}

export function safeValidateWasm(bytes: Uint8Array<ArrayBuffer>, wasm?: WasmLike): boolean {
  const target = wasm ?? (typeof WebAssembly === 'object' ? WebAssembly : undefined);
  if (!target || typeof target.validate !== 'function') return false;
  try {
    return Boolean(target.validate(bytes));
  } catch {
    return false;
  }
}

export function selectCoreCandidates(assetBase: string, env?: RuntimeEnv): string[] {
  const wasm = env && 'WebAssembly' in env ? env.WebAssembly : typeof WebAssembly === 'object' ? WebAssembly : undefined;
  const nav = env && 'navigator' in env ? env.navigator : typeof navigator !== 'undefined' ? navigator : undefined;
  const candidates: string[] = [];

  if (!isAppleTouchDevice(nav) && safeValidateWasm(RELAXED_SIMD_WASM, wasm)) {
    candidates.push(`${assetBase}/tesseract-core-relaxedsimd-lstm.wasm.js`);
  }
  if (safeValidateWasm(SIMD_WASM, wasm)) {
    candidates.push(`${assetBase}/tesseract-core-simd-lstm.wasm.js`);
  }
  candidates.push(`${assetBase}/tesseract-core-lstm.wasm.js`);
  return candidates;
}

export function checkOcrRuntimeSupport(env?: RuntimeEnv): { ok: true } | { ok: false; reason: string } {
  const hasWorker =
    env && 'Worker' in env ? typeof env.Worker === 'function' : typeof Worker === 'function';
  if (!hasWorker) {
    return {
      ok: false,
      reason: 'OCR 引擎初始化失败：当前浏览器不支持 Web Worker',
    };
  }

  const hasWasm =
    env && 'WebAssembly' in env
      ? typeof env.WebAssembly === 'object' && env.WebAssembly !== null
      : typeof WebAssembly === 'object' && WebAssembly !== null;
  if (!hasWasm) {
    return {
      ok: false,
      reason: 'OCR 引擎初始化失败：当前环境未启用 WebAssembly（若 iPad 开启了锁定模式请关闭）',
    };
  }

  return { ok: true };
}

export function normalizeWorkerError(err: unknown, coreFile: string): Error {
  const coreName = coreFile.split('/').pop() ?? coreFile;
  if (err instanceof Error && err.message.trim().length > 0) {
    return err;
  }
  if (typeof err === 'string' && err.trim().length > 0) {
    return new Error(`OCR 引擎初始化失败（${coreName}）：${err.trim()}`);
  }
  return new Error(`OCR 引擎初始化失败（${coreName} 未能加载或启动）`);
}

export interface RecognitionErrorInfo {
  message: string;
  shouldResetEngine: boolean;
}

export function classifyRecognitionError(err: unknown): RecognitionErrorInfo {
  const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : '';

  if (msg.includes('WebAssembly') || msg.includes('锁定模式')) {
    return {
      message: '当前 iPad 环境未启用离线识别所需的 WebAssembly（如开启了“锁定模式”请为本站关闭后重试）。',
      shouldResetEngine: true,
    };
  }

  if (msg.includes('超时')) {
    return {
      message: '识别模型加载或扫描超时，请检查网络后点“重试识别”或“再拍一页”。',
      shouldResetEngine: true,
    };
  }

  if (msg.includes('图片加载') || msg.includes('图片尺寸为 0') || msg.includes('canvas')) {
    return {
      message: '照片读取失败，请重新拍一张或从相册另选一张。',
      shouldResetEngine: false,
    };
  }

  if (msg.includes('OCR 引擎') || msg.includes('Worker') || msg.includes('worker')) {
    const detail = msg.trim() ? `（${msg.trim().slice(0, 80)}）` : '';
    return {
      message: `离线认字引擎未能启动，请检查网络后点“重试识别”或“修复并刷新”${detail}。`,
      shouldResetEngine: true,
    };
  }

  return {
    message: '这一页识别失败，可以点“重试识别”或再拍一次。',
    shouldResetEngine: true,
  };
}

/**
 * 直接通过 DecompressionStream writer/reader 解压 Gzip 字节流（带超时保护），
 * 避开 iPadOS WebKit 下 `new Response(new Blob([bytes]).stream().pipeThrough(...))` 偶发流锁死问题。
 */
export async function gunzipBytes(bytes: Uint8Array, timeoutMs = 8000): Promise<Uint8Array> {
  const isGzip = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  if (!isGzip) return bytes;

  if (typeof DecompressionStream !== 'function') {
    throw new Error('当前浏览器不支持 Gzip 解压');
  }

  const decompressPromise = (async () => {
    const ds = new DecompressionStream('gzip');
    const writer = ds.writable.getWriter();
    void writer
      .write(bytes as unknown as BufferSource)
      .then(() => writer.close())
      .catch(() => undefined);

    const reader = ds.readable.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.byteLength;
      }
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  })();

  if (!(timeoutMs > 0) || typeof setTimeout !== 'function') {
    return decompressPromise;
  }

  return new Promise<Uint8Array>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Gzip 解压超时')), timeoutMs);
    decompressPromise.then(
      (res) => {
        clearTimeout(timer);
        resolve(res);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** 将 `data:image/...;base64,...` 同步解码为 Uint8Array，用作 canvas.toBlob 失败/超时时的兜底 */
export function dataUrlToUint8Array(dataUrl: string): Uint8Array | undefined {
  const comma = dataUrl.indexOf(',');
  if (comma < 0 || !dataUrl.slice(0, comma).includes(';base64')) return undefined;
  const base64 = dataUrl.slice(comma + 1);
  if (!base64) return undefined;
  try {
    if (typeof atob === 'function') {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
      }
      return bytes;
    }
    if (typeof Buffer !== 'undefined') {
      return new Uint8Array(Buffer.from(base64, 'base64'));
    }
  } catch {
    return undefined;
  }
  return undefined;
}
