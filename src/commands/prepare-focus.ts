import ts from "typescript";
import { resolve } from "node:path";
import { Cache, profileFingerprint } from "../cache";
import type { SqlxJsConfig } from "../config";
import { enumCatalogCacheExists } from "../enum-catalog";
import { functionCacheExists } from "../function-cache";
import { queryId } from "../query-id";
import { scanProject, type QueryCallSite } from "../scan/scanner";
import type { PrepareIncrementalInput } from "./prepare";

export type PrepareFocus = {
  include: readonly string[];
  query: readonly string[];
};

export type FocusedPrepareSelection = {
  input: PrepareIncrementalInput;
  projectSites: number;
  selectedSites: number;
  omittedSites: number;
  omittedContracts: number;
};

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"];

export function assertFocusedPrepareCatalogs(config: SqlxJsConfig, cacheDir: string): void {
  if (config.functionCatalog !== false && !functionCacheExists(cacheDir)) {
    throw new Error(
      "sqlx-js focused prepare: function catalog cache is missing; run a full `sqlx-js prepare`",
    );
  }
  if (config.enumCatalog && !enumCatalogCacheExists(cacheDir)) {
    throw new Error(
      "sqlx-js focused prepare: enum catalog cache is missing; run a full `sqlx-js prepare`",
    );
  }
}

export function selectFocusedPrepareInput(
  root: string,
  config: SqlxJsConfig,
  cacheDir: string,
  focus: PrepareFocus,
): FocusedPrepareSelection {
  const projectSites = scanProject(root, config.scan, config.profiles ?? {});
  const selectedFiles = focus.include.length === 0
    ? undefined
    : new Set(ts.sys.readDirectory(root, SOURCE_EXTENSIONS, undefined, [...focus.include]).map((file) => resolve(file)));
  const querySelectors = new Set(focus.query);
  const selected = projectSites.filter((site) =>
    (selectedFiles === undefined || selectedFiles.has(resolve(root, site.file)))
    && (querySelectors.size === 0 || querySelectors.has(site.queryName ?? "") || querySelectors.has(queryId(site.query)))
  );
  if (selected.length === 0) {
    throw new Error("sqlx-js focused prepare: no query sites matched the requested selectors");
  }

  const selectedFingerprints = new Set(selected.flatMap(siteFingerprints));
  const cache = new Cache(cacheDir);
  const sites: QueryCallSite[] = [];
  const reuseCacheFps = new Set<string>();
  let omittedSites = 0;
  let omittedContracts = 0;

  for (const site of projectSites) {
    if (!site.profiles?.length) {
      const fp = profileFingerprint(undefined, site.query);
      if (selectedFingerprints.has(fp)) {
        sites.push(site);
      } else if (cache.has(fp)) {
        sites.push(site);
        reuseCacheFps.add(fp);
      } else {
        omittedSites++;
        omittedContracts++;
      }
      continue;
    }

    const profiles = site.profiles.filter((profile) => {
      const fp = profileFingerprint(profile, site.query);
      if (selectedFingerprints.has(fp)) return true;
      if (!cache.has(fp)) return false;
      reuseCacheFps.add(fp);
      return true;
    });
    omittedContracts += site.profiles.length - profiles.length;
    if (profiles.length === 0) {
      omittedSites++;
      continue;
    }
    sites.push(profiles.length === site.profiles.length ? site : { ...site, profiles });
  }

  return {
    input: {
      sites,
      reuseCacheFps,
      reuseFunctionCatalog: true,
      reuseEnumCatalog: true,
      artifactComplete: false,
    },
    projectSites: projectSites.length,
    selectedSites: selected.length,
    omittedSites,
    omittedContracts,
  };
}

function siteFingerprints(site: QueryCallSite): string[] {
  return site.profiles?.length
    ? site.profiles.map((profile) => profileFingerprint(profile, site.query))
    : [profileFingerprint(undefined, site.query)];
}
