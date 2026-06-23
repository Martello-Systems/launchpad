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

describe("middleware emits the CSP header", () => {
  it("sets Content-Security-Policy from env", async () => {
    const { middleware } = await import("../middleware");
    await withEnvAsync("https://acme.com", async () => {
      // The middleware ignores its request arg for header-setting, so a minimal
      // stub is fine.
      const res = middleware({} as never);
      expect(res.headers.get("Content-Security-Policy")).toBe(
        "frame-ancestors 'self' https://acme.com"
      );
    });
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
