import type { SessionsSearchResult } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import type { SessionListOptions } from "./index.ts";
import { fetchPagedSessionRows } from "./paged-session-rows.ts";

type VisibleSessionTranscriptSearchResult = SessionsSearchResult & {
  sessions: GatewaySessionRow[];
};

export async function searchVisibleSessionTranscripts(params: {
  client: GatewayBrowserClient;
  query: string;
  result?: SessionsListResult | null;
  listSessions: (options: SessionListOptions) => Promise<SessionsListResult | null>;
  listOptions: SessionListOptions;
  resolveAgentId: (sessionKey: string) => string | undefined;
  isCurrent?: () => boolean;
  mapPageRows?: (rows: GatewaySessionRow[]) => GatewaySessionRow[];
}): Promise<VisibleSessionTranscriptSearchResult> {
  const protocolKeyLimit = 200;
  const sessions = await fetchPagedSessionRows({
    initialResult: params.result,
    list: (offset) =>
      params.listSessions({
        ...params.listOptions,
        limit: protocolKeyLimit,
        offset,
      }),
    isCurrent: params.isCurrent,
    mapPageRows: params.mapPageRows,
    missingResultError: "Unable to load all sessions for transcript search.",
    stalledPaginationError: "Session pagination did not advance during transcript search.",
  });
  const visibleSessions = sessions ?? [];
  const keysByAgent = new Map<string, string[]>();
  for (const row of visibleSessions) {
    const agentId = params.resolveAgentId(row.key);
    if (!agentId) {
      continue;
    }
    const keys = keysByAgent.get(agentId) ?? [];
    keys.push(row.key);
    keysByAgent.set(agentId, keys);
  }
  const requests: Array<Promise<SessionsSearchResult>> = [];
  for (const [agentId, sessionKeys] of keysByAgent) {
    for (let index = 0; index < sessionKeys.length; index += protocolKeyLimit) {
      requests.push(
        params.client.request<SessionsSearchResult>("sessions.search", {
          agentId,
          sessionKeys: sessionKeys.slice(index, index + protocolKeyLimit),
          query: params.query,
          limit: 25,
        }),
      );
    }
  }
  const pages = await Promise.all(requests);
  const results = pages
    .flatMap((page) => page.results)
    .toSorted((left, right) => right.score - left.score || right.timestamp - left.timestamp)
    .slice(0, 25);
  return {
    sessions: visibleSessions,
    results,
    indexing: pages.some((page) => page.indexing === true),
    truncated:
      pages.some((page) => page.truncated === true) ||
      pages.reduce((total, page) => total + page.results.length, 0) > results.length,
  };
}
