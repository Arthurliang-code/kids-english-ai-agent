import { useEffect, useState } from 'react';
import { loadZhDict } from './content/zh-dict';
import { OcrLab } from './features/ocr-lab/OcrLab';
import { listenForAppUpdate } from './pwa/register';
import { warmVoices } from './speech/speak';

export function App() {
  const [applyUpdate, setApplyUpdate] = useState<(() => void) | null>(null);

  useEffect(() => {
    warmVoices();
    void loadZhDict();
    listenForAppUpdate((apply) => setApplyUpdate(() => apply));
  }, []);

  return <OcrLab onApplyUpdate={applyUpdate} />;
}
