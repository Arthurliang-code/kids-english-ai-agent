/** 生产环境注册服务工作者。已有旧版本在控制页面时，才提示更新。 */
export function listenForAppUpdate(onReady: (apply: () => void) => void): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;

  let announced = false;
  const announce = (worker: ServiceWorker) => {
    if (announced || !navigator.serviceWorker.controller) return;
    announced = true;
    onReady(() => {
      let reloaded = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (reloaded) return;
        reloaded = true;
        window.location.reload();
      });
      worker.postMessage({ type: 'skip-waiting' });
    });
  };

  void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).then((registration) => {
    if (registration.waiting) announce(registration.waiting);
    registration.addEventListener('updatefound', () => {
      const installing = registration.installing;
      if (!installing) return;
      installing.addEventListener('statechange', () => {
        if (installing.state === 'installed') announce(installing);
      });
    });
  });
}
