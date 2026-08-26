/**
 * Channel allowFrom policy helpers.
 *
 * Merges DM/group allowlists and checks normalized sender entries.
 */
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import type { AccessGroupConfig } from "../config/types.access-groups.js";
import type { ChannelId } from "./plugins/types.public.js";

/**
 * Prefix that marks an allowFrom entry as an access-group reference instead of a sender id.
 */
export const ACCESS_GROUP_ALLOW_FROM_PREFIX = "accessGroup:";

/**
 * Parses an access-group allowFrom entry and returns the referenced group name.
 */
export function parseAccessGroupAllowFromEntry(entry: string): string | null {
  const trimmed = entry.trim();
  if (!trimmed.startsWith(ACCESS_GROUP_ALLOW_FROM_PREFIX)) {
    return null;
  }
  const name = trimmed.slice(ACCESS_GROUP_ALLOW_FROM_PREFIX.length).trim();
  return name.length > 0 ? name : null;
}

/** Projects statically enumerable access-group references into concrete channel sender entries. */
export function projectStaticAccessGroupAllowFrom(params: {
  accessGroups?: Record<string, AccessGroupConfig>;
  allowFrom?: Array<string | number> | null;
  channel: ChannelId;
}): { concreteEntries: string[]; unresolvedReferences: string[] } {
  const concreteEntries: string[] = [];
  const unresolvedReferences: string[] = [];
  for (const entry of normalizeStringEntries(params.allowFrom ?? [])) {
    const name = parseAccessGroupAllowFromEntry(entry);
    if (!name) {
      if (entry.startsWith(ACCESS_GROUP_ALLOW_FROM_PREFIX)) {
        unresolvedReferences.push(entry);
      } else {
        concreteEntries.push(entry);
      }
      continue;
    }
    const group = params.accessGroups?.[name];
    if (!group || group.type !== "message.senders") {
      unresolvedReferences.push(entry);
      continue;
    }
    concreteEntries.push(...(group.members["*"] ?? []), ...(group.members[params.channel] ?? []));
  }
  return {
    concreteEntries: normalizeStringEntries(concreteEntries),
    unresolvedReferences: normalizeStringEntries(unresolvedReferences),
  };
}

/**
 * Merges configured DM allowFrom entries with pairing-store sender ids when policy allows it.
 */
export function mergeDmAllowFromSources(params: {
  allowFrom?: Array<string | number>;
  storeAllowFrom?: Array<string | number>;
  dmPolicy?: string;
}): string[] {
  const storeEntries =
    params.dmPolicy === "allowlist" || params.dmPolicy === "open"
      ? []
      : (params.storeAllowFrom ?? []);
  return normalizeStringEntries([...(params.allowFrom ?? []), ...storeEntries]);
}

/**
 * Resolves the allowFrom entries used for group chats, optionally falling back to DM policy.
 */
export function resolveGroupAllowFromSources(params: {
  allowFrom?: Array<string | number>;
  groupAllowFrom?: Array<string | number>;
  fallbackToAllowFrom?: boolean;
}): string[] {
  const explicitGroupAllowFrom =
    Array.isArray(params.groupAllowFrom) && params.groupAllowFrom.length > 0
      ? params.groupAllowFrom
      : undefined;
  const scoped = explicitGroupAllowFrom
    ? explicitGroupAllowFrom
    : params.fallbackToAllowFrom === false
      ? []
      : (params.allowFrom ?? []);
  return normalizeStringEntries(scoped);
}

/**
 * Returns the first value that is present, preserving falsy values such as false, 0, and "".
 */
export function firstDefined<T>(...values: Array<T | undefined>) {
  for (const value of values) {
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

/**
 * Checks a normalized sender allowlist with wildcard and empty-list policy handling.
 */
export function isSenderIdAllowed(
  allow: { entries: string[]; hasWildcard: boolean; hasEntries: boolean },
  senderId: string | undefined,
  allowWhenEmpty: boolean,
): boolean {
  if (!allow.hasEntries) {
    return allowWhenEmpty;
  }
  if (allow.hasWildcard) {
    return true;
  }
  // A non-empty allowlist without wildcard needs a concrete sender id match.
  if (!senderId) {
    return false;
  }
  return allow.entries.includes(senderId);
}
