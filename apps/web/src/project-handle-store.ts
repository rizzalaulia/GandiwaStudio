const DATABASE_NAME = 'gandiwa-project-handles'
const DATABASE_VERSION = 1
const STORE_NAME = 'directories'
const ACTIVE_PROJECT_KEY = 'active-project'

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(new Error(request.error?.message ?? 'Unable to open local project storage.'))
  })
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(new Error(request.error?.message ?? 'Unable to access local project storage.'))
  })
}

async function inStore<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const database = await openDatabase()
  try {
    const transaction = database.transaction(STORE_NAME, mode)
    return await requestResult(operation(transaction.objectStore(STORE_NAME)))
  } finally {
    database.close()
  }
}

export async function rememberProjectDirectory(directory: unknown): Promise<void> {
  await inStore('readwrite', (store) => store.put(directory, ACTIVE_PROJECT_KEY))
}

export async function loadRememberedProjectDirectory<T>(): Promise<T | undefined> {
  return inStore<T | undefined>('readonly', (store) => store.get(ACTIVE_PROJECT_KEY) as IDBRequest<T | undefined>)
}

export async function forgetProjectDirectory(): Promise<void> {
  await inStore('readwrite', (store) => store.delete(ACTIVE_PROJECT_KEY))
}
