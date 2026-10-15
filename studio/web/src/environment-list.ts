/**
 * The Environments list, grouped by the environment manifest each was made from, as the
 * session list is by agent: `/environments?manifest=<name>` is the list filtered to one
 * manifest, and `?manifest=-` to those made from inline fields. `?label=key=value`, repeated,
 * keeps only the Environments with every label. No React here, so `node --test` covers it.
 */
import type { EnvironmentManifestView, EnvironmentView } from "@nylorun/agents";

/** The query parameter of `/environments` that filters the list to one manifest. */
export const MANIFEST_FILTER = "manifest";
/** The query parameter of `/environments` that keeps only Environments with a label. */
export const LABEL_FILTER = "label";
/**
 * The manifest filter for Environments made from inline fields: never a manifest's name, which
 * starts with a letter or digit.
 */
export const INLINE_MANIFEST = "-";

/** What the list is filtered on: one manifest (or inline fields), and labels. */
export type EnvironmentFilter = {
  manifest?: string;
  labels: readonly string[];
};

/** `/environments`, filtered to a manifest and labels when given. */
export function environmentsPath(filter: Partial<EnvironmentFilter> = {}): string {
  const query = new URLSearchParams();
  if (filter.manifest !== undefined) query.set(MANIFEST_FILTER, filter.manifest);
  for (const label of filter.labels ?? []) query.append(LABEL_FILTER, label);
  const text = query.toString();
  return text ? `/environments?${text}` : "/environments";
}

/** The filter `search` names; a label that is not `key=value` is ignored. */
export function environmentFilter(search: string): EnvironmentFilter {
  const query = new URLSearchParams(search);
  const manifest = query.get(MANIFEST_FILTER) || undefined;
  return {
    ...(manifest === undefined ? {} : { manifest }),
    labels: query.getAll(LABEL_FILTER).filter((label) => label.indexOf("=") > 0),
  };
}

/** The manifest an Environment was made from, or `INLINE_MANIFEST`. */
export function manifestOf(environment: Pick<EnvironmentView, "manifestName">): string {
  return environment.manifestName ?? INLINE_MANIFEST;
}

/** `key=value` for each of an Environment's labels, in key order. */
export function labelsOf(environment: Pick<EnvironmentView, "labels">): string[] {
  return Object.entries(environment.labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`);
}

/** The Environments the filter keeps, in the order given. */
export function filterEnvironments<
  T extends Pick<EnvironmentView, "manifestName" | "labels">,
>(environments: readonly T[], filter: EnvironmentFilter): T[] {
  return environments.filter((environment) => {
    if (filter.manifest !== undefined && manifestOf(environment) !== filter.manifest)
      return false;
    return filter.labels.every((label) => {
      const at = label.indexOf("=");
      return environment.labels[label.slice(0, at)] === label.slice(at + 1);
    });
  });
}

/** A manifest the list can filter on, with its number of Environments. */
export type EnvironmentGroup = {
  /** The manifest's name, or `INLINE_MANIFEST`. */
  id: string;
  name: string;
  /** Its latest saved version; absent for inline fields and a manifest not listed. */
  manifest?: EnvironmentManifestView;
  count: number;
};

/**
 * Each saved manifest by name, then any other manifest an Environment names, then inline fields
 * when an Environment was made from them, with their numbers of Environments.
 */
export function environmentGroups(
  manifests: readonly EnvironmentManifestView[],
  environments: readonly Pick<EnvironmentView, "manifestName">[],
): EnvironmentGroup[] {
  const counts = new Map<string, number>();
  for (const environment of environments) {
    const id = manifestOf(environment);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const groups: EnvironmentGroup[] = [...manifests]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((manifest) => ({
      id: manifest.name,
      name: manifest.name,
      manifest,
      count: counts.get(manifest.name) ?? 0,
    }));
  const listed = new Set(groups.map((group) => group.id));
  for (const [id, count] of [...counts].sort(([a], [b]) => a.localeCompare(b)))
    if (id !== INLINE_MANIFEST && !listed.has(id)) groups.push({ id, name: id, count });
  const inline = counts.get(INLINE_MANIFEST);
  if (inline) groups.push({ id: INLINE_MANIFEST, name: "Inline fields", count: inline });
  return groups;
}
