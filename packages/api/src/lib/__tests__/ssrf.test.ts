import { afterEach, describe, it, expect, vi } from "vitest";
import http from "node:http";
import { EventEmitter } from "node:events";
import type { AddressInfo } from "node:net";

const dns = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: dns.lookup }));
const https = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("node:https", () => ({ request: https.request }));

import {
  assertSafeExternalUrl,
  buildPinnedRequestOptions,
  safeExternalFetch,
  SsrfError,
} from "../ssrf";

const servers: http.Server[] = [];

afterEach(async () => {
  dns.lookup.mockReset();
  https.request.mockReset();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
});

interface MockHttpsResponse {
  status: number;
  headers?: Record<string, string>;
  body?: string | Buffer;
}

function mockHttpsResponses(responses: MockHttpsResponse[]): Array<{
  options: Record<string, unknown>;
  body: unknown;
}> {
  const observations: Array<{ options: Record<string, unknown>; body: unknown }> = [];
  const queue = [...responses];
  https.request.mockImplementation((options, callback) => {
    const request = new EventEmitter() as EventEmitter & {
      end: (body?: unknown) => void;
    };
    request.end = (body?: unknown) => {
      observations.push({ options, body });
      const response = queue.shift();
      if (!response) throw new Error("No hermetic HTTPS response configured");
      const message = new EventEmitter() as EventEmitter & {
        rawHeaders: string[];
        statusCode: number;
        statusMessage: string;
        destroy: ReturnType<typeof vi.fn>;
      };
      message.rawHeaders = Object.entries(response.headers ?? {}).flatMap(([key, value]) => [key, value]);
      message.statusCode = response.status;
      message.statusMessage = "TEST";
      message.destroy = vi.fn();
      callback(message);
      queueMicrotask(() => {
        if (response.body !== undefined) message.emit("data", response.body);
        message.emit("end");
      });
    };
    return request;
  });
  return observations;
}

async function listen(handler: http.RequestListener): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: (server.address() as AddressInfo).port };
}

// Literal-IP cases skip DNS, so these are hermetic (no network). Focus on the
// IPv4-mapped IPv6 hex bypass the second-pass review found: `new URL` emits
// the host as `::ffff:a9fe:a9fe` (hex), not dotted-decimal.
describe("assertSafeExternalUrl — IPv4-mapped IPv6 hex bypass (FINDINGS C1 second-pass)", () => {
  it("blocks hex-mapped internal/metadata literals", async () => {
    for (const u of [
      "http://[::ffff:169.254.169.254]/latest/meta-data/", // a9fe:a9fe
      "http://[::ffff:127.0.0.1]:5432/", // 7f00:1
      "http://[::ffff:10.0.0.1]/", // a00:1
      "http://[::ffff:192.168.0.1]/", // c0a8:1
    ]) {
      await expect(assertSafeExternalUrl(u), u).rejects.toBeInstanceOf(SsrfError);
    }
  });

  it("blocks dotted-decimal mapped + bare internal literals", async () => {
    for (const u of [
      "http://[::ffff:169.254.169.254]/",
      "http://169.254.169.254/",
      "http://127.0.0.1/",
      "http://[::1]/",
    ]) {
      await expect(assertSafeExternalUrl(u), u).rejects.toBeInstanceOf(SsrfError);
    }
  });

  it("allows a mapped PUBLIC address (no false positive)", async () => {
    await expect(assertSafeExternalUrl("https://[::ffff:808:808]/")).resolves.toBeUndefined();
  });

  it("rejects non-http(s) schemes", async () => {
    await expect(assertSafeExternalUrl("file:///etc/passwd")).rejects.toBeInstanceOf(SsrfError);
  });
});

describe("safeExternalFetch — DNS binding and redirects", () => {
  it("rejects cleartext public transport before request preparation or a socket", async () => {
    let requestCount = 0;
    const { port } = await listen((_req, res) => {
      requestCount += 1;
      res.end("unexpected");
    });
    const prepareRequest = vi.fn(() => ({
      headers: { Authorization: "Bearer must-not-materialize" },
    }));
    dns.lookup.mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);

    await expect(safeExternalFetch(
      `http://provider.example:${port}/v1/chat`,
      { method: "POST" },
      { allowLoopback: true, requireHttps: true, prepareRequest },
    )).rejects.toThrow(/https/i);

    expect(prepareRequest).not.toHaveBeenCalled();
    expect(requestCount).toBe(0);
  });

  it("binds the validated address to the socket and preserves the original Host", async () => {
    let observedHost = "";
    const { port } = await listen((req, res) => {
      observedHost = req.headers.host ?? "";
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    });
    dns.lookup
      .mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }])
      .mockResolvedValueOnce([{ address: "169.254.169.254", family: 4 }]);

    const response = await safeExternalFetch(
      `http://provider.example:${port}/v1/models`,
      { method: "GET" },
      { allowLoopback: true },
    );

    expect(await response.json()).toEqual({ ok: true });
    expect(observedHost).toBe(`provider.example:${port}`);
    expect(dns.lookup).toHaveBeenCalledTimes(1);
  });

  it("revalidates a redirect target and blocks cloud metadata before a second request", async () => {
    let requestCount = 0;
    const { port } = await listen((_req, res) => {
      requestCount += 1;
      res.statusCode = 307;
      res.setHeader("location", `http://rebound.example:${port}/metadata`);
      res.end();
    });
    dns.lookup
      .mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }])
      .mockResolvedValueOnce([{ address: "169.254.169.254", family: 4 }]);

    await expect(safeExternalFetch(
      `http://provider.example:${port}/redirect`,
      { method: "GET" },
      { allowLoopback: true },
    )).rejects.toThrow(/cloud-metadata/i);

    expect(requestCount).toBe(1);
    expect(dns.lookup).toHaveBeenCalledTimes(2);
  });

  it("fails closed for private, link-local, loopback and mapped IP literals", async () => {
    for (const url of [
      "http://10.0.0.1/",
      "http://169.254.169.254/",
      "http://127.8.9.10/",
      "http://[fc00::1]/",
      "http://[fe80::1]/",
      "http://[::ffff:a9fe:a9fe]/",
      "http://0.0.0.0/",
      "http://[::]/",
      "http://[ff02::1]/",
      "http://[2001:db8::1]/",
      "http://[2002:a9fe:a9fe::1]/",
    ]) {
      await expect(safeExternalFetch(url), url).rejects.toBeInstanceOf(SsrfError);
    }
  });

  it("retains real global-unicast IPv6 compatibility", async () => {
    await expect(assertSafeExternalUrl("https://[2606:4700:4700::1111]/dns-query"))
      .resolves.toBeUndefined();
  });

  it("pins HTTPS to the validated IP while retaining hostname SNI and Host", () => {
    const options = buildPinnedRequestOptions(
      new URL("https://api.provider.example:8443/v1/chat"),
      { address: "2606:4700:4700::1111", family: 6 },
      { method: "POST", headers: { Authorization: "Bearer test" } },
    );

    expect(options.hostname).toBe("api.provider.example");
    expect(options.servername).toBe("api.provider.example");
    expect(options.headers).toMatchObject({
      authorization: "Bearer test",
      host: "api.provider.example:8443",
    });
    const lookup = options.lookup!;
    const callback = vi.fn();
    lookup("api.provider.example", {}, callback);
    expect(callback).toHaveBeenCalledWith(null, "2606:4700:4700::1111", 6);
  });
});

describe("safeExternalFetch — validated public HTTPS redirects", () => {
  it("keeps the credential-bearing default same-origin contract", async () => {
    const prepareRequest = vi.fn(() => ({
      headers: { Authorization: "Bearer provider-secret" },
    }));
    dns.lookup
      .mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }])
      .mockResolvedValueOnce([{ address: "8.8.4.4", family: 4 }]);
    const observations = mockHttpsResponses([
      { status: 307, headers: { location: "/v1/next" } },
      { status: 200, body: "ok" },
    ]);

    const response = await safeExternalFetch(
      "https://provider.example/v1/start",
      { method: "POST", body: "provider-body" },
      { requireHttps: true, prepareRequest },
    );

    expect(await response.text()).toBe("ok");
    expect(prepareRequest).toHaveBeenCalledOnce();
    expect(observations).toHaveLength(2);
    expect(observations.map(({ body }) => body)).toEqual(["provider-body", "provider-body"]);
    expect(observations[1]!.options.headers).toMatchObject({
      authorization: "Bearer provider-secret",
      host: "provider.example",
    });
  });

  it("follows an explicitly validated public HTTPS redirect and strips cross-origin credentials", async () => {
    dns.lookup
      .mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }])
      .mockResolvedValueOnce([{ address: "1.1.1.1", family: 4 }]);
    const observations = mockHttpsResponses([
      { status: 302, headers: { location: "https://cdn.publisher.example/article" } },
      { status: 200, body: "public article" },
    ]);

    const response = await safeExternalFetch(
      "https://publisher.example/article",
      {
        headers: {
          Accept: "text/html",
          "User-Agent": "Braavolabs-Research/1.0",
          Authorization: "Bearer must-not-cross",
          Cookie: "session=must-not-cross",
          "Proxy-Authorization": "Basic must-not-cross",
          "X-API-Key": "must-not-cross",
        },
      },
      { redirectPolicy: "validated-public-https" },
    );

    expect(await response.text()).toBe("public article");
    expect(observations).toHaveLength(2);
    expect(observations[1]!.options.headers).toEqual({
      accept: "text/html",
      host: "cdn.publisher.example",
      "user-agent": "Braavolabs-Research/1.0",
    });
    expect(dns.lookup).toHaveBeenCalledTimes(2);
  });

  it("leaves cross-origin redirects denied by default", async () => {
    dns.lookup
      .mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }])
      .mockResolvedValueOnce([{ address: "1.1.1.1", family: 4 }]);
    const observations = mockHttpsResponses([
      { status: 302, headers: { location: "https://other.example/article" } },
    ]);

    await expect(safeExternalFetch("https://publisher.example/article"))
      .rejects.toThrow(/cross-origin/i);
    expect(observations).toHaveLength(1);
  });

  it("rejects public-to-private or mixed redirects before a second socket", async () => {
    for (const addresses of [
      [{ address: "10.0.0.8", family: 4 }],
      [{ address: "1.1.1.1", family: 4 }, { address: "169.254.0.23", family: 4 }],
      [{ address: "::ffff:a9fe:17", family: 6 }],
    ]) {
      dns.lookup.mockReset();
      https.request.mockReset();
      dns.lookup
        .mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }])
        .mockResolvedValueOnce(addresses);
      const observations = mockHttpsResponses([
        { status: 302, headers: { location: "https://redirect-target.example/article" } },
      ]);

      await expect(safeExternalFetch(
        "https://publisher.example/article",
        {},
        { redirectPolicy: "validated-public-https" },
      )).rejects.toBeInstanceOf(SsrfError);
      expect(observations).toHaveLength(1);
    }
  });

  it("rejects non-GET requests and HTTPS-to-HTTP redirects in public redirect mode", async () => {
    await expect(safeExternalFetch(
      "https://publisher.example/article",
      { method: "POST", body: "secret-body" },
      { redirectPolicy: "validated-public-https" },
    )).rejects.toThrow(/get|head/i);
    expect(dns.lookup).not.toHaveBeenCalled();
    expect(https.request).not.toHaveBeenCalled();

    dns.lookup.mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }]);
    const observations = mockHttpsResponses([
      { status: 302, headers: { location: "http://publisher.example/article" } },
    ]);
    await expect(safeExternalFetch(
      "https://publisher.example/start",
      {},
      { redirectPolicy: "validated-public-https" },
    )).rejects.toThrow(/https/i);
    expect(observations).toHaveLength(1);
  });
});

describe("safeExternalFetch — caller response byte limits", () => {
  it("returns exactly the bounded prefix and cancels the response socket at the limit", async () => {
    let responseClosed = false;
    let chunksAttempted = 0;
    const { port } = await listen((_req, res) => {
      res.on("close", () => { responseClosed = true; });
      const timer = setInterval(() => {
        chunksAttempted += 1;
        res.write(Buffer.alloc(256, 0x61));
        if (chunksAttempted === 20) {
          clearInterval(timer);
          res.end();
        }
      }, 2);
      res.on("close", () => clearInterval(timer));
    });

    const response = await safeExternalFetch(
      `http://127.0.0.1:${port}/large`,
      {},
      { allowLoopback: true, maxResponseBytes: 1_000, responseOverflow: "truncate" },
    );

    expect((await response.arrayBuffer()).byteLength).toBe(1_000);
    await vi.waitFor(() => expect(responseClosed).toBe(true));
    expect(chunksAttempted).toBeLessThan(20);
  });

  it("keeps overflow fail-closed unless bounded-prefix mode is explicit", async () => {
    const { port } = await listen((_req, res) => res.end(Buffer.alloc(1_001, 0x61)));

    await expect(safeExternalFetch(
      `http://127.0.0.1:${port}/large`,
      {},
      { allowLoopback: true, maxResponseBytes: 1_000 },
    )).rejects.toThrow(/safe limit/i);
  });
});

describe("safeExternalFetch — cancellation and bodyless responses", () => {
  it("stops waiting on an attacker-controlled DNS lookup when the caller aborts", async () => {
    dns.lookup.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 5);

    const outcome = await Promise.race([
      safeExternalFetch(
        "https://slow-dns.example/article",
        { signal: controller.signal },
        { redirectPolicy: "validated-public-https" },
      ).then(() => "resolved", (error) => error instanceof Error ? error.name : "rejected"),
      new Promise<string>((resolve) => setTimeout(() => resolve("timed-out"), 50)),
    ]);

    expect(outcome).toBe("AbortError");
    expect(https.request).not.toHaveBeenCalled();
  });

  it.each([204, 205, 304])("returns a valid bodyless Response for HTTP %s", async (status) => {
    dns.lookup.mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }]);
    mockHttpsResponses([{ status }]);

    const response = await safeExternalFetch("https://provider.example/no-body");

    expect(response.status).toBe(status);
    expect(response.body).toBeNull();
    expect(await response.text()).toBe("");
  });
});

describe("safeExternalFetch — required local destination", () => {
  const localOnly = {
    allowLoopback: true,
    allowPrivateNetworks: true,
    requireLocalDestination: true,
  };

  it("rejects public IPv4 and IPv6 literals without opening a socket", async () => {
    for (const url of [
      "http://8.8.8.8/v1/models",
      "https://8.8.4.4/v1/models",
      "http://[2606:4700:4700::1111]/v1/models",
      "https://[2a00:1450:4009:80b::200e]/v1/models",
    ]) {
      await expect(assertSafeExternalUrl(url, localOnly), url)
        .rejects.toThrow(/local destination/i);
    }
  });

  it("keeps AWS EKS Pod Identity metadata endpoints denied in local-only mode", async () => {
    for (const url of [
      "http://169.254.170.23/v1/credentials?",
      "http://[fd00:ec2::23]/v1/credentials#",
      "http://[::ffff:a9fe:aa17]/v1/credentials?",
    ]) {
      await expect(assertSafeExternalUrl(url, localOnly), url)
        .rejects.toThrow(/cloud-metadata/i);
    }
  });

  it("keeps Tencent metadata denied across literal, encoded, mapped and DNS forms", async () => {
    for (const url of [
      "http://169.254.0.23/latest/meta-data/",
      "http://2851995671/latest/meta-data/",
      "http://0xa9fe0017/latest/meta-data/",
      "http://[::ffff:a9fe:17]/latest/meta-data/",
    ]) {
      await expect(assertSafeExternalUrl(url, localOnly), url)
        .rejects.toThrow(/cloud-metadata/i);
    }

    dns.lookup.mockResolvedValueOnce([{ address: "169.254.0.23", family: 4 }]);
    await expect(assertSafeExternalUrl("http://tencent-metadata.example/latest", localOnly))
      .rejects.toThrow(/cloud-metadata/i);
  });

  it("rejects a Tencent metadata redirect before the second socket", async () => {
    let requestCount = 0;
    const { port } = await listen((_req, res) => {
      requestCount += 1;
      res.statusCode = 307;
      res.setHeader("location", `http://metadata.tencent.internal:${port}/latest`);
      res.end();
    });
    dns.lookup
      .mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }])
      .mockResolvedValueOnce([{ address: "169.254.0.23", family: 4 }]);

    await expect(safeExternalFetch(
      `http://local-provider.example:${port}/start`,
      { method: "GET" },
      localOnly,
    )).rejects.toThrow(/cloud-metadata/i);

    expect(requestCount).toBe(1);
    expect(dns.lookup).toHaveBeenCalledTimes(2);
  });

  it("rejects mixed DNS answers before request preparation or a socket", async () => {
    let requestCount = 0;
    const { port } = await listen((_req, res) => {
      requestCount += 1;
      res.end("unexpected");
    });
    const prepareRequest = vi.fn(() => ({ headers: { Authorization: "Bearer test-key" } }));
    dns.lookup.mockResolvedValueOnce([
      { address: "127.0.0.1", family: 4 },
      { address: "8.8.8.8", family: 4 },
    ]);

    await expect(safeExternalFetch(
      `http://mixed.example:${port}/v1/models`,
      { method: "GET" },
      { ...localOnly, prepareRequest },
    )).rejects.toThrow(/local destination/i);

    expect(prepareRequest).not.toHaveBeenCalled();
    expect(requestCount).toBe(0);
  });

  it("accepts loopback/private/link-local controls and prepares headers only after validation", async () => {
    for (const url of [
      "http://127.0.0.1/",
      "http://10.10.0.8/",
      "http://172.20.0.4/",
      "http://192.168.10.4/",
      "http://169.254.20.4/",
      "http://[fc00::1]/",
      "http://[fd12:3456::1]/",
      "http://[fe80::1]/",
    ]) {
      await expect(assertSafeExternalUrl(url, localOnly), url).resolves.toBeUndefined();
    }

    let observedAuthorization = "";
    const { port } = await listen((req, res) => {
      observedAuthorization = req.headers.authorization ?? "";
      res.end("ok");
    });
    const prepareRequest = vi.fn(() => ({ headers: { Authorization: "Bearer local-key" } }));
    const response = await safeExternalFetch(
      `http://127.0.0.1:${port}/v1/models`,
      { method: "GET" },
      { ...localOnly, prepareRequest },
    );

    expect(response.ok).toBe(true);
    expect(prepareRequest).toHaveBeenCalledOnce();
    expect(observedAuthorization).toBe("Bearer local-key");
  });

  it("rejects a public redirect target before a second socket", async () => {
    let requestCount = 0;
    const { port } = await listen((_req, res) => {
      requestCount += 1;
      res.statusCode = 307;
      res.setHeader("location", `http://public.example:${port}/next`);
      res.end();
    });
    dns.lookup
      .mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }])
      .mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }]);

    await expect(safeExternalFetch(
      `http://local.example:${port}/start`,
      { method: "GET" },
      localOnly,
    )).rejects.toThrow(/local destination/i);

    expect(requestCount).toBe(1);
    expect(dns.lookup).toHaveBeenCalledTimes(2);
  });

  it("fails a DNS rebinding revalidation from local to public", async () => {
    dns.lookup
      .mockResolvedValueOnce([{ address: "10.0.0.8", family: 4 }])
      .mockResolvedValueOnce([{ address: "2606:4700:4700::1111", family: 6 }]);

    await expect(assertSafeExternalUrl("http://rebind.example/v1", localOnly))
      .resolves.toBeUndefined();
    await expect(assertSafeExternalUrl("http://rebind.example/v1", localOnly))
      .rejects.toThrow(/local destination/i);
  });
});
