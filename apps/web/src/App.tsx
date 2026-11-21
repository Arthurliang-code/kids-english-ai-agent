import { useEffect, useState } from 'react';
import { OcrLab } from './features/ocr-lab/OcrLab';
import { listenForAppUpdate } from './pwa/register';
import { warmVoices } from './speech/speak';

export function App() {
  const [applyUpdate, setApplyUpdate] = useState<(() => void) | null>(null);

  useEffect(() => {
    warmVoices();
    listenForAppUpdate((apply) => setApplyUpdate(() => apply));
  }, []);

  return <OcrLab onApplyUpdate={applyUpdate} />;
}
