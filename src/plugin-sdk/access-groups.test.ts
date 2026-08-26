/**
 * Tests access group helper behavior exposed through the SDK.
 */
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  expandAllowFromWithAccessGroups,
  projectStaticAccessGroupAllowFrom,
  resolveAccessGroupAllowFromState,
} from "./access-groups.js";

describe("access group allowlists", () => {
  it("projects only statically enumerable references into concrete channel senders", () => {
    const accessGroups = {
      admins: { type: "message.senders", members: { "*": ["global"], telegram: ["123"] } },
      audience: { type: "discord.channelAudience", guildId: "guild-1", channelId: "channel-1" },
    } satisfies NonNullable<OpenClawConfig["accessGroups"]>;

    expect(
      projectStaticAccessGroupAllowFrom({
        accessGroups,
        allowFrom: ["456", "accessGroup:admins", "accessGroup:audience", "accessGroup:missing"],
        channel: "telegram",
      }),
    ).toEqual({
      concreteEntries: ["456", "global", "123"],
      unresolvedReferences: ["accessGroup:audience", "accessGroup:missing"],
    });
  });

  it("reports static, missing, unsupported, failed, and compatibility expansion states", async () => {
    const cfg = {
      accessGroups: {
        admins: { type: "message.senders", members: { "*": ["global"], test: ["local"] } },
        audience: { type: "discord.channelAudience", guildId: "guild-1", channelId: "channel-1" },
      },
    } as OpenClawConfig;

    const staticState = await resolveAccessGroupAllowFromState({
      accessGroups: cfg.accessGroups,
      allowFrom: ["accessGroup:admins", "accessGroup:missing", "accessGroup:audience"],
      channel: "test",
      accountId: "default",
      senderId: "local",
      isSenderAllowed: (senderId, allowFrom) => allowFrom.includes(senderId),
    });
    expect(staticState.referenced).toEqual(["admins", "missing", "audience"]);
    expect(staticState.matched).toEqual(["admins"]);
    expect(staticState.missing).toEqual(["missing"]);
    expect(staticState.unsupported).toEqual(["audience"]);
    expect(staticState.failed).toEqual([]);
    expect(staticState.matchedAllowFromEntries).toEqual(["accessGroup:admins"]);
    expect(staticState.hasReferences).toBe(true);
    expect(staticState.hasMatch).toBe(true);

    const failedState = await resolveAccessGroupAllowFromState({
      accessGroups: cfg.accessGroups,
      allowFrom: ["accessGroup:audience"],
      channel: "discord",
      accountId: "default",
      senderId: "discord:123",
      resolveMembership: async () => {
        throw new Error("discord lookup failed");
      },
    });
    expect(failedState.referenced).toEqual(["audience"]);
    expect(failedState.failed).toEqual(["audience"]);
    expect(failedState.hasMatch).toBe(false);

    await expect(
      expandAllowFromWithAccessGroups({
        cfg,
        allowFrom: ["accessGroup:admins"],
        channel: "test",
        accountId: "default",
        senderId: "local",
        isSenderAllowed: (senderId, allowFrom) => allowFrom.includes(senderId),
      }),
    ).resolves.toEqual(["accessGroup:admins", "local"]);
  });
});
