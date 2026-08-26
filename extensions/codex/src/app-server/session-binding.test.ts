// Codex tests cover the SQLite-backed thread binding facade.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createPluginBlobStoreForTests,
  resetPluginBlobStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bindingStoreKey,
  CodexAppServerInstructionSnapshotError,
  createCodexAppServerBindingStore,
  createStoredCodexAppServerBinding,
  encodeCodexAppServerBindingRecord,
  hashCodexAppServerBindingFingerprint,
  readCodexAppServerThreadBinding,
  reclaimCurrentCodexSessionGeneration,
  type CodexAppServerBindingRecordMetadata,
  type StoredCodexAppServerBinding,
} from "./session-binding.js";
import { createCodexTestBindingRecordStore } from "./session-binding.test-helpers.js";
import { useAutoCleanupTempDirTracker } from "./test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function createStateStore() {
  const recordValues = new Map<string, StoredCodexAppServerBinding>();
  const records = createCodexTestBindingRecordStore({
    set: (key, metadata) => recordValues.set(key, metadata.stored),
    delete: (key) => {
      recordValues.delete(key);
    },
  });
  return { records, recordValues };
}

async function seedStoredBinding(
  records: ReturnType<typeof createCodexTestBindingRecordStore>,
  key: string,
  stored: StoredCodexAppServerBinding,
): Promise<void> {
  const encoded = encodeCodexAppServerBindingRecord({ stored });
  await records.register(key, encoded.bytes, encoded.metadata);
}

afterEach(() => {
  vi.useRealTimers();
  resetPluginBlobStoreForTests();
  resetPluginStateStoreForTests();
});

describe("Codex app-server binding store", () => {
  it("normalizes the retired approval policy in persisted bindings", () => {
    expect(
      readCodexAppServerThreadBinding({
        threadId: "thread-legacy-policy",
        cwd: "/repo",
        approvalPolicy: "on-failure",
        sandbox: "workspace-write",
      }),
    ).toMatchObject({
      threadId: "thread-legacy-policy",
      cwd: "/repo",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });
  });

  it("preserves the effective managed approval policy in persisted thread bindings", () => {
    expect(
      readCodexAppServerThreadBinding({
        threadId: "thread-untrusted-policy",
        cwd: "/repo",
        approvalPolicy: "untrusted",
        sandbox: "workspace-write",
      }),
    ).toEqual({
      threadId: "thread-untrusted-policy",
      cwd: "/repo",
      approvalPolicy: "untrusted",
      sandbox: "workspace-write",
    });
  });

  it("stores domain data under the canonical session identity", async () => {
    const { records, recordValues } = createStateStore();
    const store = createCodexAppServerBindingStore(records);
    const identity = { kind: "session" as const, agentId: "main", sessionId: "session-1" };

    await store.mutate(identity, {
      kind: "set",
      binding: { threadId: "thread-1", cwd: "/repo", model: "gpt-5.4-codex" },
    });

    const binding = await store.read(identity);
    expect(binding).toMatchObject({ threadId: "thread-1", cwd: "/repo" });
    expect(binding).not.toHaveProperty("sessionFile");
    expect(binding).not.toHaveProperty("schemaVersion");
    expect(recordValues.get("session:main:session-1")).toMatchObject({
      version: 1,
      state: "active",
      binding: { threadId: "thread-1" },
    });
  });

  it("replaces only the exact ordinary thread owner", async () => {
    const { records } = createStateStore();
    const store = createCodexAppServerBindingStore(records);
    const identity = { kind: "session" as const, agentId: "main", sessionId: "session-cas" };
    await store.mutate(identity, {
      kind: "set",
      binding: { threadId: "thread-old", cwd: "/repo" },
    });

    await expect(
      store.mutate(identity, {
        kind: "replace-thread",
        expectedThreadId: "thread-stale",
        binding: { threadId: "thread-new", cwd: "/repo" },
      }),
    ).resolves.toBe(false);
    await expect(store.read(identity)).resolves.toMatchObject({ threadId: "thread-old" });

    await expect(
      store.mutate(identity, {
        kind: "replace-thread",
        expectedThreadId: "thread-old",
        binding: { threadId: "thread-new", cwd: "/repo" },
      }),
    ).resolves.toBe(true);
    await expect(store.read(identity)).resolves.toMatchObject({ threadId: "thread-new" });
  });

  it("rejects same-thread and supervision ownership through replacement CAS", async () => {
    const { records } = createStateStore();
    const store = createCodexAppServerBindingStore(records);
    const identity = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-cas-boundary",
    };
    await store.mutate(identity, {
      kind: "set",
      binding: { threadId: "thread-old", cwd: "/repo" },
    });

    await expect(
      store.mutate(identity, {
        kind: "replace-thread",
        expectedThreadId: "thread-old",
        binding: { threadId: "thread-old", cwd: "/repo" },
      }),
    ).resolves.toBe(false);
    await expect(
      store.mutate(identity, {
        kind: "replace-thread",
        expectedThreadId: "thread-old",
        binding: {
          threadId: "thread-private",
          cwd: "/repo",
          connectionScope: "supervision",
          supervisionSourceThreadId: "thread-private",
          preserveNativeModel: true,
        },
      }),
    ).resolves.toBe(false);
    await expect(store.read(identity)).resolves.toMatchObject({ threadId: "thread-old" });
  });

  it("does not report the exact session or conversation binding owner as another owner", async () => {
    const { records } = createStateStore();
    const store = createCodexAppServerBindingStore(records);
    const sessionIdentity = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-current",
    };
    await store.mutate(sessionIdentity, {
      kind: "set",
      binding: { threadId: "thread-session", cwd: "/repo" },
    });

    await expect(store.hasOtherThreadOwner("thread-session", sessionIdentity)).resolves.toBe(false);

    const conversationIdentity = { kind: "conversation" as const, bindingId: "conversation-1" };
    await store.mutate(conversationIdentity, {
      kind: "set",
      binding: { threadId: "thread-conversation", cwd: "/repo" },
    });
    await expect(
      store.hasOtherThreadOwner("thread-conversation", conversationIdentity),
    ).resolves.toBe(false);
  });

  it("reports a different valid active binding owner", async () => {
    const { records } = createStateStore();
    const store = createCodexAppServerBindingStore(records);
    const currentIdentity = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-current",
    };
    await store.mutate(
      { kind: "conversation", bindingId: "conversation-owner" },
      {
        kind: "set",
        binding: { threadId: "thread-owned", cwd: "/repo" },
      },
    );

    await expect(store.hasOtherThreadOwner("thread-owned", currentIdentity)).resolves.toBe(true);
  });

  it.each([
    { name: "a different generation", storedSessionId: "session-previous" },
    { name: "a missing generation", storedSessionId: undefined },
  ])("treats $name under the same stable key as another owner", async ({ storedSessionId }) => {
    const { records } = createStateStore();
    const store = createCodexAppServerBindingStore(records);
    const currentIdentity = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-current",
      sessionKey: "agent:main:stable",
    };
    await seedStoredBinding(records, bindingStoreKey(currentIdentity), {
      version: 1,
      state: "active",
      binding: { threadId: "thread-stale-generation", cwd: "/repo" },
      ...(storedSessionId ? { sessionId: storedSessionId } : {}),
    });

    await expect(
      store.hasOtherThreadOwner("thread-stale-generation", currentIdentity),
    ).resolves.toBe(true);
  });

  it("fails closed on a malformed row during reverse ownership scans", async () => {
    const { records } = createStateStore();
    const store = createCodexAppServerBindingStore(records);
    const currentIdentity = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-current",
    };
    await records.register("conversation:invalid", new Uint8Array(), {
      version: 1,
      revision: "00000000-0000-4000-8000-000000000000",
      stored: {
        version: 1,
        state: "active",
        binding: { threadId: "", cwd: "/repo" },
      },
    } as never);

    await expect(store.hasOtherThreadOwner("thread-unowned", currentIdentity)).rejects.toThrow(
      "Invalid Codex app-server binding record metadata: conversation:invalid",
    );
  });

  it("ignores stale cleared rows during reverse ownership scans", async () => {
    const { records } = createStateStore();
    const store = createCodexAppServerBindingStore(records);
    const currentIdentity = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-current",
    };
    await seedStoredBinding(records, "conversation:cleared", {
      version: 1,
      state: "cleared",
      retired: true,
    });

    await expect(store.hasOtherThreadOwner("thread-unowned", currentIdentity)).resolves.toBe(false);
  });

  it("fails closed on malformed pending supervision state", async () => {
    expect(
      readCodexAppServerThreadBinding({
        threadId: "thread-source",
        cwd: "/repo",
        preserveNativeModel: true,
        pendingSupervisionBranch: {
          sourceThreadId: "thread-source",
          cleanupThreadIds: ["thread-probe", "thread-probe"],
        },
      }),
    ).toBeUndefined();
    expect(
      readCodexAppServerThreadBinding({
        threadId: "thread-other",
        cwd: "/repo",
        preserveNativeModel: true,
        pendingSupervisionBranch: { sourceThreadId: "thread-source" },
      }),
    ).toBeUndefined();
    expect(
      readCodexAppServerThreadBinding({
        threadId: "thread-source",
        cwd: "/repo",
        pendingSupervisionBranch: { sourceThreadId: "thread-source", unknown: true },
      }),
    ).toBeUndefined();

    const { records } = createStateStore();
    const store = createCodexAppServerBindingStore(records);
    const identity = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-corrupt",
    };
    await records.register(bindingStoreKey(identity), new Uint8Array(), {
      version: 1,
      revision: "00000000-0000-4000-8000-000000000000",
      stored: {
        version: 1,
        state: "active",
        binding: {
          threadId: "thread-source",
          cwd: "/repo",
          preserveNativeModel: true,
          pendingSupervisionBranch: {
            sourceThreadId: "thread-source",
            cleanupThreadIds: ["thread-source"],
          },
        },
      },
    } as never);

    await expect(store.read(identity)).rejects.toThrow(
      "Invalid Codex app-server binding record metadata",
    );
  });

  it("fails closed on malformed private supervision ownership", () => {
    const valid = {
      threadId: "thread-source",
      cwd: "/repo",
      connectionScope: "supervision",
      supervisionSourceThreadId: "thread-source",
      preserveNativeModel: true,
      conversationSourceTransferComplete: true,
      pendingSupervisionBranch: { sourceThreadId: "thread-source" },
    };

    expect(readCodexAppServerThreadBinding({ ...valid, connectionScope: "user" })).toBeUndefined();
    expect(readCodexAppServerThreadBinding({ ...valid, connectionScope: {} })).toBeUndefined();
    expect(
      readCodexAppServerThreadBinding({ ...valid, supervisionSourceThreadId: undefined }),
    ).toBeUndefined();
  });

  it("commits a pending supervision branch only from its exact cleanup snapshot", async () => {
    const { records } = createStateStore();
    const store = createCodexAppServerBindingStore(records);
    const identity = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-supervision-cas",
    };
    const initial = {
      sourceThreadId: "thread-source",
      connectionFingerprint: "connection-one",
      lastTurnId: "turn-terminal",
    };
    await expect(
      store.mutate(identity, {
        kind: "set",
        if: { kind: "absent" },
        binding: {
          threadId: "thread-source",
          cwd: "/repo",
          connectionScope: "supervision",
          supervisionSourceThreadId: "thread-source",
          preserveNativeModel: true,
          conversationSourceTransferComplete: true,
          pendingSupervisionBranch: initial,
        },
      }),
    ).resolves.toBe(true);
    const tracked = { ...initial, cleanupThreadIds: ["thread-probe"] };
    await expect(
      store.mutate(identity, {
        kind: "patch-pending-supervision-branch",
        expected: { ...initial, connectionFingerprint: "connection-two" },
        pending: tracked,
      }),
    ).resolves.toBe(false);
    await expect(
      store.mutate(identity, {
        kind: "patch-pending-supervision-branch",
        expected: { ...initial, lastTurnId: "turn-other" },
        pending: tracked,
      }),
    ).resolves.toBe(false);
    await expect(
      store.mutate(identity, {
        kind: "patch-pending-supervision-branch",
        expected: initial,
        pending: tracked,
      }),
    ).resolves.toBe(true);
    await expect(
      store.mutate(identity, {
        kind: "commit-pending-supervision-branch",
        expected: initial,
        threadId: "thread-final",
        patch: { model: "native-model", modelProvider: "native-provider" },
      }),
    ).resolves.toBe(false);
    await expect(
      store.mutate(identity, {
        kind: "commit-pending-supervision-branch",
        expected: tracked,
        threadId: "thread-final",
        patch: { model: "native-model", modelProvider: "native-provider" },
      }),
    ).resolves.toBe(true);
    await expect(store.read(identity)).resolves.toEqual({
      threadId: "thread-final",
      cwd: "/repo",
      connectionScope: "supervision",
      supervisionSourceThreadId: "thread-source",
      preserveNativeModel: true,
      conversationSourceTransferComplete: true,
      model: "native-model",
      modelProvider: "native-provider",
    });
  });

  it("round-trips account app policy context", async () => {
    const { records } = createStateStore();
    const store = createCodexAppServerBindingStore(records);
    const identity = { kind: "session" as const, agentId: "main", sessionId: "session-account" };
    const pluginAppPolicyContext = {
      fingerprint: "account-policy-1",
      apps: {
        "chatgpt-meetings": {
          source: "account" as const,
          appName: "ChatGPT Meetings",
          allowDestructiveActions: true,
          allowOpenWorld: false,
          destructiveApprovalMode: "auto" as const,
          mcpServerNames: [],
        },
      },
      pluginAppIds: {},
    };

    await store.mutate(identity, {
      kind: "set",
      binding: { threadId: "thread-account", cwd: "/repo", pluginAppPolicyContext },
    });
    await expect(store.read(identity)).resolves.toMatchObject({ pluginAppPolicyContext });

    const imported = createStoredCodexAppServerBinding({
      schemaVersion: 2,
      threadId: "thread-account",
      cwd: "/repo",
      updatedAt: "2026-01-01T00:00:00.000Z",
      pluginAppPolicyContext,
    });
    expect(imported?.binding.pluginAppPolicyContext).toEqual(pluginAppPolicyContext);
  });

  it("round-trips repository marketplace app ownership through stored and imported bindings", async () => {
    const { records } = createStateStore();
    const store = createCodexAppServerBindingStore(records);
    const identity = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-security-review",
    };
    const pluginAppPolicyContext = {
      fingerprint: "repository-plugin-policy",
      apps: {
        github: {
          configKey: "security-review@company-tools",
          marketplaceName: "company-tools",
          pluginName: "security-review",
          allowDestructiveActions: true,
          destructiveApprovalMode: "ask" as const,
          mcpServerNames: ["github"],
        },
      },
      pluginAppIds: { "security-review@company-tools": ["github"] },
    };

    await store.mutate(identity, {
      kind: "set",
      binding: { threadId: "thread-security-review", cwd: "/repo/company", pluginAppPolicyContext },
    });
    await expect(store.read(identity)).resolves.toMatchObject({ pluginAppPolicyContext });

    const imported = createStoredCodexAppServerBinding({
      schemaVersion: 2,
      threadId: "thread-security-review",
      cwd: "/repo/company",
      pluginAppPolicyContext,
    });
    expect(imported?.binding.pluginAppPolicyContext).toEqual(pluginAppPolicyContext);
  });

  it("rejects unsafe marketplace names in imported plugin app ownership", () => {
    const imported = createStoredCodexAppServerBinding({
      schemaVersion: 2,
      threadId: "thread-unsafe-plugin",
      cwd: "/repo/company",
      pluginAppPolicyContext: {
        fingerprint: "unsafe-plugin-policy",
        apps: {
          github: {
            configKey: "security-review",
            marketplaceName: "../unsafe-marketplace",
            pluginName: "security-review",
            allowDestructiveActions: true,
            mcpServerNames: ["github"],
          },
        },
        pluginAppIds: { "security-review": ["github"] },
      },
    });

    expect(imported?.binding.pluginAppPolicyContext).toBeUndefined();
  });

  it("normalizes legacy fingerprints without rehashing canonical values", () => {
    const rawDynamicToolsFingerprint = JSON.stringify([{ name: "legacy_tool" }]);
    const rawUserMcpServersFingerprint = JSON.stringify({
      mcp_servers: { legacy: { command: "node" } },
    });
    const nativeSkillIsolationFingerprint = `sha256:${"b".repeat(64)}`;
    const imported = createStoredCodexAppServerBinding({
      schemaVersion: 2,
      threadId: "thread-legacy-fingerprints",
      cwd: "/repo",
      updatedAt: "2026-01-01T00:00:00.000Z",
      dynamicToolsFingerprint: rawDynamicToolsFingerprint,
      nativeSkillIsolationFingerprint,
      userMcpServersFingerprint: rawUserMcpServersFingerprint,
    });
    expect(imported?.binding).toMatchObject({
      dynamicToolsFingerprint: hashCodexAppServerBindingFingerprint(rawDynamicToolsFingerprint),
      nativeSkillIsolationFingerprint,
      userMcpServersFingerprint: hashCodexAppServerBindingFingerprint(rawUserMcpServersFingerprint),
    });

    const existingHash = `sha256:${"a".repeat(64)}`;
    const canonical = createStoredCodexAppServerBinding({
      schemaVersion: 2,
      threadId: "thread-canonical-fingerprints",
      cwd: "/repo",
      updatedAt: "2026-01-01T00:00:00.000Z",
      dynamicToolsFingerprint: "[]",
      userMcpServersFingerprint: existingHash,
    });
    expect(canonical?.binding).toMatchObject({
      dynamicToolsFingerprint: "[]",
      userMcpServersFingerprint: existingHash,
    });
  });

  it("canonicalizes undefined fields before writing binding record metadata", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-codex-binding-state-"));
    try {
      const records = createCodexTestBindingRecordStore();
      const store = createCodexAppServerBindingStore(records);
      const identity = { kind: "conversation" as const, bindingId: "binding-json" };

      await expect(
        store.mutate(identity, {
          kind: "set",
          binding: {
            threadId: "thread-json",
            cwd: "/repo",
            model: undefined,
            contextEngine: {
              schemaVersion: 1,
              engineId: "lossless-claw",
              policyFingerprint: "policy-1",
              projection: undefined,
            },
          },
        }),
      ).resolves.toBe(true);
      await expect(records.lookup(bindingStoreKey(identity))).resolves.toMatchObject({
        metadata: {
          stored: {
            version: 1,
            state: "active",
            binding: {
              threadId: "thread-json",
              cwd: "/repo",
              contextEngine: {
                schemaVersion: 1,
                engineId: "lossless-claw",
                policyFingerprint: "policy-1",
              },
            },
          },
        },
      });

      await expect(
        store.mutate(identity, {
          kind: "patch",
          threadId: "thread-json",
          patch: { contextEngine: undefined },
        }),
      ).resolves.toBe(true);
      await expect(store.read(identity)).resolves.toEqual({
        threadId: "thread-json",
        cwd: "/repo",
      });
      expect((await records.lookup(bindingStoreKey(identity)))?.metadata.stored).not.toHaveProperty(
        "lease",
      );
      await expect(store.mutate(identity, { kind: "clear" })).resolves.toBe(true);
      await expect(store.read(identity)).resolves.toBeUndefined();
    } finally {
      resetPluginStateStoreForTests();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("stores frozen workspace instructions atomically with bounded binding metadata", async () => {
    const stateDir = tempDirs.make("openclaw-codex-bootstrap-state-");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    try {
      const records = createPluginBlobStoreForTests<CodexAppServerBindingRecordMetadata>(
        "codex",
        {
          namespace: "app-server-binding-record-test",
          maxEntries: 10,
          maxBytesPerEntry: 1024 * 1024,
          maxBytesPerNamespace: 2 * 1024 * 1024,
          overflowPolicy: "reject-new",
        },
        env,
      );
      const store = createCodexAppServerBindingStore(records);
      const identity = { kind: "session" as const, agentId: "main", sessionId: "large-bootstrap" };
      // Matches the documented 50,000-character per-agent bootstrap example while
      // proving that a character budget is not a safe bound for a UTF-8 state row.
      const instructions = "界".repeat(50_000);

      await expect(
        store.mutate(identity, {
          kind: "set",
          binding: {
            threadId: "thread-large-bootstrap",
            cwd: "/repo",
            agentWorkspaceDeveloperInstructions: instructions,
          },
        }),
      ).resolves.toBe(true);

      const initialRecord = await records.lookup(bindingStoreKey(identity));
      expect(initialRecord).toMatchObject({
        sizeBytes: Buffer.byteLength(instructions, "utf8"),
        metadata: {
          version: 1,
          stored: {
            state: "active",
            binding: { threadId: "thread-large-bootstrap", cwd: "/repo" },
          },
          instructions: {
            version: 1,
            sizeBytes: Buffer.byteLength(instructions, "utf8"),
          },
        },
      });
      expect(initialRecord?.metadata.stored).not.toHaveProperty(
        "binding.agentWorkspaceDeveloperInstructions",
      );
      await expect(store.read(identity)).resolves.toMatchObject({
        threadId: "thread-large-bootstrap",
        agentWorkspaceDeveloperInstructions: instructions,
      });
      await expect(records.entries()).resolves.toHaveLength(1);

      await expect(
        store.mutate(identity, {
          kind: "patch",
          threadId: "thread-large-bootstrap",
          patch: { model: "gpt-5.6-sol" },
        }),
      ).resolves.toBe(true);
      await expect(store.read(identity)).resolves.toMatchObject({
        model: "gpt-5.6-sol",
        agentWorkspaceDeveloperInstructions: instructions,
      });
      await expect(records.entries()).resolves.toHaveLength(1);

      const replacementInstructions = `${instructions}\nA later frozen generation.`;
      await expect(
        store.mutate(identity, {
          kind: "patch",
          threadId: "thread-large-bootstrap",
          patch: { agentWorkspaceDeveloperInstructions: replacementInstructions },
        }),
      ).resolves.toBe(true);
      await expect(store.read(identity)).resolves.toMatchObject({
        agentWorkspaceDeveloperInstructions: replacementInstructions,
      });
      await expect(records.entries()).resolves.toHaveLength(1);
      await expect(records.lookup(bindingStoreKey(identity))).resolves.toMatchObject({
        sizeBytes: Buffer.byteLength(replacementInstructions, "utf8"),
      });
    } finally {
      resetPluginBlobStoreForTests();
      resetPluginStateStoreForTests();
    }
  });

  it("clears corrupt instruction bytes only for their exact storage revision", async () => {
    const { records } = createStateStore();
    const identity = { kind: "conversation" as const, bindingId: "corrupt-instructions" };
    const key = bindingStoreKey(identity);
    const store = createCodexAppServerBindingStore(records);
    await store.mutate(identity, {
      kind: "set",
      binding: {
        threadId: "thread-corrupt-instructions",
        cwd: "/repo",
        agentWorkspaceDeveloperInstructions: "frozen instructions",
      },
    });
    const record = await records.lookup(key);
    if (!record) {
      throw new Error("expected binding record");
    }
    await records.register(key, new TextEncoder().encode("corrupt"), record.metadata);

    let corruption: CodexAppServerInstructionSnapshotError | undefined;
    try {
      await store.read(identity);
    } catch (error) {
      if (error instanceof CodexAppServerInstructionSnapshotError) {
        corruption = error;
      }
    }
    expect(corruption?.storageRevision).toBe(record.metadata.revision);
    await expect(
      store.mutate(identity, {
        kind: "clear",
        threadId: "thread-corrupt-instructions",
        expectedStorageRevision: corruption!.storageRevision,
      }),
    ).resolves.toBe(true);
    await expect(store.read(identity)).resolves.toBeUndefined();
  });

  it("does not clear a concurrently replaced instruction snapshot", async () => {
    const stateDir = tempDirs.make("openclaw-codex-bootstrap-clear-fence-");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    try {
      const records = createPluginBlobStoreForTests<CodexAppServerBindingRecordMetadata>(
        "codex",
        {
          namespace: "app-server-binding-record-clear-fence-test",
          maxEntries: 10,
          maxBytesPerEntry: 1024 * 1024,
          maxBytesPerNamespace: 2 * 1024 * 1024,
          overflowPolicy: "reject-new",
        },
        env,
      );
      const store = createCodexAppServerBindingStore(records);
      const identity = { kind: "session" as const, agentId: "main", sessionId: "clear-fence" };
      await store.mutate(identity, {
        kind: "set",
        binding: {
          threadId: "thread-clear-fence",
          cwd: "/repo",
          agentWorkspaceDeveloperInstructions: "甲".repeat(50_000),
        },
      });
      const first = await records.lookup(bindingStoreKey(identity));
      if (!first) {
        throw new Error("expected first atomic binding record");
      }
      const firstRevision = first.metadata.revision;

      await store.mutate(identity, {
        kind: "patch",
        threadId: "thread-clear-fence",
        patch: { agentWorkspaceDeveloperInstructions: "乙".repeat(50_000) },
      });
      await expect(
        store.mutate(identity, {
          kind: "clear",
          threadId: "thread-clear-fence",
          expectedStorageRevision: firstRevision,
        }),
      ).resolves.toBe(false);
      await expect(store.read(identity)).resolves.toMatchObject({
        threadId: "thread-clear-fence",
        agentWorkspaceDeveloperInstructions: "乙".repeat(50_000),
      });
    } finally {
      resetPluginBlobStoreForTests();
      resetPluginStateStoreForTests();
    }
  });

  it("keeps a replacement thread when a stale clear completes later", async () => {
    const { records } = createStateStore();
    const store = createCodexAppServerBindingStore(records);
    const identity = { kind: "session" as const, agentId: "main", sessionId: "session-1" };
    await store.mutate(identity, {
      kind: "set",
      binding: { threadId: "thread-old", cwd: "/repo" },
    });
    await store.mutate(identity, {
      kind: "set",
      binding: { threadId: "thread-new", cwd: "/repo" },
    });

    await expect(store.mutate(identity, { kind: "clear", threadId: "thread-old" })).resolves.toBe(
      false,
    );
    await expect(store.read(identity)).resolves.toMatchObject({ threadId: "thread-new" });
    await expect(store.mutate(identity, { kind: "clear", threadId: "thread-new" })).resolves.toBe(
      true,
    );
    await expect(store.read(identity)).resolves.toBeUndefined();
  });

  it("retains cleared legacy conversation provenance after normal tombstones expire", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-13T00:00:00.000Z"));
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-codex-binding-state-"));
    try {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const records = createPluginBlobStoreForTests<CodexAppServerBindingRecordMetadata>(
        "codex",
        {
          namespace: "app-server-binding-record-clear-test",
          maxEntries: 10,
          maxBytesPerEntry: 1024 * 1024,
          maxBytesPerNamespace: 2 * 1024 * 1024,
          overflowPolicy: "reject-new",
        },
        env,
      );
      const store = createCodexAppServerBindingStore(records);
      const normal = { kind: "conversation" as const, bindingId: "normal" };
      const legacy = { kind: "conversation" as const, bindingId: "legacy-source" };
      for (const identity of [normal, legacy]) {
        await store.mutate(identity, {
          kind: "set",
          binding: { threadId: `thread-${identity.bindingId}`, cwd: "/repo" },
        });
        await store.mutate(identity, { kind: "clear" });
      }

      vi.advanceTimersByTime(10);
      await expect(records.lookup(bindingStoreKey(normal))).resolves.toBeUndefined();
      await expect(records.lookup(bindingStoreKey(legacy))).resolves.toMatchObject({
        metadata: { stored: { version: 1, state: "cleared" } },
      });
    } finally {
      resetPluginBlobStoreForTests();
      resetPluginStateStoreForTests();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("reclaims expired binding records when a new write reaches the physical row limit", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-13T00:00:00.000Z"));
    const stateDir = tempDirs.make("openclaw-codex-binding-record-quota-");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const records = createPluginBlobStoreForTests<CodexAppServerBindingRecordMetadata>(
      "codex",
      {
        namespace: "app-server-binding-record-quota-test",
        maxEntries: 1,
        maxBytesPerEntry: 1024 * 1024,
        maxBytesPerNamespace: 2 * 1024 * 1024,
        overflowPolicy: "reject-new",
      },
      env,
    );
    const store = createCodexAppServerBindingStore(records);
    const expired = { kind: "conversation" as const, bindingId: "expired" };
    const replacement = { kind: "conversation" as const, bindingId: "replacement" };
    await store.mutate(expired, {
      kind: "set",
      binding: { threadId: "thread-expired", cwd: "/repo" },
    });
    await expect(store.mutate(expired, { kind: "clear" })).resolves.toBe(true);

    vi.advanceTimersByTime(10);
    await expect(
      store.mutate(replacement, {
        kind: "set",
        binding: { threadId: "thread-replacement", cwd: "/repo" },
      }),
    ).resolves.toBe(true);
    await expect(records.entries()).resolves.toEqual([
      expect.objectContaining({ key: bindingStoreKey(replacement) }),
    ]);
    await expect(store.read(replacement)).resolves.toMatchObject({
      threadId: "thread-replacement",
    });
  });

  it("isolates identical session ids owned by different agents", async () => {
    const { records } = createStateStore();
    const store = createCodexAppServerBindingStore(records);
    const first = { kind: "session" as const, agentId: "first", sessionId: "shared" };
    const second = { kind: "session" as const, agentId: "second", sessionId: "shared" };

    await store.mutate(first, {
      kind: "set",
      binding: { threadId: "thread-first", cwd: "/first" },
    });
    await store.mutate(second, {
      kind: "set",
      binding: { threadId: "thread-second", cwd: "/second" },
    });

    await expect(store.read(first)).resolves.toMatchObject({ threadId: "thread-first" });
    await expect(store.read(second)).resolves.toMatchObject({ threadId: "thread-second" });
    expect(bindingStoreKey({ kind: "session", agentId: " First ", sessionId: "shared" })).toBe(
      "session:first:shared",
    );
  });

  it("keeps one binding across physical session rotations for a stable session key", async () => {
    const { records, recordValues } = createStateStore();
    const store = createCodexAppServerBindingStore(records);
    const first = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:telegram:chat-1",
    };
    const second = { ...first, sessionId: "session-2" };

    await store.mutate(first, {
      kind: "set",
      binding: { threadId: "thread-1", cwd: "/repo" },
    });
    await expect(store.read(second)).resolves.toBeUndefined();
    await store.withLease(second, async () => undefined);

    expect(bindingStoreKey(first)).toBe(bindingStoreKey(second));
    expect(recordValues.size).toBe(1);
    expect(recordValues.get(bindingStoreKey(second))).toMatchObject({ sessionId: "session-1" });
    await expect(store.adoptSessionGeneration(second, first.sessionId)).resolves.toBe("adopted");
    expect(recordValues.get(bindingStoreKey(second))).toMatchObject({
      state: "active",
      sessionId: "session-2",
      binding: { threadId: "thread-1" },
    });
    await expect(
      store.mutate(first, {
        kind: "patch",
        threadId: "thread-1",
        patch: { model: "stale-model" },
      }),
    ).resolves.toBe(false);
    await expect(store.mutate(first, { kind: "clear" })).resolves.toBe(false);
    await expect(store.read(second)).resolves.toMatchObject({ threadId: "thread-1" });
    await expect(store.mutate(second, { kind: "clear" })).resolves.toBe(true);
  });

  it("rejects a delayed adoption after a newer session generation wins", async () => {
    const { records } = createStateStore();
    const store = createCodexAppServerBindingStore(records);
    const first = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:telegram:chat-1",
    };
    const second = { ...first, sessionId: "session-2" };
    const third = { ...first, sessionId: "session-3" };
    await store.mutate(first, {
      kind: "set",
      binding: { threadId: "thread-1", cwd: "/repo" },
    });

    await expect(store.adoptSessionGeneration(second, first.sessionId)).resolves.toBe("adopted");
    await expect(store.adoptSessionGeneration(third, second.sessionId)).resolves.toBe("adopted");
    await expect(store.adoptSessionGeneration(third, second.sessionId)).resolves.toBe("current");
    await expect(store.adoptSessionGeneration(second, first.sessionId)).resolves.toBe("conflict");
    await expect(store.retireSessionGeneration(second)).resolves.toBe("conflict");

    await expect(store.read(second)).resolves.toBeUndefined();
    await expect(store.read(third)).resolves.toMatchObject({ threadId: "thread-1" });
  });

  it("rejects reclaim when another session generation wins after verification", async () => {
    const { records } = createStateStore();
    const store = createCodexAppServerBindingStore(records);
    const first = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:telegram:chat-1",
    };
    const second = { ...first, sessionId: "session-2" };
    const third = { ...first, sessionId: "session-3" };
    await store.mutate(first, {
      kind: "set",
      binding: { threadId: "thread-1", cwd: "/repo" },
    });

    const plan = await store.prepareSessionGenerationReclaim(second);
    expect(plan).toEqual({ kind: "verify", expectedPreviousSessionId: first.sessionId });
    await expect(store.adoptSessionGeneration(third, first.sessionId)).resolves.toBe("adopted");
    if (plan.kind !== "verify") {
      throw new Error("expected stale session generation");
    }
    await expect(
      store.mutate(second, {
        kind: "reclaim-generation",
        expectedPreviousSessionId: plan.expectedPreviousSessionId,
      }),
    ).resolves.toBe(false);
    await expect(store.read(third)).resolves.toMatchObject({ threadId: "thread-1" });
  });

  it("falls back to physical session identity when no stable session key exists", () => {
    const first = { kind: "session" as const, agentId: "main", sessionId: "session-1" };
    const second = { ...first, sessionId: "session-2" };

    expect(bindingStoreKey(first)).not.toBe(bindingStoreKey(second));
  });

  it("does not create a retirement tombstone for a session without a Codex binding", async () => {
    const { records, recordValues } = createStateStore();
    const store = createCodexAppServerBindingStore(records);
    const identity = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:telegram:chat-1",
    };

    await expect(store.retireSessionGeneration(identity)).resolves.toBe("absent");
    expect(recordValues.size).toBe(0);
  });

  it("expires physical-session retirement fences but retains stable-key fences", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-13T00:00:00.000Z"));
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-codex-binding-state-"));
    try {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const records = createPluginBlobStoreForTests<CodexAppServerBindingRecordMetadata>(
        "codex",
        {
          namespace: "app-server-binding-record-retirement-test",
          maxEntries: 10,
          maxBytesPerEntry: 1024 * 1024,
          maxBytesPerNamespace: 2 * 1024 * 1024,
          overflowPolicy: "reject-new",
        },
        env,
      );
      const store = createCodexAppServerBindingStore(records);
      const physical = {
        kind: "session" as const,
        agentId: "main",
        sessionId: "physical-session",
      };
      const stable = {
        ...physical,
        sessionId: "stable-session",
        sessionKey: "agent:main:telegram:chat-1",
      };
      for (const identity of [physical, stable]) {
        await store.mutate(identity, {
          kind: "set",
          binding: { threadId: `thread-${identity.sessionId}`, cwd: "/repo" },
        });
        await expect(store.retireSessionGeneration(identity)).resolves.toBe("applied");
      }

      await expect(records.lookup(bindingStoreKey(physical))).resolves.toMatchObject({
        metadata: { stored: { state: "cleared", retired: true } },
      });
      await expect(records.lookup(bindingStoreKey(stable))).resolves.toMatchObject({
        metadata: { stored: { state: "cleared", retired: true } },
      });

      vi.advanceTimersByTime(2 * 60_000);

      await expect(records.lookup(bindingStoreKey(physical))).resolves.toBeUndefined();
      await expect(records.lookup(bindingStoreKey(stable))).resolves.toMatchObject({
        metadata: { stored: { state: "cleared", retired: true } },
      });
    } finally {
      resetPluginBlobStoreForTests();
      resetPluginStateStoreForTests();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("claims a cleared binding once without allowing the retired generation back in", async () => {
    const { records, recordValues } = createStateStore();
    const store = createCodexAppServerBindingStore(records);
    const previous = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:telegram:chat-1",
    };
    const current = { ...previous, sessionId: "session-2" };
    await store.mutate(previous, {
      kind: "set",
      binding: { threadId: "thread-old", cwd: "/old" },
    });
    await expect(
      store.mutate(current, {
        kind: "set",
        binding: { threadId: "thread-premature", cwd: "/new" },
        if: { kind: "absent" },
      }),
    ).resolves.toBe(false);
    await expect(store.mutate(previous, { kind: "clear" })).resolves.toBe(true);

    await expect(
      store.mutate(current, {
        kind: "set",
        binding: { threadId: "thread-new", cwd: "/new" },
        if: { kind: "absent" },
      }),
    ).resolves.toBe(false);
    await expect(
      store.mutate(current, {
        kind: "reclaim-generation",
        expectedPreviousSessionId: previous.sessionId,
      }),
    ).resolves.toBe(true);
    await expect(
      store.mutate(current, {
        kind: "set",
        binding: { threadId: "thread-new", cwd: "/new" },
        if: { kind: "absent" },
      }),
    ).resolves.toBe(true);

    await expect(store.read(previous)).resolves.toBeUndefined();
    await expect(store.read(current)).resolves.toMatchObject({
      threadId: "thread-new",
      cwd: "/new",
    });
    await expect(
      store.mutate(previous, {
        kind: "set",
        binding: { threadId: "thread-stale", cwd: "/stale" },
        if: { kind: "absent" },
      }),
    ).resolves.toBe(false);
    await expect(store.mutate(previous, { kind: "clear" })).resolves.toBe(false);
    expect(recordValues.size).toBe(1);
  });

  it("reclaims a stale stable generation only for the current OpenClaw session", async () => {
    const { records, recordValues } = createStateStore();
    const store = createCodexAppServerBindingStore(records);
    const previous = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:telegram:chat-1",
    };
    const current = { ...previous, sessionId: "session-2" };
    await store.mutate(previous, {
      kind: "set",
      binding: { threadId: "thread-old", cwd: "/old" },
    });
    await expect(
      store.mutate(current, {
        kind: "reclaim-generation",
        expectedPreviousSessionId: "other-session",
      }),
    ).resolves.toBe(false);
    expect(recordValues.get(bindingStoreKey(previous))).toMatchObject({
      state: "active",
      sessionId: "session-1",
    });

    await expect(
      store.mutate(current, {
        kind: "reclaim-generation",
        expectedPreviousSessionId: previous.sessionId,
      }),
    ).resolves.toBe(true);
    expect(recordValues.get(bindingStoreKey(current))).toEqual({
      version: 1,
      state: "cleared",
      sessionId: "session-2",
    });
    await expect(
      store.mutate(previous, {
        kind: "set",
        binding: { threadId: "thread-delayed-before-commit", cwd: "/stale" },
      }),
    ).resolves.toBe(false);
    await expect(
      store.mutate(current, {
        kind: "set",
        binding: { threadId: "thread-new", cwd: "/new" },
        if: { kind: "absent" },
      }),
    ).resolves.toBe(true);

    await expect(
      store.mutate(previous, {
        kind: "reclaim-generation",
        expectedPreviousSessionId: previous.sessionId,
      }),
    ).resolves.toBe(false);
    await expect(
      store.mutate(previous, {
        kind: "set",
        binding: { threadId: "thread-delayed", cwd: "/stale" },
      }),
    ).resolves.toBe(false);
    await expect(store.read(current)).resolves.toMatchObject({ threadId: "thread-new" });
  });

  it("preserves a stale private supervision binding instead of reclaiming it as empty", async () => {
    const { records, recordValues } = createStateStore();
    const store = createCodexAppServerBindingStore(records);
    const previous = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:telegram:supervised",
    };
    const current = { ...previous, sessionId: "session-2" };
    await store.mutate(previous, {
      kind: "set",
      binding: {
        threadId: "thread-supervised",
        connectionScope: "supervision",
        supervisionSourceThreadId: "thread-source",
        cwd: "/repo",
        model: "gpt-5.5",
        modelProvider: "openai",
        preserveNativeModel: true,
        conversationSourceTransferComplete: true,
      },
    });
    await expect(
      store.mutate(previous, {
        kind: "set",
        binding: { threadId: "thread-replacement", cwd: "/other" },
      }),
    ).resolves.toBe(false);
    await expect(
      store.mutate(previous, { kind: "clear", threadId: "thread-supervised" }),
    ).resolves.toBe(false);

    await expect(
      store.mutate(current, {
        kind: "reclaim-generation",
        expectedPreviousSessionId: previous.sessionId,
      }),
    ).resolves.toBe(false);
    expect(recordValues.get(bindingStoreKey(previous))).toMatchObject({
      state: "active",
      sessionId: previous.sessionId,
      binding: { threadId: "thread-supervised", connectionScope: "supervision" },
    });
    await expect(store.read(previous)).resolves.toMatchObject({
      threadId: "thread-supervised",
      connectionScope: "supervision",
    });
    await expect(store.read(current)).resolves.toBeUndefined();
  });

  it("fences a retired physical generation until its successor claims the stable key", async () => {
    const { records, recordValues } = createStateStore();
    const store = createCodexAppServerBindingStore(records);
    const previous = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:telegram:chat-1",
    };
    const current = { ...previous, sessionId: "session-2" };
    await store.mutate(previous, {
      kind: "set",
      binding: { threadId: "thread-old", cwd: "/old" },
    });

    await expect(store.retireSessionGeneration(previous)).resolves.toBe("applied");
    await expect(store.mutate(previous, { kind: "clear" })).resolves.toBe(true);
    expect(recordValues.get(bindingStoreKey(previous))).toEqual({
      version: 1,
      state: "cleared",
      retired: true,
      sessionId: "session-1",
    });
    await expect(
      store.mutate(previous, {
        kind: "set",
        binding: { threadId: "thread-stale", cwd: "/stale" },
      }),
    ).resolves.toBe(false);
    await expect(store.withLease(previous, async () => undefined)).rejects.toThrow(
      "generation was retired",
    );

    await store.withLease(current, async () => undefined);
    expect(recordValues.get(bindingStoreKey(previous))).toEqual({
      version: 1,
      state: "cleared",
      retired: true,
      sessionId: "session-1",
    });
    await expect(
      store.mutate(previous, {
        kind: "set",
        binding: { threadId: "thread-delayed", cwd: "/stale" },
      }),
    ).resolves.toBe(false);

    await expect(
      store.mutate(current, {
        kind: "reclaim-generation",
        expectedPreviousSessionId: previous.sessionId,
      }),
    ).resolves.toBe(true);
    await expect(
      store.mutate(current, {
        kind: "set",
        binding: { threadId: "thread-new", cwd: "/new" },
      }),
    ).resolves.toBe(true);
    await expect(store.read(current)).resolves.toMatchObject({ threadId: "thread-new" });
  });

  it("keeps a retired in-place generation fenced until it is verified", async () => {
    const { records, recordValues } = createStateStore();
    const store = createCodexAppServerBindingStore(records);
    const identity = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:telegram:chat-1",
    };
    await store.mutate(identity, {
      kind: "set",
      binding: { threadId: "thread-old", cwd: "/old" },
    });
    await store.retireSessionGeneration(identity);

    await expect(store.resetSessionGeneration(identity)).resolves.toBe("conflict");
    expect(recordValues.get(bindingStoreKey(identity))).toEqual({
      version: 1,
      state: "cleared",
      retired: true,
      sessionId: identity.sessionId,
    });
    await expect(
      store.mutate(identity, {
        kind: "set",
        binding: { threadId: "thread-unverified", cwd: "/new" },
      }),
    ).resolves.toBe(false);
  });

  it("verifies and releases a retired fence for the still-current stable session id", async () => {
    const { records, recordValues } = createStateStore();
    const store = createCodexAppServerBindingStore(records);
    const identity = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:telegram:chat-1",
    };
    await store.mutate(identity, {
      kind: "set",
      binding: { threadId: "thread-old", cwd: "/old" },
    });
    await store.retireSessionGeneration(identity);

    const plan = await store.prepareSessionGenerationReclaim(identity);
    expect(plan).toEqual({
      kind: "verify",
      expectedPreviousSessionId: identity.sessionId,
    });
    if (plan.kind !== "verify") {
      throw new Error("expected the current retired generation to require verification");
    }
    await expect(
      store.mutate(identity, {
        kind: "reclaim-generation",
        expectedPreviousSessionId: plan.expectedPreviousSessionId,
      }),
    ).resolves.toBe(true);
    expect(recordValues.get(bindingStoreKey(identity))).toEqual({
      version: 1,
      state: "cleared",
      sessionId: identity.sessionId,
    });
    await expect(
      store.mutate(identity, {
        kind: "set",
        binding: { threadId: "thread-recovered", cwd: "/new" },
      }),
    ).resolves.toBe(true);
  });

  it("recovers a retired in-place generation through the authoritative session store", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-codex-reset-reclaim-"));
    const storePath = path.join(root, "sessions.json");
    const { records } = createStateStore();
    const store = createCodexAppServerBindingStore(records);
    const identity = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-current",
      sessionKey: "agent:main:telegram:direct:123",
    };
    try {
      await upsertSessionEntry({
        agentId: identity.agentId,
        sessionKey: identity.sessionKey,
        storePath,
        entry: { sessionId: identity.sessionId, updatedAt: 1 },
      });
      await store.mutate(identity, {
        kind: "set",
        binding: { threadId: "thread-before-reset", cwd: "/repo" },
      });
      await store.retireSessionGeneration(identity);

      await expect(
        reclaimCurrentCodexSessionGeneration({
          bindingStore: store,
          identity,
          config: { session: { store: storePath } },
        }),
      ).resolves.toBe(true);
      await expect(
        store.mutate(identity, {
          kind: "set",
          binding: { threadId: "thread-after-reset", cwd: "/repo" },
        }),
      ).resolves.toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("drains an in-flight ownership mutation and rejects late attachment during archive", async () => {
    const fixture = createStateStore();
    const originalMutate = fixture.records.mutate.bind(fixture.records);
    let startArchive: (() => void) | undefined;
    fixture.records.mutate = async (...args) => {
      startArchive?.();
      startArchive = undefined;
      return await originalMutate(...args);
    };
    const store = createCodexAppServerBindingStore(fixture.records);
    const firstIdentity = { kind: "conversation" as const, bindingId: "first" };
    const lateIdentity = { kind: "conversation" as const, bindingId: "late" };
    let releaseArchive!: () => void;
    const archiveReleased = new Promise<void>((resolve) => {
      releaseArchive = resolve;
    });
    let archive!: Promise<void>;
    startArchive = () => {
      archive = store.withThreadArchiveFence(async () => {
        await expect(
          store.mutate(firstIdentity, {
            kind: "patch",
            threadId: "thread-before-archive",
            patch: { cwd: "/updated" },
          }),
        ).resolves.toBe(true);
        await archiveReleased;
      });
    };

    await expect(
      store.mutate(firstIdentity, {
        kind: "set",
        binding: { threadId: "thread-before-archive", cwd: "/repo" },
      }),
    ).resolves.toBe(true);
    await Promise.resolve();
    await expect(
      store.mutate(lateIdentity, {
        kind: "set",
        binding: { threadId: "thread-late", cwd: "/repo" },
      }),
    ).rejects.toThrow("native archive is in progress");
    releaseArchive();
    await expect(archive).resolves.toBeUndefined();
    await expect(store.read(firstIdentity)).resolves.toMatchObject({ cwd: "/updated" });
    await expect(store.read(lateIdentity)).resolves.toBeUndefined();
  });

  it("hashes stable session keys and keeps agent ownership distinct", () => {
    const sessionKey = "agent:main:telegram:private-peer@example.com";
    const first = bindingStoreKey({
      kind: "session",
      agentId: "first",
      sessionId: "session-1",
      sessionKey,
    });
    const second = bindingStoreKey({
      kind: "session",
      agentId: "second",
      sessionId: "session-2",
      sessionKey,
    });

    expect(first).toMatch(/^session-key:first:[A-Za-z0-9_-]{43}$/u);
    expect(first).not.toContain("private-peer");
    expect(second).not.toBe(first);
  });

  it("patches only the expected thread without advancing history implicitly", async () => {
    const { records } = createStateStore();
    const store = createCodexAppServerBindingStore(records);
    const identity = { kind: "conversation" as const, bindingId: "binding-1" };
    const historyCoveredThrough = "2026-01-01T00:00:00.000Z";
    await store.mutate(identity, {
      kind: "set",
      binding: {
        threadId: "thread-1",
        cwd: "/repo",
        model: "gpt-5.4-codex",
        historyCoveredThrough,
      },
    });

    await expect(
      store.mutate(identity, {
        kind: "patch",
        threadId: "thread-1",
        patch: { serviceTier: "fast" },
      }),
    ).resolves.toBe(true);
    await expect(store.read(identity)).resolves.toMatchObject({
      threadId: "thread-1",
      model: "gpt-5.4-codex",
      serviceTier: "priority",
      historyCoveredThrough,
    });
  });

  it("rejects stale patches and absent-only writes", async () => {
    const { records } = createStateStore();
    const store = createCodexAppServerBindingStore(records);
    const identity = { kind: "conversation" as const, bindingId: "binding-1" };
    await store.mutate(identity, {
      kind: "set",
      binding: { threadId: "thread-new", cwd: "/repo" },
    });

    await expect(
      store.mutate(identity, {
        kind: "patch",
        threadId: "thread-old",
        patch: { model: "stale-model" },
      }),
    ).resolves.toBe(false);
    await expect(
      store.mutate(identity, {
        kind: "set",
        binding: { threadId: "thread-stale", cwd: "/repo" },
        if: { kind: "absent" },
      }),
    ).resolves.toBe(false);
    await expect(store.read(identity)).resolves.toMatchObject({ threadId: "thread-new" });
  });

  it("maps the legacy sidecar update timestamp to the history watermark", () => {
    const updatedAt = "2026-01-01T00:00:00.000Z";
    const stored = createStoredCodexAppServerBinding({
      schemaVersion: 1,
      threadId: "thread-1",
      cwd: "/repo",
      createdAt: "2025-12-31T00:00:00.000Z",
      updatedAt,
    });

    expect(stored?.binding).toMatchObject({ historyCoveredThrough: updatedAt });
    expect(stored?.binding).not.toHaveProperty("createdAt");
    expect(stored?.binding).not.toHaveProperty("updatedAt");
  });

  it("normalizes version 1 destructive approval modes during import", () => {
    const stored = createStoredCodexAppServerBinding({
      schemaVersion: 1,
      threadId: "thread-1",
      cwd: "/repo",
      pluginAppPolicyContext: {
        fingerprint: "policy-1",
        apps: {
          allow: {
            configKey: "allow",
            marketplaceName: "openai-curated",
            pluginName: "allow-plugin",
            allowDestructiveActions: true,
            destructiveApprovalMode: "auto",
            mcpServerNames: [],
          },
          prompt: {
            configKey: "prompt",
            marketplaceName: "openai-curated",
            pluginName: "prompt-plugin",
            allowDestructiveActions: true,
            destructiveApprovalMode: "on-request",
            mcpServerNames: [],
          },
        },
        pluginAppIds: {},
      },
    });

    expect(stored?.binding.pluginAppPolicyContext?.apps.allow?.destructiveApprovalMode).toBe(
      "allow",
    );
    expect(stored?.binding.pluginAppPolicyContext?.apps.prompt?.destructiveApprovalMode).toBe(
      "auto",
    );
  });

  it("preserves version 2 ask approval mode and drops invalid policy contexts", () => {
    const policyContext = {
      fingerprint: "policy-2",
      apps: {
        app: {
          configKey: "app",
          marketplaceName: "openai-curated",
          pluginName: "plugin",
          allowDestructiveActions: true,
          destructiveApprovalMode: "ask",
          mcpServerNames: [],
        },
      },
      pluginAppIds: {},
    };
    const stored = createStoredCodexAppServerBinding({
      schemaVersion: 2,
      threadId: "thread-2",
      cwd: "/repo",
      pluginAppPolicyContext: policyContext,
    });
    const invalid = createStoredCodexAppServerBinding({
      schemaVersion: 2,
      threadId: "thread-invalid",
      cwd: "/repo",
      pluginAppPolicyContext: {
        ...policyContext,
        apps: { app: { ...policyContext.apps.app, appId: "not-allowed" } },
      },
    });

    expect(stored?.binding.pluginAppPolicyContext?.apps.app?.destructiveApprovalMode).toBe("ask");
    expect(invalid?.binding.pluginAppPolicyContext).toBeUndefined();
  });

  it("round-trips workspace-directory plugin policy context", () => {
    const stored = createStoredCodexAppServerBinding({
      schemaVersion: 2,
      threadId: "thread-workspace-plugin",
      cwd: "/repo",
      pluginAppPolicyContext: {
        fingerprint: "policy-workspace",
        apps: {
          workspaceData: {
            configKey: "workspaceData",
            marketplaceName: "workspace-directory",
            pluginName: "workspace-data@workspace-directory",
            allowDestructiveActions: true,
            destructiveApprovalMode: "ask",
            mcpServerNames: [],
          },
        },
        pluginAppIds: { workspaceData: ["workspace-data"] },
      },
    });

    expect(stored?.binding.pluginAppPolicyContext).toMatchObject({
      apps: {
        workspaceData: {
          marketplaceName: "workspace-directory",
          pluginName: "workspace-data@workspace-directory",
          destructiveApprovalMode: "ask",
        },
      },
      pluginAppIds: { workspaceData: ["workspace-data"] },
    });
  });

  it("serializes writes from another facade behind a native-compaction lease", async () => {
    vi.useFakeTimers();
    const { records } = createStateStore();
    const owner = createCodexAppServerBindingStore(records);
    const peer = createCodexAppServerBindingStore(records);
    const identity = { kind: "conversation" as const, bindingId: "binding-1" };
    await owner.mutate(identity, {
      kind: "set",
      binding: { threadId: "thread-1", cwd: "/repo" },
    });
    let peerFinished = false;
    let peerWrite!: Promise<boolean>;

    await owner.withLease(identity, async () => {
      peerWrite = peer
        .mutate(identity, {
          kind: "set",
          binding: { threadId: "thread-2", cwd: "/repo" },
        })
        .then((result) => {
          peerFinished = true;
          return result;
        });
      await Promise.resolve();
      expect(peerFinished).toBe(false);
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await peerWrite;

    await expect(peer.read(identity)).resolves.toMatchObject({ threadId: "thread-2" });
  });

  it("leases an absent binding before creating its first thread", async () => {
    vi.useFakeTimers();
    const { records } = createStateStore();
    const owner = createCodexAppServerBindingStore(records);
    const peer = createCodexAppServerBindingStore(records);
    const identity = { kind: "conversation" as const, bindingId: "binding-new" };
    let peerFinished = false;
    let peerWrite!: Promise<boolean>;

    await owner.withLease(identity, async () => {
      peerWrite = peer
        .mutate(identity, {
          kind: "set",
          binding: { threadId: "thread-peer", cwd: "/repo" },
          if: { kind: "absent" },
        })
        .then((result) => {
          peerFinished = true;
          return result;
        });
      await Promise.resolve();
      expect(peerFinished).toBe(false);
      await expect(
        owner.mutate(identity, {
          kind: "set",
          binding: { threadId: "thread-owner", cwd: "/repo" },
          if: { kind: "absent" },
        }),
      ).resolves.toBe(true);
      await Promise.resolve();
      expect(peerFinished).toBe(false);
    });
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(peerWrite).resolves.toBe(false);
    await expect(owner.read(identity)).resolves.toMatchObject({ threadId: "thread-owner" });
  });

  it("releases a lease when its owner callback rejects", async () => {
    const { records } = createStateStore();
    const owner = createCodexAppServerBindingStore(records);
    const peer = createCodexAppServerBindingStore(records);
    const identity = { kind: "conversation" as const, bindingId: "binding-rejected-owner" };
    await owner.mutate(identity, {
      kind: "set",
      binding: { threadId: "thread-owner", cwd: "/repo" },
    });

    await expect(
      owner.withLease(identity, async () => {
        throw new Error("owner failed");
      }),
    ).rejects.toThrow("owner failed");
    await expect(
      peer.mutate(identity, {
        kind: "patch",
        threadId: "thread-owner",
        patch: { serviceTier: "priority" },
      }),
    ).resolves.toBe(true);
  });

  it("renews a live lease across a long app-server request", async () => {
    vi.useFakeTimers();
    const { records } = createStateStore();
    const owner = createCodexAppServerBindingStore(records);
    const peer = createCodexAppServerBindingStore(records);
    const identity = { kind: "conversation" as const, bindingId: "binding-renewed-owner" };
    await owner.mutate(identity, {
      kind: "set",
      binding: { threadId: "thread-owner", cwd: "/repo" },
    });
    let releaseOwner!: () => void;
    let markOwnerStarted!: () => void;
    const ownerStarted = new Promise<void>((resolve) => {
      markOwnerStarted = resolve;
    });
    const holdOwner = new Promise<void>((resolve) => {
      releaseOwner = resolve;
    });
    const ownerRun = owner.withLease(identity, async () => {
      markOwnerStarted();
      await holdOwner;
      return await owner.mutate(identity, {
        kind: "patch",
        threadId: "thread-owner",
        patch: { serviceTier: "priority" },
      });
    });
    await ownerStarted;
    let peerFinished = false;
    const peerWrite = peer
      .mutate(identity, {
        kind: "set",
        binding: { threadId: "thread-peer", cwd: "/repo" },
      })
      .then((result) => {
        peerFinished = true;
        return result;
      });

    await vi.advanceTimersByTimeAsync(66_000);
    expect(peerFinished).toBe(false);
    releaseOwner();
    await expect(ownerRun).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(peerWrite).resolves.toBe(true);
    await expect(peer.read(identity)).resolves.toMatchObject({ threadId: "thread-peer" });
  });

  it("fences an expired lease owner after a peer takes over", async () => {
    vi.useFakeTimers();
    const { records } = createStateStore();
    const owner = createCodexAppServerBindingStore(records);
    const peer = createCodexAppServerBindingStore(records);
    const identity = { kind: "conversation" as const, bindingId: "binding-stale-owner" };
    await owner.mutate(identity, {
      kind: "set",
      binding: { threadId: "thread-owner", cwd: "/repo" },
    });

    await expect(
      owner.withLease(identity, async () => {
        vi.setSystemTime(Date.now() + 66_000);
        await peer.withLease(identity, async () => {
          await expect(
            peer.mutate(identity, {
              kind: "set",
              binding: { threadId: "thread-peer", cwd: "/repo" },
            }),
          ).resolves.toBe(true);
        });
        await owner.mutate(identity, {
          kind: "set",
          binding: { threadId: "thread-stale", cwd: "/repo" },
        });
      }),
    ).rejects.toThrow("Lost Codex binding lease");

    await expect(owner.read(identity)).resolves.toMatchObject({ threadId: "thread-peer" });
  });

  it("surfaces heartbeat lease loss without deleting the replacement owner", async () => {
    vi.useFakeTimers();
    const { records, recordValues } = createStateStore();
    const owner = createCodexAppServerBindingStore(records);
    const identity = { kind: "conversation" as const, bindingId: "binding-replaced-owner" };
    await owner.mutate(identity, {
      kind: "set",
      binding: { threadId: "thread-owner", cwd: "/repo" },
    });
    let releaseOwner!: () => void;
    let markOwnerStarted!: () => void;
    const ownerStarted = new Promise<void>((resolve) => {
      markOwnerStarted = resolve;
    });
    const holdOwner = new Promise<void>((resolve) => {
      releaseOwner = resolve;
    });
    const ownerRun = owner.withLease(identity, async () => {
      markOwnerStarted();
      await holdOwner;
    });
    await ownerStarted;
    const key = bindingStoreKey(identity);
    await records.mutate(key, (current) => {
      if (!current) {
        throw new Error("expected binding record");
      }
      return {
        kind: "set",
        bytes: current.bytes,
        metadata: {
          ...current.metadata,
          stored: {
            ...current.metadata.stored,
            lease: { token: "peer-owner", expiresAt: Date.now() + 120_000 },
          },
        },
      };
    });

    await vi.advanceTimersByTimeAsync(30_000);
    releaseOwner();
    await expect(ownerRun).rejects.toThrow("Lost Codex binding lease");
    expect(recordValues.get(key)?.lease?.token).toBe("peer-owner");
  });

  it("rejects empty storage identities", () => {
    expect(() => bindingStoreKey({ kind: "session", agentId: "main", sessionId: " " })).toThrow(
      "requires a session id",
    );
    expect(() =>
      bindingStoreKey({ kind: "session", agentId: " ", sessionId: "session-1" }),
    ).toThrow("requires an agent id");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
