import { describe, it, expect, afterEach } from "vitest";
import { embedFrameAncestors, embedCsp } from "../lib/config";

const KEY = "EMBED_ALLOWED_ORIGINS";

function withEnv(value: string | undefined, fn: () => void) {
  const prev = process.env[KEY];
  if (value === undefined) delete process.env[KEY];
  else process.env[KEY] = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env[KEY];
    else process.env[KEY] = prev;
  }
}

afterEach(() => {
  delete process.env[KEY];
});

describe("embedFrameAncestors", () => {
  it("defaults to 'self' when unset", () => {
    withEnv(undefined, () => {
      expect(embedFrameAncestors()).toBe("'self'");
    });
  });

  it("defaults to 'self' when empty", () => {
    withEnv("   ", () => {
      expect(embedFrameAncestors()).toBe("'self'");
    });
  });

  it("passes through wildcard", () => {
    withEnv("*", () => {
      expect(embedFrameAncestors()).toBe("*");
    });
  });

  it("includes configured origins plus 'self'", () => {
    withEnv("https://acme.com https://www.acme.com", () => {
      expect(embedFrameAncestors()).toBe(
        "'self' https://acme.com https://www.acme.com"
      );
    });
  });

  it("accepts comma-separated origins", () => {
    withEnv("https://a.com, https://b.com", () => {
      expect(embedFrameAncestors()).toBe("'self' https://a.com https://b.com");
    });
  });

  it("does not duplicate 'self' when already listed", () => {
    withEnv("'self' https://a.com", () => {
      expect(embedFrameAncestors()).toBe("'self' https://a.com");
    });
  });
});

describe("embedCsp", () => {
  it("wraps the frame-ancestors directive", () => {
    withEnv("https://acme.com", () => {
      expect(embedCsp()).toBe("frame-ancestors 'self' https://acme.com");
    });
  });

  it("emits a wide-open policy only when explicitly configured", () => {
    withEnv("*", () => {
      expect(embedCsp()).toBe("frame-ancestors *");
    });
  });
});

// A minimal request stub: the middleware only reads `nextUrl.pathname`.
function reqFor(pathname: string) {
  return { nextUrl: { pathname } } as never;
}

describe("middleware emits the CSP header", () => {
  it("sets the configurable frame-ancestors CSP on /embed from env", async () => {
    const { middleware } = await import("../middleware");
    await withEnvAsync("https://acme.com", async () => {
      const res = middleware(reqFor("/embed"));
      expect(res.headers.get("Content-Security-Policy")).toBe(
        "frame-ancestors 'self' https://acme.com"
      );
      // The embeddable surface must NOT be DENY-framed.
      expect(res.headers.get("X-Frame-Options")).toBeNull();
    });
  });

  it("also applies the configurable CSP to /embed.js", async () => {
    const { middleware } = await import("../middleware");
    await withEnvAsync("https://acme.com", async () => {
      const res = middleware(reqFor("/embed.js"));
      expect(res.headers.get("Content-Security-Policy")).toBe(
        "frame-ancestors 'self' https://acme.com"
      );
      expect(res.headers.get("X-Frame-Options")).toBeNull();
    });
  });
});

describe("middleware baseline security headers (app-wide)", () => {
  it("sets nosniff + Referrer-Policy on every route", async () => {
    const { middleware } = await import("../middleware");
    for (const p of ["/", "/admin", "/api/signup", "/embed"]) {
      const res = middleware(reqFor(p));
      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(res.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    }
  });

  it("makes the signup page, /admin, and the API non-frameable", async () => {
    const { middleware } = await import("../middleware");
    for (const p of ["/", "/admin", "/api/signup", "/api/admin/export"]) {
      const res = middleware(reqFor(p));
      expect(res.headers.get("X-Frame-Options")).toBe("DENY");
      expect(res.headers.get("Content-Security-Policy")).toBe("frame-ancestors 'none'");
    }
  });
});

async function withEnvAsync(value: string, fn: () => Promise<void>) {
  const prev = process.env[KEY];
  process.env[KEY] = value;
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env[KEY];
    else process.env[KEY] = prev;
  }
}
