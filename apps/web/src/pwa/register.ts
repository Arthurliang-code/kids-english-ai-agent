/**
 * 生产环境注册服务工作者。
 * - 切回前台时静默检查新版本，若发现新版本进入 waiting，只弹出顶部提示条，绝不自动刷新正在拍照/点读的页面；
 * - 仅在用户主动点击「点一下更新」后才发送 `skip-waiting` 并在 `controllerchange` 时整页刷新。
 */
export function listenForAppUpdate(onReady: (apply: () => void) => void): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;

  const hadController = Boolean(navigator.serviceWorker.controller);
  let userRequestedReload = false;
  let reloaded = false;
  const reloadOnce = () => {
    if (reloaded) return;
    reloaded = true;
    window.location.reload();
  };

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (userRequestedReload) {
      reloadOnce();
      return;
    }
    if (hadController) {
      onReady(() => reloadOnce());
    }
  });

  void navigator.serviceWorker
    .register(`${import.meta.env.BASE_URL}sw.js`, { updateViaCache: 'none' })
    .then((registration) => {
      const exposeUpdate = () => {
        if (!registration.waiting) return;
        onReady(() => {
          userRequestedReload = true;
          if (registration.waiting) {
            registration.waiting.postMessage({ type: 'skip-waiting' });
            window.setTimeout(reloadOnce, 1500);
          } else {
            reloadOnce();
          }
        });
      };

      const watchInstalling = (worker: ServiceWorker | null) => {
        if (!worker) return;
        worker.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) {
            exposeUpdate();
          }
        });
      };

      if (registration.waiting && navigator.serviceWorker.controller) {
        exposeUpdate();
      }
      if (registration.installing) {
        watchInstalling(registration.installing);
      }
      registration.addEventListener('updatefound', () => {
        watchInstalling(registration.installing);
      });

      const check = () => {
        void registration.update().catch(() => undefined);
      };
      check();
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') check();
      });
      window.addEventListener('pageshow', check);
    })
    .catch(() => undefined);
}
