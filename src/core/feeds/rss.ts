import { XMLParser } from "fast-xml-parser";
import type { Item, Source } from "../../schemas/index.js";
import { ItemSchema } from "../../schemas/index.js";
import { deriveItemId, deriveStableKey } from "./derive-id.js";
import type { FeedAdapter, FeedAdapterOptions, FetchLike } from "./types.js";

const USER_AGENT = "feedradar/0.0.0 (+https://github.com/ozzy-labs/feedradar)";

/**
 * Parsed shape after `fast-xml-parser` is finished — we only annotate the
 * fields we touch so the rest of the upstream XML is allowed to be `unknown`.
 */
interface RssChannelLike {
  rss?: {
    channel?: {
      item?: RssItemLike | RssItemLike[];
    };
  };
  feed?: {
    entry?: AtomEntryLike | AtomEntryLike[];
  };
}

interface RssItemLike {
  title?: string | { "#text"?: string };
  link?: string | { "#text"?: string; "@_href"?: string };
  guid?: string | { "#text"?: string; "@_isPermaLink"?: string };
  description?: string | { "#text"?: string };
  pubDate?: string;
  "dc:date"?: string;
}

interface AtomEntryLike {
  title?: string | { "#text"?: string };
  link?: string | { "@_href"?: string } | Array<{ "@_href"?: string; "@_rel"?: string }>;
  id?: string;
  summary?: string | { "#text"?: string };
  content?: string | { "#text"?: string };
  published?: string;
  updated?: string;
}

/** Coerce an `fast-xml-parser` text-or-object to a plain string. */
function asString(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const text = obj["#text"];
    if (typeof text === "string") return text.trim() || undefined;
  }
  return undefined;
}

/** Atom `<link rel="alternate" href="…"/>` resolution. */
function pickAtomLink(link: AtomEntryLike["link"]): string | undefined {
  if (!link) return undefined;
  if (typeof link === "string") return link;
  if (Array.isArray(link)) {
    const alt = link.find((l) => (l["@_rel"] ?? "alternate") === "alternate");
    return alt?.["@_href"];
  }
  return link["@_href"];
}

/** RSS `<link>` can be a simple URL or `{ "#text": "...", "@_href": "..." }`. */
function pickRssLink(link: RssItemLike["link"]): string | undefined {
  if (!link) return undefined;
  if (typeof link === "string") return link.trim() || undefined;
  if (typeof link === "object") {
    return link["@_href"] ?? asString(link);
  }
  return undefined;
}

/** Convert RSS `pubDate` / Atom `published` into ISO 8601 string. */
function toIsoDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}

/**
 * Derive a stable, filesystem- and CLI-friendly id for an RSS/Atom entry.
 *
 * Delegates the actual format (`<title-slug>-<8 hex of sha256(stableKey)>`)
 * and the publisher-id-first fallback ladder (guid > url > sha1(title|pub))
 * to the shared helpers in `./derive-id.ts`, which all feed adapters use so
 * that ids stay byte-stable across adapter kinds (see ADR-0002).
 *
 * The publisher's original guid is preserved in `Item.raw` (the full
 * upstream entry is stored), so no information is lost. See issue #23.
 */
function deriveId(
  guid: string | undefined,
  url: string | undefined,
  title: string | undefined,
  pub: string | undefined,
): string {
  const stableKey = deriveStableKey({
    publisherId: guid,
    url,
    fallbackHashInputs: [title, pub],
  });
  return deriveItemId(title, stableKey);
}

/** Normalize one RSS 2.0 `<item>` into our `Item` shape. */
function parseRssItem(raw: RssItemLike, source: Source, fetchedAt: string): Item | null {
  const title = asString(raw.title) ?? "";
  const url = pickRssLink(raw.link);
  if (!url) return null;
  const summary = asString(raw.description);
  const publishedAt = toIsoDate(raw.pubDate ?? raw["dc:date"]);
  const guid = asString(raw.guid);
  const id = deriveId(guid, url, title, raw.pubDate);
  return validateItem({
    id,
    sourceId: source.id,
    title,
    url,
    summary,
    publishedAt,
    fetchedAt,
    raw,
  });
}

/** Normalize one Atom `<entry>` into our `Item` shape. */
function parseAtomEntry(raw: AtomEntryLike, source: Source, fetchedAt: string): Item | null {
  const title = asString(raw.title) ?? "";
  const url = pickAtomLink(raw.link);
  if (!url) return null;
  const summary = asString(raw.summary) ?? asString(raw.content);
  const publishedAt = toIsoDate(raw.published ?? raw.updated);
  const id = deriveId(raw.id, url, title, raw.published ?? raw.updated);
  return validateItem({
    id,
    sourceId: source.id,
    title,
    url,
    summary,
    publishedAt,
    fetchedAt,
    raw,
  });
}

function validateItem(candidate: Record<string, unknown>): Item | null {
  const result = ItemSchema.safeParse(candidate);
  // Items that fail validation (malformed URL etc.) are dropped silently — the
  // alternative is failing the whole feed for one bad entry, which surprises
  // users running large feeds where one broken entry is common.
  return result.success ? result.data : null;
}

/**
 * Parse an RSS 2.0 or Atom XML document into validated `Item[]`.
 *
 * `fast-xml-parser` is intentionally configured to keep attribute prefixes
 * (`@_href`) and skip CDATA stripping so we can route through the same
 * normalizer regardless of which dialect we are reading.
 */
export function parseFeedXml(xml: string, source: Source, fetchedAt: string): Item[] {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    textNodeName: "#text",
    trimValues: true,
    parseTagValue: false,
    parseAttributeValue: false,
  });
  let parsed: RssChannelLike;
  try {
    parsed = parser.parse(xml) as RssChannelLike;
  } catch (e) {
    throw new Error(
      `rss adapter: failed to parse XML: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  // RSS 2.0 path
  if (parsed.rss?.channel?.item) {
    const items = Array.isArray(parsed.rss.channel.item)
      ? parsed.rss.channel.item
      : [parsed.rss.channel.item];
    return items
      .map((entry) => parseRssItem(entry, source, fetchedAt))
      .filter((i): i is Item => i !== null);
  }
  // Atom path
  if (parsed.feed?.entry) {
    const entries = Array.isArray(parsed.feed.entry) ? parsed.feed.entry : [parsed.feed.entry];
    return entries
      .map((entry) => parseAtomEntry(entry, source, fetchedAt))
      .filter((i): i is Item => i !== null);
  }

  // No recognized envelope. Return [] rather than throw — empty feeds are a
  // valid response and we should not poison the state with an error.
  return [];
}

/**
 * Issue an HTTP GET with conditional headers, honoring previously stored
 * `ETag` / `Last-Modified` so well-behaved servers can reply 304 and let us
 * skip parsing work.
 */
async function fetchFeed(
  url: string,
  fetchImpl: FetchLike,
  options: { etag?: string; lastModified?: string; signal?: AbortSignal } = {},
): Promise<{ status: number; body: string; etag: string | null; lastModified: string | null }> {
  const headers: Record<string, string> = {
    accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.5",
    "user-agent": USER_AGENT,
  };
  if (options.etag) headers["if-none-match"] = options.etag;
  if (options.lastModified) headers["if-modified-since"] = options.lastModified;

  const response = await fetchImpl(url, { headers, signal: options.signal });
  const etag = response.headers.get("etag");
  const lastModified = response.headers.get("last-modified");
  if (response.status === 304) {
    return { status: 304, body: "", etag, lastModified };
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`rss adapter: HTTP ${response.status} from ${url}`);
  }
  const body = await response.text();
  return { status: response.status, body, etag, lastModified };
}

export const rssAdapter: FeedAdapter = {
  kind: "rss",
  fetch: async (source: Source, options: FeedAdapterOptions = {}) => {
    const fetchImpl = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
    if (typeof fetchImpl !== "function") {
      throw new Error("rss adapter: no fetch implementation available (Node 22+ required)");
    }
    const previous = options.state;
    const fetchedAt = new Date().toISOString();
    const response = await fetchFeed(source.url, fetchImpl, {
      etag: previous?.lastEtag,
      lastModified: previous?.lastModified,
    });
    if (response.status === 304) {
      return {
        items: [],
        notModified: true,
        state: {
          lastFetchedAt: fetchedAt,
          lastEtag: response.etag ?? previous?.lastEtag,
          lastModified: response.lastModified ?? previous?.lastModified,
        },
      };
    }
    const items = parseFeedXml(response.body, source, fetchedAt);
    return {
      items,
      state: {
        lastFetchedAt: fetchedAt,
        lastEtag: response.etag ?? previous?.lastEtag,
        lastModified: response.lastModified ?? previous?.lastModified,
      },
    };
  },
};
