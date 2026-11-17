import { useEffect, useState } from 'react';
import { getParentApiKey, setParentApiKey, testParentApiKey } from '../../content/translate';
import { importVocabFile, listItems, putItem, toVocabFile } from '../../data/vocab-db';
import { dueItems, grade, todayISO, type ReviewItem } from '../../domain/review';
import { speakEnglish } from '../../speech/speak';
import { WordCard } from '../ocr-lab/WordCard';

export function ReviewPanel() {
  const [queue, setQueue] = useState<ReviewItem[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState(() => getParentApiKey());
  const [showKey, setShowKey] = useState(false);
  const [testingKey, setTestingKey] = useState(false);
  const [keyStatus, setKeyStatus] = useState<{ ok: boolean; text: string } | null>(null);

  const reload = async () => {
    const items = await listItems();
    setQueue(dueItems(items, todayISO()));
  };

  useEffect(() => {
    void reload();
  }, []);

  const current = queue?.[0] ?? null;

  const mark = async (correct: boolean) => {
    if (!current) return;
    if (!correct) speakEnglish(current.word);
    const next = grade(current, correct, todayISO());
    await putItem(next);
    setQueue((items) => {
      if (!items) return items;
      const rest = items.slice(1);
      return next.due <= todayISO() ? [next, ...rest] : rest;
    });
  };

  const exportFile = async () => {
    const file = toVocabFile(await listItems());
    const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'vocab.json';
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const importFile = async (file: File) => {
    try {
      const parsed: unknown = JSON.parse(await file.text());
      const items = await importVocabFile(parsed);
      if (!items) {
        setNote('这份文件不是生词本。');
        return;
      }
      setNote(null);
      await reload();
    } catch {
      setNote('这份文件读不出来。');
    }
  };

  const handleSaveKey = (event: React.FormEvent) => {
    event.preventDefault();
    setParentApiKey(apiKeyInput);
    setKeyStatus({
      ok: true,
      text: apiKeyInput.trim()
        ? '✅ 已保存在本机，建议点右侧「验证测试」确认连通。'
        : '已清除本机翻译密钥，仅使用离线句型与词典。',
    });
  };

  const handleTestKey = async () => {
    setParentApiKey(apiKeyInput);
    setTestingKey(true);
    setKeyStatus({ ok: true, text: '正在测试 DeepSeek 接口连通性…' });
    const res = await testParentApiKey(apiKeyInput);
    setTestingKey(false);
    setKeyStatus({ ok: res.ok, text: res.message });
  };

  return (
    <section className="review">
      <div className="card review-card">
        {queue === null ? (
          <p className="empty-hint">正在打开生词本…</p>
        ) : current ? (
          <>
            <p className="review-count">今天还有 {queue.length} 个</p>
            <WordCard
              text={current.word}
              trusted
              mode="review"
              savedContextSentence={current.contextSentence}
              savedContextTranslation={current.contextTranslation}
            />
            <div className="word-card-actions">
              <button className="kid-listen" type="button" onClick={() => void mark(true)}>
                会了
              </button>
              <button type="button" onClick={() => void mark(false)}>
                再听一遍
              </button>
            </div>
          </>
        ) : (
          <p className="kid-hello">今天的词都复习完了</p>
        )}
        {note ? <p className="footnote">{note}</p> : null}
      </div>
      <details className="parent-tools">
        <summary>爸爸妈妈（备份与本机翻译设置）</summary>
        <div className="parent-tools-body">
          <div className="word-card-actions">
            <button type="button" onClick={() => void exportFile()}>
              导出单词本
            </button>
            <label className="kid-album">
              导回单词本
              <input
                type="file"
                accept="application/json"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = '';
                  if (file) void importFile(file);
                }}
              />
            </label>
          </div>

          <form className="parent-key-form" onSubmit={handleSaveKey}>
            <label htmlFor="deepseek-api-key" className="parent-key-label">
              本机整句 AI 翻译密钥（DeepSeek API Key）
            </label>
            <p id="deepseek-key-hint" className="footnote">
              密钥只保存在当前打开方式的浏览器本地（注意：Safari 网页版与桌面 PWA 图标存储空间相互独立）。
            </p>
            <div className="parent-key-row">
              <input
                id="deepseek-api-key"
                name="deepseek_api_key"
                type={showKey ? 'text' : 'password'}
                value={apiKeyInput}
                onChange={(e) => {
                  setApiKeyInput(e.target.value);
                  if (keyStatus) setKeyStatus(null);
                }}
                aria-describedby="deepseek-key-hint"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                placeholder="sk-..."
                className="parent-key-input"
              />
              <button
                type="button"
                aria-pressed={showKey}
                onClick={() => setShowKey((prev) => !prev)}
                className="parent-key-toggle"
              >
                {showKey ? '隐藏' : '显示'}
              </button>
            </div>
            <div className="parent-key-actions">
              <button type="submit" className="primary">
                保存在本机
              </button>
              <button
                type="button"
                disabled={testingKey || !apiKeyInput.trim()}
                onClick={() => void handleTestKey()}
              >
                {testingKey ? '测试中…' : '验证测试'}
              </button>
              {apiKeyInput.trim() ? (
                <button
                  type="button"
                  onClick={() => {
                    setApiKeyInput('');
                    setParentApiKey('');
                    setKeyStatus({ ok: true, text: '已清除本机翻译密钥。' });
                  }}
                >
                  清除密钥
                </button>
              ) : null}
            </div>
            {keyStatus ? (
              <p
                className={`footnote parent-key-status${keyStatus.ok ? '' : ' is-error'}`}
                role="status"
                aria-live="polite"
              >
                {keyStatus.text}
              </p>
            ) : null}
          </form>
        </div>
      </details>
    </section>
  );
}
