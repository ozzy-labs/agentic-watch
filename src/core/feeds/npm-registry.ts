import type { Item, Source } from "../../schemas/index.js";
import { ItemSchema } from "../../schemas/index.js";
import { deriveItemId, deriveStableKey } from "./derive-id.js";
import type { FeedAdapter, FeedAdapterOptions, FetchLike } from "./types.js";

const USER_AGENT = "agentic-watch/0.0.0 (+https://github.com/ozzy-labs/agentic-watch)";
const REGISTRY_BASE = "https://registry.npmjs.org";

/**
 * Subset of the npm registry packument we touch. The registry response
 * contains far more fields (dist, maintainers, deprecated, …) which we keep
 * inside `Item.raw` for downstream consumers without pinning their schema.
 */
interface NpmPackument {
  name?: string;
  versions?: Record<string, NpmPackumentVersion | undefined>;
  time?: Record<string, string | undefined>;
}

interface NpmPackumentVersion {
  name?: string;
  version?: string;
  description?: string;
}

/**
 * Extract the canonical npm package name from a source URL.
 *
 * Accepts both the bare-package form (`@scope/pkg` or `pkg`) and the public
 * npmjs.com URL form (`https://www.npmjs.com/package/<pkg>` /
 * `https://npmjs.com/package/<pkg>`). The latter is the only shape the strict
 * `z.string().url()` validator used to accept, but per #38 the user-guide
 * documents both forms; the schema now relaxes the constraint for
 * `kind: "npm-registry"` so the helper here is the single place that knows
 * about the two shapes.
 *
 * Returns `undefined` for inputs that look like an HTTP(S) URL but do not
 * point at an npm package, so the caller can surface a clear error.
 */
export function extractPackageName(rawUrl: string): string | undefined {
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0) return undefined;
  // URL form: pull the path segment after `/package/`.
  if (/^https?:\/\//i.test(trimmed)) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return undefined;
    }
    const host = parsed.host.toLowerCase();
    if (host !== "npmjs.com" && host !== "www.npmjs.com") return undefined;
    // `/package/<pkg>` and `/package/<pkg>/v/<version>` are both valid; strip
    // anything after the package segment.
    const match = parsed.pathname.match(/^\/package\/((?:@[^/]+\/)?[^/]+)/);
    if (!match) return undefined;
    return decodeURIComponent(match[1] ?? "") || undefined;
  }
  // Bare-package form.
  return trimmed;
}

/**
 * Compose the `https://registry.npmjs.org/<pkg>` URL.
 *
 * Scoped packages must keep their `@` and slash *unescaped* — the npm registry
 * routes `@scope%2fname` and `@scope/name` differently and only the latter
 * resolves. `encodeURIComponent` would mangle the slash, so we pass the name
 * through verbatim.
 */
export function buildMetadataUrl(packageName: string): string {
  return `${REGISTRY_BASE}/${packageName}`;
}

/**
 * Compose the canonical `Item.url` for a specific package version.
 *
 * Always uses `www.npmjs.com` (matches the redirect target of the bare
 * `npmjs.com` host) so re-derivation across re-fetches stays byte-stable.
 */
function buildItemUrl(packageName: string, version: string): string {
  return `https://www.npmjs.com/package/${packageName}/v/${version}`;
}

/** Convert ISO datetime strings from `time[<version>]` into normalized form. */
function toIsoDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}

/**
 * Normalize one `<package>@<version>` entry into our `Item` shape.
 *
 * `Item.id` is derived via the shared helper so npm-registry items follow the
 * same `<slug>-<8 hex>` contract as RSS / Atom items (ADR-0002 §Item ID 派生
 * のコントラクト). The slug source is `<package>@<version>` so ids remain
 * human-readable in CLI listings.
 */
function buildItem(
  packument: NpmPackument,
  packageName: string,
  version: string,
  source: Source,
  fetchedAt: string,
): Item | null {
  const versionMeta = packument.versions?.[version];
  // Drop a version when the packument lies about claiming it but the entry is
  // missing — the registry sometimes lists tombstoned versions in `time` but
  // omits them from `versions`. Skipping rather than erroring keeps the run
  // green for ordinary feeds.
  if (!versionMeta) return null;
  const stableKey = deriveStableKey({
    publisherId: `${packageName}@${version}`,
  });
  const title = `${packageName}@${version}`;
  const id = deriveItemId(title, stableKey);
  const candidate: Record<string, unknown> = {
    id,
    sourceId: source.id,
    title,
    url: buildItemUrl(packageName, version),
    fetchedAt,
    publishedAt: toIsoDate(packument.time?.[version]),
    summary: versionMeta.description,
    raw: { package: packageName, version, ...versionMeta },
  };
  const result = ItemSchema.safeParse(candidate);
  // Mirror the rss adapter: drop malformed entries silently rather than
  // failing the whole feed for one bad version.
  return result.success ? result.data : null;
}

/**
 * Parse an npm registry packument response into validated `Item[]`.
 *
 * The exported function exists so tests can exercise the normalizer without
 * round-tripping through the HTTP layer (matching `parseFeedXml` in
 * `rss.ts`).
 */
export function parsePackument(
  body: string,
  source: Source,
  fetchedAt: string,
  packageName: string,
): Item[] {
  let parsed: NpmPackument;
  try {
    parsed = JSON.parse(body) as NpmPackument;
  } catch (e) {
    throw new Error(
      `npm-registry adapter: failed to parse JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const versions = parsed.versions;
  if (!versions) return [];
  const items: Item[] = [];
  for (const version of Object.keys(versions)) {
    const item = buildItem(parsed, packageName, version, source, fetchedAt);
    if (item) items.push(item);
  }
  return items;
}

/**
 * Fetch the npm registry packument with ETag-aware conditional GET.
 *
 * The registry honors `If-None-Match` and replies 304 for unchanged
 * packuments, which is how we keep `watch run` cheap for stable packages.
 */
async function fetchPackument(
  url: string,
  fetchImpl: FetchLike,
  options: { etag?: string; signal?: AbortSignal } = {},
): Promise<{ status: number; body: string; etag: string | null }> {
  const headers: Record<string, string> = {
    accept: "application/json",
    "user-agent": USER_AGENT,
  };
  if (options.etag) headers["if-none-match"] = options.etag;

  const response = await fetchImpl(url, { headers, signal: options.signal });
  const etag = response.headers.get("etag");
  if (response.status === 304) {
    return { status: 304, body: "", etag };
  }
  if (response.status === 404) {
    throw new Error(`npm-registry adapter: package not found (HTTP 404) at ${url}`);
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`npm-registry adapter: HTTP ${response.status} from ${url}`);
  }
  const body = await response.text();
  return { status: response.status, body, etag };
}

export const npmRegistryAdapter: FeedAdapter = {
  kind: "npm-registry",
  fetch: async (source: Source, options: FeedAdapterOptions = {}) => {
    const fetchImpl = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
    if (typeof fetchImpl !== "function") {
      throw new Error(
        "npm-registry adapter: no fetch implementation available (Node 22+ required)",
      );
    }
    const packageName = extractPackageName(source.url);
    if (!packageName) {
      throw new Error(
        `npm-registry adapter: cannot extract package name from url '${source.url}' ` +
          "(expected '<package>' or 'https://www.npmjs.com/package/<package>')",
      );
    }
    const previous = options.state;
    const fetchedAt = new Date().toISOString();
    const response = await fetchPackument(buildMetadataUrl(packageName), fetchImpl, {
      etag: previous?.lastEtag,
    });
    if (response.status === 304) {
      return {
        items: [],
        notModified: true,
        state: {
          lastFetchedAt: fetchedAt,
          lastEtag: response.etag ?? previous?.lastEtag,
        },
      };
    }
    const items = parsePackument(response.body, source, fetchedAt, packageName);
    return {
      items,
      state: {
        lastFetchedAt: fetchedAt,
        lastEtag: response.etag ?? previous?.lastEtag,
      },
    };
  },
};
