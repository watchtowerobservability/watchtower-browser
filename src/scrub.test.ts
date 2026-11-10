import { afterEach, describe, expect, it } from "vitest";
import { scrubScriptUrl, scrubSpanAttrs, scrubUrl, setUrlScrubbing } from "./scrub";

afterEach(() => setUrlScrubbing(undefined));

describe("url scrubbing", () => {
  it("drops_query_and_fragment", () => {
    expect(scrubUrl("https://a.test/p?token=abc#frag")).toBe("https://a.test/p");
  });

  it("redacts_secret_looking_segments", () => {
    const uuid = "3b241101-e2bb-4255-8caf-4136c566a962";
    expect(scrubUrl(`https://a.test/invite/${uuid}/accept`)).toBe("https://a.test/invite/:redacted/accept");
    expect(scrubUrl("/reset/abcdefghijklmnopqrstuvwx")).toBe("/reset/:redacted"); // 24 chars
    expect(scrubUrl("/s/a1b2c3d4e5")).toBe("/s/:redacted"); // 10 chars with letter and digit
    expect(scrubUrl("/s/abcdefghij/x")).toBe("/s/abcdefghij/x"); // 10 letters only
    expect(scrubUrl("/s/1234567890")).toBe("/s/1234567890"); // digits only
    expect(scrubUrl("/gallery/contact")).toBe("/gallery/contact");
  });

  it("keeps_host_and_build_asset_names", () => {
    expect(scrubUrl("https://abcdefghij1234567890abcdefgh.example.com/_next/static/app.3f2a1b9c7d.js?v=1")).toBe(
      "https://abcdefghij1234567890abcdefgh.example.com/_next/static/app.3f2a1b9c7d.js",
    );
  });

  it("script_urls_keep_their_path", () => {
    expect(scrubScriptUrl("https://a.test/_next/static/chunks/0a1b2c3d4e5f6a7b8c9d0e1f2a3b.js?dpl=x")).toBe(
      "https://a.test/_next/static/chunks/0a1b2c3d4e5f6a7b8c9d0e1f2a3b.js",
    );
  });

  it("opt_out_keeps_query_and_ids_but_not_the_fragment", () => {
    setUrlScrubbing(false);
    expect(scrubUrl("https://a.test/u/a1b2c3d4e5f6?x=1#h")).toBe("https://a.test/u/a1b2c3d4e5f6?x=1");
    expect(scrubScriptUrl("https://a.test/a.js?v=1")).toBe("https://a.test/a.js?v=1");
  });

  it("span_attributes_are_scrubbed_in_place", () => {
    const a: Record<string, unknown> = {
      "http.url": "https://a.test/api/a1b2c3d4e5f6?email=x@y.z",
      "url.full": "https://a.test/api/x?q=1",
      "url.path": "/api/a1b2c3d4e5f6",
      "url.query": "q=1",
      "http.method": "GET",
    };
    scrubSpanAttrs(a);
    expect(a).toEqual({
      "http.url": "https://a.test/api/:redacted",
      "url.full": "https://a.test/api/x",
      "url.path": "/api/:redacted",
      "http.method": "GET",
    });
  });
});
