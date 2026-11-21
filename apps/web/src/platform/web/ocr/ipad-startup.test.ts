import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { generateServiceWorkerSource } from '../../../../pwa-plugin.ts';
import {
  attachAndWaitForVideo,
  createCameraPreviewController,
  detachVideoStream,
  openCameraStream,
  type CameraOpenResult,
  type MediaStreamLike,
  type VideoElementLike,
} from '../../../features/ocr-lab/camera-utils.ts';
import {
  checkOcrRuntimeSupport,
  classifyRecognitionError,
  dataUrlToUint8Array,
  isAppleTouchDevice,
  normalizeWorkerError,
  selectCoreCandidates,
} from './ocr-startup.ts';

function createStrictWebKitSwHarness(options?: {
  failCacheOpen?: boolean;
  redirected?: boolean;
  pageTimeoutMs?: number;
  hangNavigationFetch?: boolean;
}) {
  const source = generateServiceWorkerSource({
    appCache: 'kea-app-test',
    staticCache: 'kea-static-v4',
    shellUrls: ['/kids-english-ai-agent/', '/kids-english-ai-agent/index.html'],
    staticPrefixes: [
      '/kids-english-ai-agent/tesseract/',
      '/kids-english-ai-agent/lexicon/',
      '/kids-english-ai-agent/samples/',
      '/kids-english-ai-agent/icons/',
    ],
    indexUrl: '/kids-english-ai-agent/index.html',
    pageTimeoutMs: options?.pageTimeoutMs,
  });

  const listeners = new Map<string, (event: unknown) => void>();
  const cacheStores = new Map<string, Map<string, { url: string; body: string; status: number }>>();
  let fetchCount = 0;
  let skipWaitingCount = 0;

  const getStore = (name: string) => {
    let store = cacheStores.get(name);
    if (!store) {
      store = new Map();
      cacheStores.set(name, store);
    }
    return store;
  };

  const sandbox = {
    URL,
    Promise,
    setTimeout,
    clearTimeout,
    self: {
      location: { origin: 'https://example.github.io' },
      addEventListener(type: string, fn: (event: unknown) => void) {
        listeners.set(type, fn);
      },
      skipWaiting: async () => {
        skipWaitingCount += 1;
      },
      clients: { claim: async () => undefined },
    },
    caches: {
      async open(name: string) {
        if (options?.failCacheOpen) {
          throw new Error('WebKit CacheStorage internal error');
        }
        const store = getStore(name);
        return {
          async addAll(urls: string[]) {
            for (const u of urls) {
              store.set(u, { url: u, body: `cached:${u}`, status: 200 });
            }
          },
          async match(req: { url: string } | string) {
            const rawKey = typeof req === 'string' ? req : req.url;
            const pathname = rawKey.startsWith('http') ? new URL(rawKey).pathname : rawKey;
            return store.get(rawKey) ?? store.get(pathname);
          },
          async put(req: { url: string } | string, resp: { url: string; body: string; status: number }) {
            const key = typeof req === 'string' ? req : req.url;
            store.set(key, resp);
          },
        };
      },
      async keys() {
        return [...cacheStores.keys()];
      },
      async delete(key: string) {
        return cacheStores.delete(key);
      },
    },
    async fetch(req: { url: string; mode?: string }) {
      fetchCount += 1;
      if (options?.hangNavigationFetch && req.mode === 'navigate') {
        return new Promise(() => {
          // 模拟弱网假死挂起
        });
      }
      await Promise.resolve();
      const body = `ok:${req.url}`;
      const makeResp = () => ({
        ok: true,
        status: 200,
        redirected: Boolean(options?.redirected),
        url: req.url,
        body,
        clone: () => makeResp(),
      });
      return makeResp();
    },
  };

  vm.runInNewContext(source, sandbox);

  const dispatchFetch = async (url: string, mode = 'cors') => {
    const handler = listeners.get('fetch');
    assert.ok(handler, 'fetch listener must be registered');

    let inSyncDispatch = true;
    let responsePromise: Promise<unknown> | null = null;
    const waitUntilPromises: Promise<unknown>[] = [];

    const event = {
      request: { url, method: 'GET', mode },
      waitUntil(promise: Promise<unknown>) {
        // 严格模拟 WebKit / 规范：超出同步事件派发阶段调用 waitUntil 时抛出 InvalidStateError
        if (!inSyncDispatch) {
          const err = new Error('The object is in an invalid state.');
          err.name = 'InvalidStateError';
          throw err;
        }
        waitUntilPromises.push(Promise.resolve(promise));
      },
      respondWith(promise: Promise<unknown>) {
        if (!inSyncDispatch) {
          const err = new Error('respondWith called asynchronously');
          err.name = 'InvalidStateError';
          throw err;
        }
        responsePromise = Promise.resolve(promise);
      },
    };

    handler(event);
    inSyncDispatch = false;

    assert.ok(responsePromise, 'respondWith must be invoked synchronously');
    const response = await responsePromise;
    await Promise.all(waitUntilPromises);
    return { response: response as { status: number; body: string }, fetchCount };
  };

  return {
    dispatchFetch,
    cacheStores,
    listeners,
    getSkipWaitingCount: () => skipWaitingCount,
  };
}

void test('SW 在严格 WebKit FetchEvent 生命周期下能正常加载并缓存 OCR 静态资源（不触发异步 waitUntil InvalidStateError）', async () => {
  const { dispatchFetch, cacheStores } = createStrictWebKitSwHarness();
  const workerUrl = 'https://example.github.io/kids-english-ai-agent/tesseract/worker.min.js';
  const wasmUrl =
    'https://example.github.io/kids-english-ai-agent/tesseract/tesseract-core-simd-lstm.wasm.js';
  const langUrl =
    'https://example.github.io/kids-english-ai-agent/tesseract/tessdata/eng.traineddata.gz';

  const first = await dispatchFetch(workerUrl);
  assert.equal(first.response.status, 200);
  assert.equal(first.fetchCount, 1);

  const second = await dispatchFetch(workerUrl);
  assert.equal(second.response.status, 200);
  assert.equal(second.fetchCount, 1, '第二次请求应直接命中 STATIC_CACHE');

  const wasmRes = await dispatchFetch(wasmUrl);
  const langRes = await dispatchFetch(langUrl);
  assert.equal(wasmRes.response.status, 200);
  assert.equal(langRes.response.status, 200);
  assert.equal(cacheStores.get('kea-static-v4')?.size, 3);
});

void test('SW 在 Safari CacheStorage 抛错时回退网络 fetch，且不缓存重定向响应', async () => {
  const brokenCache = createStrictWebKitSwHarness({ failCacheOpen: true });
  const res = await brokenCache.dispatchFetch(
    'https://example.github.io/kids-english-ai-agent/tesseract/worker.min.js',
  );
  assert.equal(res.response.status, 200);

  const redirected = createStrictWebKitSwHarness({ redirected: true });
  await redirected.dispatchFetch(
    'https://example.github.io/kids-english-ai-agent/tesseract/worker.min.js',
  );
  assert.equal(redirected.cacheStores.get('kea-static-v4')?.size ?? 0, 0);
});

void test('openCameraStream 在 iPad 缺少 navigator.mediaDevices 时返回明确失败而非抛出同步异常', async () => {
  const result = await openCameraStream({ mediaDevices: undefined });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, 'unsupported');
    assert.match(result.message, /系统相机|相册/);
  }
});

void test('openCameraStream 在 iPad PWA getUserMedia 挂起时按超时退出并在迟到返回后释放轨道', async () => {
  let stopped = 0;
  let resolveLate!: (stream: MediaStreamLike) => void;
  const lateStreamPromise = new Promise<MediaStreamLike>((resolve) => {
    resolveLate = resolve;
  });

  const result = await openCameraStream({
    mediaDevices: {
      getUserMedia: () => lateStreamPromise,
    },
    timeoutMs: 25,
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, 'timeout');
    assert.match(result.message, /超时/);
  }

  resolveLate({
    getTracks: () => [{ stop: () => (stopped += 1) }],
  });
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(stopped, 1, '超时后迟到返回的摄像头轨道必须立即 stop');
});

void test('openCameraStream 高分辨率约束失败时自动降级到宽松约束', async () => {
  let attempts = 0;
  const result = await openCameraStream({
    mediaDevices: {
      getUserMedia: async () => {
        attempts += 1;
        if (attempts === 1) {
          const err = new Error('overconstrained');
          err.name = 'OverconstrainedError';
          throw err;
        }
        return { getTracks: () => [{ stop: () => undefined }] };
      },
    },
    timeoutMs: 200,
  });

  assert.equal(result.ok, true);
  assert.equal(attempts, 2);
});

void test('attachAndWaitForVideo 在 iPad 低电量模式拦截 play() 时返回 needs-gesture，且 detachVideoStream 清空 srcObject', async () => {
  let stopped = 0;
  const listeners = new Map<string, Set<() => void>>();
  const attrs = new Map<string, string>();
  const video: VideoElementLike = {
    srcObject: null,
    muted: false,
    playsInline: false,
    videoWidth: 0,
    videoHeight: 0,
    paused: true,
    setAttribute(name, value) {
      attrs.set(name, value);
    },
    async play() {
      const err = new Error('NotAllowedError');
      err.name = 'NotAllowedError';
      throw err;
    },
    addEventListener(event, fn) {
      const set = listeners.get(event) ?? new Set();
      set.add(fn);
      listeners.set(event, set);
    },
    removeEventListener(event, fn) {
      listeners.get(event)?.delete(fn);
    },
  };
  const stream: MediaStreamLike = {
    getTracks: () => [{ stop: () => (stopped += 1) }],
  };

  const status = await attachAndWaitForVideo(video, stream, { timeoutMs: 80 });
  assert.equal(status, 'needs-gesture');
  assert.equal(video.muted, true);
  assert.equal(video.playsInline, true);
  assert.equal(attrs.get('playsinline'), '');
  assert.equal(video.srcObject, stream);

  detachVideoStream(video, stream);
  assert.equal(stopped, 1);
  assert.equal(video.srcObject, null);
});

void test('selectCoreCandidates 在 iPadOS（含 MacIntel 触屏伪装）跳过 relaxedsimd 并在 validate 异常时安全降级', () => {
  const ipadNav = { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', maxTouchPoints: 5 };
  assert.equal(isAppleTouchDevice(ipadNav), true);

  const ipadCandidates = selectCoreCandidates('/tesseract', {
    navigator: ipadNav,
    WebAssembly: { validate: () => true },
  });
  assert.deepEqual(ipadCandidates, [
    '/tesseract/tesseract-core-simd-lstm.wasm.js',
    '/tesseract/tesseract-core-lstm.wasm.js',
  ]);

  const throwingWasmCandidates = selectCoreCandidates('/tesseract', {
    navigator: ipadNav,
    WebAssembly: {
      validate: () => {
        throw new Error('blocked');
      },
    },
  });
  assert.deepEqual(throwingWasmCandidates, ['/tesseract/tesseract-core-lstm.wasm.js']);
});

void test('checkOcrRuntimeSupport 在 iPadOS 锁定模式（禁用 WebAssembly）下快速给出明确原因', () => {
  const res = checkOcrRuntimeSupport({
    Worker: function MockWorker() {},
    WebAssembly: undefined,
  });
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.match(res.reason, /WebAssembly|锁定模式/);
    const classified = classifyRecognitionError(new Error(res.reason));
    assert.equal(classified.shouldResetEngine, true);
    assert.match(classified.message, /WebAssembly|锁定模式/);
  }
});

void test('normalizeWorkerError 与 classifyRecognitionError 不会把 Safari 空 worker.onerror 误报成“看不清”', () => {
  const normalized = normalizeWorkerError(undefined, '/tesseract/tesseract-core-simd-lstm.wasm.js');
  assert.match(normalized.message, /tesseract-core-simd-lstm\.wasm\.js/);

  const classified = classifyRecognitionError(normalized);
  assert.equal(classified.shouldResetEngine, true);
  assert.match(classified.message, /认字引擎未能启动/);
  assert.doesNotMatch(classified.message, /看不清/);
});

void test('dataUrlToUint8Array 正确解码 canvas.toDataURL 兜底字节流', () => {
  const bytes = dataUrlToUint8Array('data:image/jpeg;base64,/9j/4AAQ');
  assert.ok(bytes instanceof Uint8Array);
  assert.deepEqual([...bytes], [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  assert.equal(dataUrlToUint8Array('not-a-data-url'), undefined);
});

function createMockVideo(): VideoElementLike {
  return {
    srcObject: null,
    muted: false,
    playsInline: false,
    videoWidth: 1280,
    videoHeight: 720,
    paused: false,
    async play() {
      return undefined;
    },
    addEventListener() {},
    removeEventListener() {},
  };
}

function createTrackedStream() {
  let stopCount = 0;
  const stream: MediaStreamLike = {
    getTracks: () => [{ stop: () => (stopCount += 1) }],
  };
  return {
    stream,
    getStopCount: () => stopCount,
  };
}

void test('createCameraPreviewController 在 hidden 时只释轨不关闭浮层，visible 后可恢复预览，dispose 后不再重开', async () => {
  const video = createMockVideo();
  const s1 = createTrackedStream();
  const s2 = createTrackedStream();
  const streams = [s1.stream, s2.stream];
  let openCalls = 0;
  let liveCount = 0;
  let suspendedCount = 0;
  const errors: string[] = [];

  const controller = createCameraPreviewController({
    getMediaDevices: () => ({
      getUserMedia: async () => {
        openCalls += 1;
        return streams[openCalls - 1]!;
      },
    }),
    getVideo: () => video,
    onLive: () => {
      liveCount += 1;
    },
    onSuspended: () => {
      suspendedCount += 1;
    },
    onError: (msg) => {
      errors.push(msg);
    },
  });

  await controller.start();
  assert.equal(openCalls, 1);
  assert.equal(liveCount, 1);
  assert.equal(video.srcObject, s1.stream);
  assert.equal(controller.getState().hasActiveStream, true);
  assert.equal(controller.getState().disposed, false);

  // 页面切后台：仅释放轨道与 srcObject、置为非预览态，不销毁控制器
  controller.handleVisibilityChange('hidden');
  assert.equal(s1.getStopCount(), 1, 'hidden 必须释放当前摄像头轨道');
  assert.equal(video.srcObject, null, 'hidden 必须清空 video.srcObject');
  assert.equal(suspendedCount, 1, 'hidden 必须通知 UI 离开实时预览态');
  assert.equal(controller.getState().hasActiveStream, false);
  assert.equal(controller.getState().disposed, false, 'hidden 不应永久取消/关闭浮层');

  // 页面重新回到前台：重新拉起实时预览
  controller.handleVisibilityChange('visible');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(openCalls, 2);
  assert.equal(liveCount, 2);
  assert.equal(video.srcObject, s2.stream);
  assert.equal(controller.getState().hasActiveStream, true);
  assert.deepEqual(errors, []);

  // 用户点返回或卸载关闭浮层后，释放轨道且后续 visible 不再重开
  controller.dispose();
  assert.equal(s2.getStopCount(), 1);
  assert.equal(video.srcObject, null);
  assert.equal(controller.getState().disposed, true);

  controller.handleVisibilityChange('visible');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(openCalls, 2, 'dispose 后 visible 不应再次打开相机');
});

void test('createCameraPreviewController 在打开进行中切后台并恢复时，不并发打架且迟到轨道立即释放', async () => {
  const video = createMockVideo();
  const lateStream = createTrackedStream();
  const freshStream = createTrackedStream();
  const resolvers: Array<(res: CameraOpenResult) => void> = [];
  let openCalls = 0;
  let liveCount = 0;
  const errors: string[] = [];

  const controller = createCameraPreviewController({
    getMediaDevices: () => null,
    getVideo: () => video,
    openStream: async () => {
      openCalls += 1;
      return new Promise<CameraOpenResult>((resolve) => {
        resolvers.push(resolve);
      });
    },
    attachVideo: async (v, stream) => {
      v.srcObject = stream;
      return 'ready';
    },
    onLive: () => {
      liveCount += 1;
    },
    onError: (msg) => {
      errors.push(msg);
    },
  });

  // 第一次打开尚未返回（模拟弹出权限框或慢速硬件）
  const firstStart = controller.start();
  assert.equal(openCalls, 1);
  assert.equal(controller.getState().inFlight, true);

  // 切后台作废第一次打开，再回前台发起第二次打开
  controller.handleVisibilityChange('hidden');
  assert.equal(controller.getState().inFlight, false);

  controller.handleVisibilityChange('visible');
  assert.equal(openCalls, 2);
  assert.equal(controller.getState().inFlight, true);

  // 重复触发 visible 不应与正在进行的第二次打开打架
  controller.handleVisibilityChange('visible');
  assert.equal(openCalls, 2, '进行中的打开流程存在时，visible 不应重复发起打开');

  // 第一次打开迟到返回：必须立即停轨，且不能覆盖 video.srcObject 或破坏第二次打开的 inFlight 状态
  resolvers[0]!({ ok: true, stream: lateStream.stream });
  await firstStart;
  assert.equal(lateStream.getStopCount(), 1, '过期的迟到流必须立即释放');
  assert.equal(video.srcObject, null);
  assert.equal(controller.getState().inFlight, true, '旧流程结束不应误清当前新流程的 inFlight 状态');

  // 第二次打开正常返回：成功挂载并进入 live
  resolvers[1]!({ ok: true, stream: freshStream.stream });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(liveCount, 1);
  assert.equal(video.srcObject, freshStream.stream);
  assert.equal(freshStream.getStopCount(), 0);
  assert.equal(controller.getState().inFlight, false);
  assert.deepEqual(errors, []);

  controller.dispose();
  assert.equal(freshStream.getStopCount(), 1);
});

void test('createCameraPreviewController 在已选图/拍照中时，visible 不会重开相机；授权恢复后可重新打开', async () => {
  const video = createMockVideo();
  const recoveredStream = createTrackedStream();
  let openCalls = 0;
  let shouldResume = true;
  let liveCount = 0;
  const errors: string[] = [];

  const controller = createCameraPreviewController({
    getMediaDevices: () => null,
    getVideo: () => video,
    shouldResume: () => shouldResume,
    openStream: async () => {
      openCalls += 1;
      if (openCalls === 1) {
        return {
          ok: false,
          code: 'permission',
          message: '没有相机权限',
        };
      }
      return { ok: true, stream: recoveredStream.stream };
    },
    attachVideo: async (v, stream) => {
      v.srcObject = stream;
      return 'ready';
    },
    onLive: () => {
      liveCount += 1;
    },
    onError: (msg) => {
      errors.push(msg);
    },
  });

  // 首次打开因权限失败进入错误态（此时错误态里的系统相机/相册入口保留）
  await controller.start();
  assert.equal(openCalls, 1);
  assert.deepEqual(errors, ['没有相机权限']);
  assert.equal(liveCount, 0);

  // 若用户已选出图片（或正在拍照），切后台再回前台不再重开相机
  shouldResume = false;
  controller.handleVisibilityChange('hidden');
  controller.handleVisibilityChange('visible');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(openCalls, 1, '已选图时 visible 不应重开实时相机');

  // 若未选出图片（例如从系统设置授权返回，或从系统相机取消返回），visible 重新尝试打开并恢复
  shouldResume = true;
  controller.handleVisibilityChange('visible');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(openCalls, 2);
  assert.equal(liveCount, 1);
  assert.equal(video.srcObject, recoveredStream.stream);

  controller.dispose();
  assert.equal(recoveredStream.getStopCount(), 1);
});

void test('createCameraPreviewController 在 attachAndWaitForVideo 等待出帧期间切后台，仅释轨一次且不误报超时错误', async () => {
  const video = createMockVideo();
  const s1 = createTrackedStream();
  const s2 = createTrackedStream();
  let openCalls = 0;
  let resolveAttach1!: (status: 'ready' | 'needs-gesture' | 'timeout') => void;
  const errors: string[] = [];
  let liveCount = 0;

  const controller = createCameraPreviewController({
    getMediaDevices: () => null,
    getVideo: () => video,
    openStream: async () => {
      openCalls += 1;
      return { ok: true, stream: openCalls === 1 ? s1.stream : s2.stream };
    },
    attachVideo: async (v, stream) => {
      v.srcObject = stream;
      if (openCalls === 1) {
        return new Promise((resolve) => {
          resolveAttach1 = resolve;
        });
      }
      return 'ready';
    },
    onLive: () => {
      liveCount += 1;
    },
    onError: (msg) => {
      errors.push(msg);
    },
  });

  const firstStart = controller.start();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(video.srcObject, s1.stream);

  // 等待出帧期间切后台
  controller.handleVisibilityChange('hidden');
  assert.equal(s1.getStopCount(), 1);
  assert.equal(video.srcObject, null);

  // 旧的 attach 随后以 timeout 结束，不应误报错误，也不应重复 stop
  resolveAttach1('timeout');
  await firstStart;
  assert.equal(s1.getStopCount(), 1);
  assert.deepEqual(errors, []);

  // 回到前台恢复成功
  controller.handleVisibilityChange('visible');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(liveCount, 1);
  assert.equal(video.srcObject, s2.stream);

  controller.dispose();
  assert.equal(s2.getStopCount(), 1);
});

void test('SW install 不会自动 skipWaiting 抢占活跃会话，且已缓存壳在导航请求假死时按超时回退缓存', async () => {
  const harness = createStrictWebKitSwHarness({
    pageTimeoutMs: 25,
    hangNavigationFetch: true,
  });

  const installHandler = harness.listeners.get('install');
  assert.ok(installHandler, 'install listener must be registered');
  const installTasks: Promise<unknown>[] = [];
  installHandler({
    waitUntil(p: Promise<unknown>) {
      installTasks.push(Promise.resolve(p));
    },
  });
  await Promise.all(installTasks);
  assert.equal(
    harness.getSkipWaitingCount(),
    0,
    'install 阶段不应自动 skipWaiting，避免系统相机返回时触发整页强刷',
  );

  // 收到用户确认更新消息后才执行 skipWaiting
  const messageHandler = harness.listeners.get('message');
  assert.ok(messageHandler, 'message listener must be registered');
  messageHandler({ data: { type: 'skip-waiting' } });
  assert.equal(harness.getSkipWaitingCount(), 1);

  // 导航请求网络挂起时，应在 pageTimeoutMs 后回退到 install 预缓存的 INDEX
  const navRes = await harness.dispatchFetch(
    'https://example.github.io/kids-english-ai-agent/',
    'navigate',
  );
  assert.equal(navRes.response.status, 200);
  assert.equal(navRes.response.body, 'cached:/kids-english-ai-agent/');
});
