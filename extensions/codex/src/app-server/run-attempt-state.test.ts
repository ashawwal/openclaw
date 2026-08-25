// Codex tests cover run-attempt prompt state helpers.
import { describe, expect, it, vi } from "vitest";
import {
  prependCurrentInboundContext,
  readCodexAppServerStartupBinding,
} from "./run-attempt-state.js";
import {
  CodexAppServerInstructionSnapshotError,
  type CodexAppServerBindingStore,
} from "./session-binding.js";

describe("prependCurrentInboundContext", () => {
  it("neutralizes explicit mention sigils in inbound context but not the prompt", () => {
    const joined = prependCurrentInboundContext("run $current-skill now", {
      text: "Quoted reply: please try $example-manual later",
    });

    expect(joined).toBe(
      "Quoted reply: please try ＄example-manual later\n\nrun $current-skill now",
    );
  });

  it("returns the prompt unchanged without inbound context", () => {
    expect(prependCurrentInboundContext("run $current-skill now", undefined)).toBe(
      "run $current-skill now",
    );
  });
});

describe("readCodexAppServerStartupBinding", () => {
  const identity = { kind: "session" as const, agentId: "main", sessionId: "session-1" };

  it("clears an ordinary binding with a corrupt immutable snapshot", async () => {
    const error = new CodexAppServerInstructionSnapshotError({
      threadId: "thread-old",
      storageRevision: "00000000-0000-4000-8000-000000000001",
    });
    const mutate = vi.fn().mockResolvedValue(true);
    const bindingStore = {
      read: vi.fn().mockRejectedValue(error),
      mutate,
    } as unknown as CodexAppServerBindingStore;

    await expect(
      readCodexAppServerStartupBinding({ bindingStore, identity }),
    ).resolves.toBeUndefined();
    expect(mutate).toHaveBeenCalledWith(identity, {
      kind: "clear",
      threadId: "thread-old",
      expectedStorageRevision: error.storageRevision,
    });
  });

  it("never clears supervised ownership or a binding that lost its clear race", async () => {
    for (const testCase of [
      { connectionScope: "supervision" as const, clearResult: true },
      { connectionScope: undefined, clearResult: false },
    ]) {
      const error = new CodexAppServerInstructionSnapshotError({
        threadId: "thread-owned",
        connectionScope: testCase.connectionScope,
        storageRevision: "00000000-0000-4000-8000-000000000002",
      });
      const mutate = vi.fn().mockResolvedValue(testCase.clearResult);
      const bindingStore = {
        read: vi.fn().mockRejectedValue(error),
        mutate,
      } as unknown as CodexAppServerBindingStore;

      await expect(readCodexAppServerStartupBinding({ bindingStore, identity })).rejects.toBe(
        error,
      );
      expect(mutate).toHaveBeenCalledTimes(testCase.connectionScope === "supervision" ? 0 : 1);
    }
  });
});
