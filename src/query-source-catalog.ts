import { queryId } from "./query-id";
import type { QueryCallSite } from "./scan/scanner";

export type QuerySourceGroup = {
  queryId: string;
  query: string;
  sites: QueryCallSite[];
};

export function buildQuerySourceCatalog(sites: readonly QueryCallSite[]): QuerySourceGroup[] {
  const groups = new Map<string, QueryCallSite[]>();
  for (const site of sites) {
    const id = queryId(site.query);
    const group = groups.get(id) ?? [];
    group.push(site);
    groups.set(id, group);
  }
  return [...groups.entries()]
    .map(([id, group]) => {
      const sortedSites = [...group].sort(compareQuerySourceSites);
      return {
        queryId: id,
        query: sortedSites[0]!.query,
        sites: sortedSites,
      };
    })
    .sort((left, right) => left.queryId.localeCompare(right.queryId));
}

export function compareQuerySourceSites(left: QueryCallSite, right: QueryCallSite): number {
  return left.file.localeCompare(right.file) || left.line - right.line || left.column - right.column;
}

export function querySourceLocation(site: QueryCallSite): string {
  return `${site.file}:${site.line}:${site.column}`;
}
