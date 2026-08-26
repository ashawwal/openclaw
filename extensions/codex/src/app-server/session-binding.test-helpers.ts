/** In-memory binding store helpers for Codex app-server tests. */
export * from "./session-binding.js";
import type {
  PluginBlobStore,
  PluginStateSyncKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { resolveCodexSupervisionAppServerRuntimeOptions } from "./config.js";
import { buildCodexAppServerConnectionFingerprint } from "./plugin-app-cache-key.js";
import {
  bindingStoreKey,
  createCodexAppServerBindingStore,
  encodeCodexAppServerBindingRecord,
  type CodexAppServerBindingStore,
  type CodexAppServerBindingRecordMetadata,
  type CodexAppServerThreadBinding,
  type StoredCodexAppServerBinding,
} from "./session-binding.js";

export function createCodexTestBindingRecordStore(observer?: {
  set?: (key: string, metadata: CodexAppServerBindingRecordMetadata) => void;
  delete?: (key: string) => void;
}): PluginBlobStore<CodexAppServerBindingRecordMetadata> & {
  lookupSync(key: string):
    | {
        key: string;
        bytes: Uint8Array;
        metadata: CodexAppServerBindingRecordMetadata;
        sizeBytes: number;
        createdAt: number;
      }
    | undefined;
} {
  const values = new Map<
    string,
    { bytes: Uint8Array; metadata: CodexAppServerBindingRecordMetadata; createdAt: number }
  >();
  const lookup = async (key: string) => {
    const entry = values.get(key);
    return entry
      ? {
          key,
          bytes: Uint8Array.from(entry.bytes),
          metadata: structuredClone(entry.metadata),
          sizeBytes: entry.bytes.byteLength,
          createdAt: entry.createdAt,
        }
      : undefined;
  };
  return {
    lookupSync(key) {
      const entry = values.get(key);
      return entry
        ? {
            key,
            bytes: Uint8Array.from(entry.bytes),
            metadata: structuredClone(entry.metadata),
            sizeBytes: entry.bytes.byteLength,
            createdAt: entry.createdAt,
          }
        : undefined;
    },
    async register(key, bytes, metadata) {
      values.set(key, {
        bytes: Uint8Array.from(bytes),
        metadata: structuredClone(metadata),
        createdAt: Date.now(),
      });
      observer?.set?.(key, metadata);
    },
    async registerIfAbsent(key, bytes, metadata) {
      if (values.has(key)) {
        return false;
      }
      values.set(key, {
        bytes: Uint8Array.from(bytes),
        metadata: structuredClone(metadata),
        createdAt: Date.now(),
      });
      observer?.set?.(key, metadata);
      return true;
    },
    async mutate(key, update) {
      const current = values.get(key);
      const next = update(
        current
          ? {
              key,
              bytes: Uint8Array.from(current.bytes),
              metadata: structuredClone(current.metadata),
              sizeBytes: current.bytes.byteLength,
              createdAt: current.createdAt,
            }
          : undefined,
      );
      if (!next) {
        return false;
      }
      if (next.kind === "delete") {
        observer?.delete?.(key);
        return values.delete(key);
      }
      values.set(key, {
        bytes: Uint8Array.from(next.bytes),
        metadata: structuredClone(next.metadata),
        createdAt: Date.now(),
      });
      observer?.set?.(key, next.metadata);
      return true;
    },
    lookup,
    async entries() {
      return [...values].map(([key, entry]) => ({
        key,
        metadata: structuredClone(entry.metadata),
        sizeBytes: entry.bytes.byteLength,
        createdAt: entry.createdAt,
      }));
    },
    async delete(key) {
      observer?.delete?.(key);
      return values.delete(key);
    },
    async deleteExpiredKey() {
      return undefined;
    },
    async deleteExpired() {
      return [];
    },
    async clear() {
      values.clear();
    },
  };
}

export function createCodexTestBindingStateStore(): PluginStateSyncKeyedStore<StoredCodexAppServerBinding> {
  const values = new Map<string, StoredCodexAppServerBinding>();
  return {
    register(key, value) {
      values.set(key, value);
    },
    registerIfAbsent(key, value) {
      if (values.has(key)) {
        return false;
      }
      values.set(key, value);
      return true;
    },
    update(key, updateValue) {
      const next = updateValue(values.get(key));
      if (next === undefined) {
        return false;
      }
      values.set(key, next);
      return true;
    },
    lookup: (key) => values.get(key),
    consume(key) {
      const value = values.get(key);
      values.delete(key);
      return value;
    },
    delete: (key) => values.delete(key),
    entries: () => [...values].map(([key, value]) => ({ key, value, createdAt: 0 })),
    clear: () => values.clear(),
  };
}

export function createCodexTestBindingStore(): CodexAppServerBindingStore {
  return createCodexAppServerBindingStore(createCodexTestBindingRecordStore());
}

export function buildCodexSupervisionTestConnectionFingerprint(
  pluginConfig: unknown = { supervision: { enabled: true } },
): string {
  return buildCodexAppServerConnectionFingerprint(
    resolveCodexSupervisionAppServerRuntimeOptions({
      pluginConfig,
      env: {},
      requirementsToml: null,
    }),
  );
}

const sharedRecordStore = createCodexTestBindingRecordStore();
export const testCodexAppServerBindingStore = createCodexAppServerBindingStore(sharedRecordStore);
const testSessionIdentities = new Map<
  string,
  { agentId: string; sessionId: string; sessionKey?: string }
>();

export function resetCodexTestBindingStore(): void {
  void sharedRecordStore.clear();
  testSessionIdentities.clear();
}

export function registerCodexTestSessionIdentity(
  locator: string,
  sessionId: string,
  sessionKey?: string,
  agentId = "main",
): void {
  const previousKey = bindingStoreKey(testIdentity(locator));
  testSessionIdentities.set(locator, {
    agentId,
    sessionId,
    ...(sessionKey ? { sessionKey } : {}),
  });
  const nextKey = bindingStoreKey(testIdentity(locator));
  if (previousKey !== nextKey) {
    const value = sharedRecordStore.lookupSync(previousKey);
    if (value) {
      void sharedRecordStore.register(nextKey, value.bytes, {
        ...value.metadata,
        stored: { ...value.metadata.stored, sessionId },
      });
      void sharedRecordStore.delete(previousKey);
    }
  }
}

export function seedCodexTestBinding(locator: string, binding: CodexAppServerThreadBinding): void {
  const encoded = encodeCodexAppServerBindingRecord({
    stored: {
      version: 1,
      state: "active",
      binding,
    },
  });
  void sharedRecordStore.register(
    bindingStoreKey(testIdentity(locator)),
    encoded.bytes,
    encoded.metadata,
  );
}

function testIdentity(locator: string) {
  const identity = testSessionIdentities.get(locator);
  return {
    kind: "session" as const,
    agentId: identity?.agentId ?? "main",
    sessionId: identity?.sessionId ?? locator,
    ...(identity?.sessionKey ? { sessionKey: identity.sessionKey } : {}),
  };
}

export async function readCodexAppServerBinding(
  sessionId: string,
  _lookup?: unknown,
): Promise<CodexAppServerThreadBinding | undefined> {
  return await testCodexAppServerBindingStore.read(testIdentity(sessionId));
}

export async function writeCodexAppServerBinding(
  sessionId: string,
  binding: CodexAppServerThreadBinding,
  _lookup?: unknown,
): Promise<void> {
  await testCodexAppServerBindingStore.mutate(testIdentity(sessionId), { kind: "set", binding });
}

export async function clearCodexAppServerBindingForThread(
  sessionId: string,
  threadId: string,
): Promise<boolean> {
  return await testCodexAppServerBindingStore.mutate(testIdentity(sessionId), {
    kind: "clear",
    threadId,
  });
}
