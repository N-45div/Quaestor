import { expect } from "chai";
import { canonicalize, fetchEvidence, hardChecks, proofHashOf, type Fetch } from "../operator/verify";

/** Claimed deliveries, checked before any model sees them: one spelling per post, and the facts. */
describe("operator verify", () => {
  const reply = (body: unknown, status = 200): ReturnType<Fetch> =>
    Promise.resolve({ ok: status < 400, status, json: async () => body, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) });

  it("folds every spelling of a post, PR or video into one canonical link and proof hash", () => {
    const a = "https://twitter.com/Writer/status/1844?s=20&t=abc";
    const b = "https://mobile.x.com/writer/status/1844/";
    expect(canonicalize(a)).to.deep.equal({ kind: "x-post", canonical: "https://x.com/writer/status/1844" });
    expect(proofHashOf(a)).to.equal(proofHashOf(b));
    expect(canonicalize("https://github.com/N-45div/Quaestor/pull/12/files").canonical).to.equal("https://github.com/n-45div/quaestor/pull/12");
    expect(canonicalize("https://youtu.be/abc123?t=4").canonical).to.equal("https://youtube.com/watch?v=abc123");
    expect(canonicalize("https://www.Example.com/blog/post/?utm=x#top").canonical).to.equal("https://example.com/blog/post");
    expect(() => canonicalize("javascript:alert(1)")).to.throw();
  });

  it("reads an X post's author, text and date from oEmbed", async () => {
    const html = '<blockquote class="twitter-tweet"><p lang="en">Quaestor gives agents allowances, not wallets <a href="https://t.co/x">github.com/N-45div/Quaestor</a></p>&mdash; Writer (@writer) <a href="https://twitter.com/writer/status/1844">October 6, 2026</a></blockquote>';
    const fetchFn: Fetch = (url) => (url.startsWith("https://publish.twitter.com/oembed") ? reply({ author_url: "https://twitter.com/Writer", html }) : reply({}, 404));
    const e = await fetchEvidence("https://x.com/writer/status/1844", fetchFn);
    expect(e.ok).to.equal(true);
    expect(e.author).to.equal("writer");
    expect(e.text).to.contain("allowances, not wallets");
    expect(e.publishedAt).to.equal("2026-10-06T00:00:00.000Z");
    expect(hardChecks(e, { handle: "@Writer", taskKind: "x-post", openedAt: new Date("2026-10-05"), mustMention: ["Quaestor"] })).to.deep.equal([]);
  });

  it("refuses someone else's post, an old one, a deleted one, and one that misses the point", async () => {
    const html = '<blockquote><p>gm</p>&mdash; Other (@other) <a href="x">September 1, 2026</a></blockquote>';
    const e = await fetchEvidence("https://x.com/other/status/1", () => reply({ author_url: "https://twitter.com/other", html }));
    expect(hardChecks(e, { handle: "writer", taskKind: "x-post", openedAt: new Date("2026-10-05"), mustMention: ["Quaestor"] })).to.deep.equal([
      "it was published by other, not writer",
      "it was published on 2026-09-01, before the deal",
      "it does not mention Quaestor",
    ]);
    const gone = await fetchEvidence("https://x.com/writer/status/2", () => reply({}, 404));
    expect(gone.ok).to.equal(false);
    expect(hardChecks(gone, { handle: "writer", taskKind: "x-post", openedAt: new Date() })[0]).to.contain("missing, deleted or private");
  });

  it("checks that a pull request is the payee's and merged", async () => {
    const pr = { user: { login: "Coder" }, merged: false, created_at: "2026-10-06T10:00:00Z", title: "Fix the docs", body: "" };
    const e = await fetchEvidence("https://github.com/N-45div/Quaestor/pull/7", (url) => (url.includes("api.github.com/repos/n-45div/quaestor/pulls/7") ? reply(pr) : reply({}, 404)));
    expect(e.author).to.equal("coder");
    expect(hardChecks(e, { handle: "coder", taskKind: "pull-request", openedAt: new Date("2026-10-05") })).to.deep.equal(["the pull request has not been merged"]);
    expect(hardChecks(e, { handle: "coder", taskKind: "x-post", openedAt: new Date("2026-10-05") })[0]).to.contain("wants a x-post");
  });

  it("reads an article page's title, text and publish date", async () => {
    const page = '<html><head><title>Agents need allowances</title><meta property="article:published_time" content="2026-10-07T08:00:00Z"><meta name="author" content="Writer"></head><body><script>x</script><p>Why Quaestor &amp; agents</p></body></html>';
    const e = await fetchEvidence("https://writer.substack.com/p/agents?ref=1", () => reply(page));
    expect(e).to.include({ ok: true, kind: "page", canonical: "https://writer.substack.com/p/agents", title: "Agents need allowances", publishedAt: "2026-10-07T08:00:00Z", author: "writer" });
    expect(e.text).to.contain("Why Quaestor & agents");
    expect(e.text).to.not.contain("x\n");
  });
});
