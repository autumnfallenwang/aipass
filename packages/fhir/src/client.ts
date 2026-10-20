import type { Bundle, Resource } from "./types.ts";

export class FhirError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = "FhirError";
  }
}

export type FhirClientOptions = {
  baseUrl: string;
  /** The gateway's own credential for the FHIR server. Never the agent's. */
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

/** A small FHIR REST client. It only talks to `baseUrl`. */
export class FhirClient {
  readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly doFetch: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: FhirClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.headers = { accept: "application/fhir+json", ...opts.headers };
    this.doFetch = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  /** True when `url` points at this server (used to vet paging links). */
  owns(url: string): boolean {
    try {
      const u = new URL(url);
      const b = new URL(this.baseUrl);
      return (
        u.origin === b.origin &&
        (u.pathname === b.pathname || u.pathname.startsWith(`${b.pathname}/`))
      );
    } catch {
      return false;
    }
  }

  private async request<T>(method: string, url: string, body?: unknown): Promise<T> {
    // No URLs in the message: an upstream base URL can carry settings that belong in no log.
    if (!this.owns(url)) throw new FhirError("refusing to call a URL outside the FHIR server", 0);
    const res = await this.doFetch(url, {
      method,
      headers: body ? { ...this.headers, "content-type": "application/fhir+json" } : this.headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    if (!res.ok)
      throw new FhirError(`FHIR ${method} ${res.status}`, res.status, text.slice(0, 2000));
    return (text ? JSON.parse(text) : {}) as T;
  }

  search(resourceType: string, params: URLSearchParams): Promise<Bundle> {
    return this.request<Bundle>("GET", `${this.baseUrl}/${resourceType}?${params.toString()}`);
  }

  /** Follows a paging link the server returned. */
  page(url: string): Promise<Bundle> {
    return this.request<Bundle>("GET", url);
  }

  async read(resourceType: string, id: string): Promise<Resource | null> {
    try {
      return await this.request<Resource>(
        "GET",
        `${this.baseUrl}/${resourceType}/${encodeURIComponent(id)}`,
      );
    } catch (err) {
      if (err instanceof FhirError && (err.status === 404 || err.status === 410)) return null;
      throw err;
    }
  }

  create(resource: Resource): Promise<Resource> {
    return this.request<Resource>("POST", `${this.baseUrl}/${resource.resourceType}`, resource);
  }

  update(resource: Resource): Promise<Resource> {
    if (!resource.id) throw new FhirError("update needs an id", 0);
    return this.request<Resource>(
      "PUT",
      `${this.baseUrl}/${resource.resourceType}/${encodeURIComponent(resource.id)}`,
      resource,
    );
  }

  /** A transaction or batch bundle. */
  transaction(bundle: Bundle): Promise<Bundle> {
    return this.request<Bundle>("POST", this.baseUrl, bundle);
  }
}
