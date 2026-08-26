/** Merges configured and persisted allowFrom entries for channel security audit. */
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import type { AccessGroupConfig } from "../../config/types.access-groups.js";
import { projectStaticAccessGroupAllowFrom } from "../allow-from.js";
import type { ChannelId } from "../plugins/types.public.js";
import { readChannelIngressStoreAllowFromForDmPolicy } from "./store-allow-from.js";

export async function resolveDmAllowAuditState(params: {
  provider: ChannelId;
  accountId: string;
  accessGroups?: Record<string, AccessGroupConfig>;
  allowFrom?: Array<string | number> | null;
  dmPolicy?: string | null;
  normalizeEntry?: (raw: string) => string;
  readStore?: (provider: ChannelId, accountId: string) => Promise<string[]>;
}) {
  const projection = projectStaticAccessGroupAllowFrom({
    accessGroups: params.accessGroups,
    allowFrom: params.allowFrom,
    channel: params.provider,
  });
  const configAllowFrom = projection.concreteEntries;
  const hasWildcard = configAllowFrom.includes("*");
  const storeAllowFrom = await readChannelIngressStoreAllowFromForDmPolicy({
    provider: params.provider,
    accountId: params.accountId,
    dmPolicy: params.dmPolicy,
    readStore: params.readStore,
  });
  const normalizeEntry = params.normalizeEntry ?? ((value: string) => value);
  const normalizedCfg = normalizeStringEntries(
    configAllowFrom.filter((value) => value !== "*").map((value) => normalizeEntry(value)),
  );
  const normalizedStore = normalizeStringEntries(
    storeAllowFrom.map((value) => normalizeEntry(value)),
  );
  const admittedPrincipals = Array.from(new Set([...normalizedCfg, ...normalizedStore]));
  return {
    hasWildcard,
    admittedPrincipals,
    hasUnresolvedAccessGroups: projection.unresolvedReferences.length > 0,
  };
}
