import { Readable } from 'node:stream';
import { Storage } from 'megajs';
import { ProviderError, type ProviderCredentialBundle, type DecryptedProviderAppConfig, type EnsureAppRootResult, type RemoteObjectRef, type UploadObjectStreamParams } from './types.js';

/**
 * MEGA file-object primitives (Step 4 / M8) — EXPERIMENTAL.
 *
 * Honest capability statement (from the approved plan):
 * - `megajs` is an UNOFFICIAL library and is not an official MEGA SDK. It is
 *   pinned and treated as a risk, not as a production-grade connector.
 * - Only the documented `Storage` email/password flow is used. No session
 *   serialisation is invented and no security setting is weakened.
 * - Uploads stream with backpressure and an explicitly known size. Whole-stream
 *   buffering is never enabled for chunk objects.
 * - Because streaming upload/download/recovery cannot be proven against a real
 *   account in this environment, the adapter advertises `upload: false` until a
 *   live smoke test passes. Routing therefore keeps MEGA out of upload placement
 *   while the other connectors keep working.
 * - Exactly one temporary `Storage` instance handles one operation, and it is
 *   always closed in a `finally` block. Credentials are never logged.
 */

/** Structural view of the parts of megajs Storage this adapter relies on. */
interface MegaStorageLike {
  user?: string;
  email?: string;
  root?: MegaFileLike;
  once(event: 'ready', listener: () => void): void;
  once(event: 'error', listener: (err: Error) => void): void;
  getAccountInfo(): Promise<unknown>;
  close(cb?: () => void): Promise<void>;
}

interface MegaUploadStreamLike {
  on(event: string, listener: (...args: unknown[]) => void): MegaUploadStreamLike;
  once(event: string, listener: (...args: unknown[]) => void): MegaUploadStreamLike;
  complete?: Promise<unknown>;
}

interface MegaFileLike {
  name?: string;
  nodeId?: string;
  size?: number;
  directory?: boolean;
  children?: MegaFileLike[];
  upload(options: Record<string, unknown>, source?: Readable): MegaUploadStreamLike;
  download(): Readable;
  delete(permanent?: boolean, cb?: (err?: Error) => void): Promise<unknown>;
  mkdir?(options: { name: string }): Promise<MegaFileLike>;
  find?(name: string): MegaFileLike | undefined;
}

const ROOT_FOLDER_NAME = 'CloudNest Data';
const OPERATION_TIMEOUT_MS = 30_000;

function isMegaBundle(b: ProviderCredentialBundle): b is Extract<ProviderCredentialBundle, { provider: 'mega' }> {
  return b.provider === 'mega';
}

/** Make a generated key safe to use as a MEGA node name. */
export function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_');
}

/** Map a megajs/transport failure to a normalized safe code (never leaks text). */
export function mapMegaError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  const message = (err instanceof Error ? err.message : String(err ?? '')).toLowerCase();
  // W-04: a bare 'invalid' matched unrelated failures ("invalid range", ...);
  // keep the credential-specific megajs strings only.
  if (message.includes('wrong password') || message.includes('eargs') || message.includes('bad email') || message.includes('invalid email or password')) {
    return new ProviderError('invalid_credentials', 401);
  }
  if (message.includes('two-factor') || message.includes('2fa') || message.includes('second factor') || message.includes('verification code')) {
    return new ProviderError('invalid_credentials', 401);
  }
  if (message.includes('eagain') || message.includes('rate') || message.includes('too many')) {
    return new ProviderError('provider_rate_limited', 429);
  }
  if (message.includes('enoent') || message.includes('not found') || message.includes('does not exist')) {
    return new ProviderError('provider_object_missing', 404);
  }
  if (message.includes('quota') || message.includes('storage') || message.includes('overflow')) {
    return new ProviderError('provider_no_space', 507);
  }
  if (message.includes('timeout') || message.includes('etimedout')) {
    return new ProviderError('provider_unavailable', 504);
  }
  return new ProviderError('provider_unavailable', 502);
}

function withTimeout<T>(promise: Promise<T>, ms = OPERATION_TIMEOUT_MS): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new ProviderError('provider_unavailable', 504)), ms)),
  ]);
}

/**
 * Run one operation against a single temporary Storage instance.
 * One login per operation; the instance is always closed.
 */
async function withTemporaryStorage<T>(
  bundle: Extract<ProviderCredentialBundle, { provider: 'mega' }>,
  fn: (storage: MegaStorageLike) => Promise<T>,
): Promise<T> {
  const storage = new Storage({
    email: bundle.email,
    password: bundle.password,
  } as unknown as ConstructorParameters<typeof Storage>[0]) as unknown as MegaStorageLike;
  try {
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        storage.once('ready', () => resolve());
        storage.once('error', (err) => reject(err));
      }),
    );
    return await withTimeout(fn(storage));
  } catch (err) {
    throw mapMegaError(err);
  } finally {
    // never leak a long-lived API connection
    try {
      void storage.close();
    } catch {
      // closing an already-failed instance may throw; the operation result stands
    }
  }
}

/** Find (or create) the CloudNest folder inside the account's own root. */
async function ensureAppRootImpl(
  bundle: ProviderCredentialBundle,
  _appConfig?: DecryptedProviderAppConfig,
): Promise<EnsureAppRootResult> {
  if (!isMegaBundle(bundle)) throw new ProviderError('identity_validation_failed', 400);
  return withTemporaryStorage(bundle, async (storage) => {
    const root = storage.root;
    if (!root) throw new ProviderError('provider_unavailable', 502);
    const existing = root.children?.find((child) => child.directory && child.name === ROOT_FOLDER_NAME);
    if (existing?.nodeId) return { remoteRootId: existing.nodeId, created: false };
    if (typeof root.mkdir !== 'function') {
      // creating a folder is required for the CloudNest namespace; without it
      // the connector cannot guarantee it never touches unrelated user files
      throw new ProviderError('unsupported_security_mode', 501);
    }
    const created = await root.mkdir({ name: ROOT_FOLDER_NAME });
    if (!created?.nodeId) throw new ProviderError('provider_unavailable', 502);
    return { remoteRootId: created.nodeId, created: true };
  });
}

function findFolder(root: MegaFileLike | undefined, folderId: string): MegaFileLike | null {
  if (!root) return null;
  const hit = root.children?.find((child) => child.directory && child.nodeId === folderId);
  return hit ?? null;
}

/**
 * Stream one logical chunk object into the CloudNest folder.
 * The exact size is always supplied so megajs never buffers the whole stream.
 */
async function uploadObjectStreamImpl(
  bundle: ProviderCredentialBundle,
  params: UploadObjectStreamParams,
  _appConfig?: DecryptedProviderAppConfig,
): Promise<RemoteObjectRef> {
  if (!isMegaBundle(bundle)) throw new ProviderError('identity_validation_failed', 400);
  const { rootId, objectKey, readable, sizeBytes } = params;
  if (sizeBytes <= 0) throw new ProviderError('provider_unavailable', 400);
  const name = safeSegment(objectKey);

  return withTemporaryStorage(bundle, async (storage) => {
    const folder = findFolder(storage.root, rootId);
    if (!folder) throw new ProviderError('provider_object_missing', 404);
    const upload = folder.upload(
      {
        name,
        // the documented known-size requirement; without it megajs would
        // buffer the stream, which the plan forbids for chunk objects
        size: sizeBytes,
        maxConnections: 1,
      },
      readable as Readable,
    );
    const nodeId = await withTimeout(
      new Promise<string>((resolve, reject) => {
        upload.once('complete', (...args: unknown[]) => {
          const file = args[0] as MegaFileLike | undefined;
          const id = file?.nodeId ?? (args[1] as string | undefined);
          resolve(id ?? '');
        });
        upload.once('error', (err: unknown) => reject(mapMegaError(err)));
      }),
    );
    if (!nodeId) throw new ProviderError('provider_unavailable', 502);
    return { remoteObjectId: nodeId, objectKey, sizeBytes };
  });
}

/** List only the CloudNest folder's files (folders are not objects). */
async function listAppObjectsImpl(
  bundle: ProviderCredentialBundle,
  rootId: string,
  _appConfig?: DecryptedProviderAppConfig,
): Promise<RemoteObjectRef[]> {
  if (!isMegaBundle(bundle)) throw new ProviderError('identity_validation_failed', 400);
  return withTemporaryStorage(bundle, async (storage) => {
    const folder = findFolder(storage.root, rootId);
    if (!folder) throw new ProviderError('provider_object_missing', 404);
    return (folder.children ?? [])
      .filter((child) => !child.directory && child.nodeId && child.name)
      .map((child) => ({
        remoteObjectId: child.nodeId as string,
        objectKey: child.name as string,
        sizeBytes: typeof child.size === 'number' ? child.size : 0,
      }));
  });
}

async function findAppObjectByKeyImpl(
  bundle: ProviderCredentialBundle,
  rootId: string,
  objectKey: string,
  _appConfig?: DecryptedProviderAppConfig,
): Promise<RemoteObjectRef | null> {
  if (!isMegaBundle(bundle)) throw new ProviderError('identity_validation_failed', 400);
  const wanted = safeSegment(objectKey);
  return withTemporaryStorage(bundle, async (storage) => {
    const folder = findFolder(storage.root, rootId);
    if (!folder) return null;
    const hit = (folder.children ?? []).find((child) => !child.directory && child.name === wanted);
    if (!hit?.nodeId) return null;
    return { remoteObjectId: hit.nodeId, objectKey, sizeBytes: typeof hit.size === 'number' ? hit.size : 0 };
  });
}

async function deleteAppObjectImpl(
  bundle: ProviderCredentialBundle,
  rootId: string,
  remoteObjectId: string,
  _appConfig?: DecryptedProviderAppConfig,
): Promise<{ deleted: boolean; safeErrorCode?: never }> {
  if (!isMegaBundle(bundle)) throw new ProviderError('identity_validation_failed', 400);
  return withTemporaryStorage(bundle, async (storage) => {
    const folder = findFolder(storage.root, rootId);
    if (!folder) return { deleted: true }; // nothing to clean
    const target = (folder.children ?? []).find((child) => !child.directory && child.nodeId === remoteObjectId);
    if (!target) return { deleted: true }; // already gone is a successful cleanup
    await withTimeout(Promise.resolve(target.delete(false)));
    return { deleted: true };
  });
}

/**
 * The documented contract is "one temporary Storage per operation, and it is
 * always closed" — but a download stream outlives the call that created it,
 * so the close rides the stream's own lifecycle: the first of end/close/error
 * closes the Storage exactly once, and cleanup never masks the stream outcome.
 */
export function closeStorageWhenStreamEnds(stream: NodeJS.ReadableStream, close: () => void): void {
  let closed = false;
  const once = (): void => {
    if (closed) return;
    closed = true;
    try {
      close();
    } catch {
      // ignore — cleanup must never mask the stream's own outcome
    }
  };
  stream.on('end', once);
  stream.on('close', once);
  stream.on('error', once);
}

async function downloadObjectStreamImpl(
  bundle: ProviderCredentialBundle,
  remoteObjectId: string,
  _appConfig?: DecryptedProviderAppConfig,
): Promise<{ stream: NodeJS.ReadableStream; sizeBytes: number | null; contentType: string | null }> {
  if (!isMegaBundle(bundle)) throw new ProviderError('identity_validation_failed', 400);
  // NOTE: a ranged read is not advertised for MEGA; the plan requires proof
  // before claiming it, so callers must request whole objects only.
  const storage = new Storage({
    email: bundle.email,
    password: bundle.password,
  } as unknown as ConstructorParameters<typeof Storage>[0]) as unknown as MegaStorageLike;
  try {
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        storage.once('ready', () => resolve());
        storage.once('error', (err) => reject(err));
      }),
    );
    const root = storage.root;
    const found = findNodeById(root, remoteObjectId);
    if (!found) throw new ProviderError('provider_object_missing', 404);
    const stream = found.download();
    // the close rides the stream's own lifecycle (see closeStorageWhenStreamEnds)
    closeStorageWhenStreamEnds(stream, () => {
      void storage.close();
    });
    return { stream, sizeBytes: typeof found.size === 'number' ? found.size : null, contentType: null };
  } catch (err) {
    try {
      void storage.close();
    } catch {
      // ignore
    }
    throw mapMegaError(err);
  }
}

function findNodeById(node: MegaFileLike | undefined, nodeId: string): MegaFileLike | null {
  if (!node) return null;
  if (node.nodeId === nodeId && !node.directory) return node;
  for (const child of node.children ?? []) {
    if (child.nodeId === nodeId && !child.directory) return child;
    const nested = findNodeById(child, nodeId);
    if (nested) return nested;
  }
  return null;
}

export {
  withTemporaryStorage,
  ensureAppRootImpl,
  uploadObjectStreamImpl,
  findAppObjectByKeyImpl,
  listAppObjectsImpl,
  deleteAppObjectImpl,
  downloadObjectStreamImpl,
  ROOT_FOLDER_NAME,
};
