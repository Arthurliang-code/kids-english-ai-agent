/** 生产环境注册服务工作者。每次回到前台都检查新版本，有旧页面在时才整页换成新的。 */
export function listenForAppUpdate(onReady: (apply: () => void) => void): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;

  const hadController = Boolean(navigator.serviceWorker.controller);
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloaded) return;
    reloaded = true;
    window.location.reload();
  });

  void navigator.serviceWorker
    .register(`${import.meta.env.BASE_URL}sw.js`, { updateViaCache: 'none' })
    .then((registration) => {
      const check = () => {
        void registration.update();
      };
      check();
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') check();
      });
      window.addEventListener('pageshow', check);

      if (registration.waiting && hadController) {
        onReady(() => registration.waiting?.postMessage({ type: 'skip-waiting' }));
      }
    });
}
