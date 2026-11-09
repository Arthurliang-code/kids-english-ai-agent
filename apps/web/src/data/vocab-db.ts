import { parseVocabExport, type ReviewItem, type VocabFile } from '../domain/review';

const DB_NAME = 'kea';
const DB_VERSION = 1;
const WORDS = 'words';
const TAKES = 'takes';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(WORDS)) db.createObjectStore(WORDS, { keyPath: 'word' });
      if (!db.objectStoreNames.contains(TAKES)) db.createObjectStore(TAKES);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function listItems(): Promise<ReviewItem[]> {
  const db = await openDb();
  const items = await requestToPromise(db.transaction(WORDS).objectStore(WORDS).getAll());
  db.close();
  return items as ReviewItem[];
}

export async function getItem(word: string): Promise<ReviewItem | null> {
  const db = await openDb();
  const item = await requestToPromise(
    db.transaction(WORDS).objectStore(WORDS).get(word.toLowerCase()),
  );
  db.close();
  return (item as ReviewItem | undefined) ?? null;
}

export async function putItem(item: ReviewItem): Promise<void> {
  const db = await openDb();
  await requestToPromise(db.transaction(WORDS, 'readwrite').objectStore(WORDS).put(item));
  db.close();
}

export async function replaceItems(items: ReviewItem[]): Promise<void> {
  const db = await openDb();
  const store = db.transaction(WORDS, 'readwrite').objectStore(WORDS);
  store.clear();
  for (const item of items) store.put(item);
  await new Promise<void>((resolve, reject) => {
    store.transaction.oncomplete = () => resolve();
    store.transaction.onerror = () => reject(store.transaction.error);
  });
  db.close();
}

export function toVocabFile(items: ReviewItem[]): VocabFile {
  return { version: 1, items };
}

export async function importVocabFile(value: unknown): Promise<ReviewItem[] | null> {
  const items = parseVocabExport(value);
  if (!items) return null;
  await replaceItems(items);
  return items;
}

export async function putTake(word: string, blob: Blob): Promise<void> {
  const db = await openDb();
  await requestToPromise(
    db.transaction(TAKES, 'readwrite').objectStore(TAKES).put(blob, word.toLowerCase()),
  );
  db.close();
}

export async function getTake(word: string): Promise<Blob | null> {
  const db = await openDb();
  const blob = await requestToPromise(
    db.transaction(TAKES).objectStore(TAKES).get(word.toLowerCase()),
  );
  db.close();
  return blob instanceof Blob ? blob : null;
}
