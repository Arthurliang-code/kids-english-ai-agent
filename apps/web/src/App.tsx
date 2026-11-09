import { useEffect, useState } from 'react';
import { OcrLab } from './features/ocr-lab/OcrLab';
import { listenForAppUpdate } from './pwa/register';
export function App() {
  const [applyUpdate, setApplyUpdate] = useState<(() => void) | null>(null);

  useEffect(() => {
    listenForAppUpdate((apply) => setApplyUpdate(() => apply));
  }, []);

  return <OcrLab onApplyUpdate={applyUpdate} />;
}
