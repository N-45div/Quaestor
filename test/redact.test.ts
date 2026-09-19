import { expect } from "chai";
import { inert, plainText, safeMessage } from "../stocks/redact";

/**
 * Invisible characters are built from code points, never pasted: a literal
 * zero-width space in a test file is a test nobody can review.
 */
const ch = (code: number) => String.fromCharCode(code);
const ZERO_WIDTH_SPACE = ch(0x200b);
const ZERO_WIDTH_JOINER = ch(0x200d);
const WORD_JOINER = ch(0x2060);
const BYTE_ORDER_MARK = ch(0xfeff);
const RTL_OVERRIDE = ch(0x202e);
const LTR_OVERRIDE = ch(0x202d);
const POP_DIRECTIONAL = ch(0x202c);
const RTL_ISOLATE = ch(0x2067);
const ELLIPSIS = ch(0x2026);

/** The RPC URL shape that started this: the key rides in the query string. */
const HELIUS = "https://devnet.helius-rpc.com/?api-key=SECRET123";

describe("text crossing a trust boundary", () => {
  describe("safeMessage: an error message fit to show a stranger", () => {
    describe("URLs", () => {
      it("reduces an RPC URL inside an error to its origin, and the key is nowhere in the output", () => {
        // This is what an RPC client throws when the endpoint is down: the full
        // URL, key included, inside the message.
        const out = safeMessage(`failed to get recent blockhash: FetchError: request to ${HELIUS} failed, reason: ECONNRESET`);
        expect(out).to.not.include("SECRET123");
        expect(out).to.not.include("api-key");
        // The rest of the sentence is still what the operator needs to read.
        expect(out).to.equal(
          "failed to get recent blockhash: FetchError: request to https://devnet.helius-rpc.com failed, reason: ECONNRESET",
        );
      });

      it("drops a key carried in the path, not only in the query", () => {
        // Some providers put the key in the path rather than the query string.
        const out = safeMessage("429 from https://solana-mainnet.g.alchemy.com/v2/SECRET123");
        expect(out).to.equal("429 from https://solana-mainnet.g.alchemy.com");
      });

      it("drops userinfo credentials from a URL", () => {
        const out = safeMessage("connect https://operator:SECRET123@rpc.example.com/path failed");
        expect(out).to.not.include("SECRET123");
        expect(out).to.not.include("operator");
        expect(out).to.equal("connect https://rpc.example.com failed");
      });

      it("reduces every URL in the message, whatever the case of the scheme", () => {
        const out = safeMessage(`primary ${HELIUS} and fallback HTTP://rpc.example.com:8899/?api-key=SECRET456 both failed`);
        expect(out).to.not.include("SECRET123");
        expect(out).to.not.include("SECRET456");
        expect(out).to.equal("primary https://devnet.helius-rpc.com and fallback http://rpc.example.com:8899 both failed");
      });

      it("keeps the punctuation around a URL that was never part of it", () => {
        expect(safeMessage(`upstream said no (see ${HELIUS}), retrying`)).to.equal(
          "upstream said no (see https://devnet.helius-rpc.com), retrying",
        );
      });

      it("replaces a URL it cannot parse with a placeholder rather than passing it through", () => {
        const out = safeMessage("bad endpoint https://[not-a-host/?api-key=SECRET123");
        expect(out).to.not.include("SECRET123");
        expect(out).to.include("[url]");
      });

      it("still removes a query-string key from a scheme it does not treat as a URL", () => {
        // wss:// is not matched as a URL, so the credential pattern is the only
        // thing standing between the websocket endpoint and the reader.
        const out = safeMessage("ws error wss://devnet.helius-rpc.com/?api-key=SECRET123");
        expect(out).to.not.include("SECRET123");
      });

      // BUG (stocks/redact.ts, reported in bugs_found): only http(s) URLs are
      // reduced to an origin. A websocket endpoint whose key is in the PATH has
      // no `name=` for the credential pattern to find, so it passes through whole:
      //   safeMessage("ws closed wss://solana-mainnet.g.alchemy.com/v2/SECRET123")
      //     -> unchanged
      it("drops a path-borne key from a wss:// endpoint", () => {
        const out = safeMessage("ws closed wss://solana-mainnet.g.alchemy.com/v2/SECRET123");
        expect(out).to.not.include("SECRET123");
      });
    });

    describe("named credentials", () => {
      it("removes api-key=abc", () => {
        expect(safeMessage("request rejected: api-key=abc")).to.equal("request rejected: api-key=[redacted]");
      });

      it("removes what follows the bare word token only when it looks like a secret", () => {
        // In a product about tokens, "token: AAPLx" names an asset. A short,
        // letters-only value cannot be told from one, so the rule is about the
        // value: long and not just letters is a secret; a ticker is not.
        expect(safeMessage("upstream echoed token: tok_live_8f3a91c27d4e back at us"))
          .to.equal("upstream echoed token=[redacted] back at us");
        expect(safeMessage("unknown token: AAPLx is not in the catalog"))
          .to.equal("unknown token: AAPLx is not in the catalog");
      });

      it("removes every spelling of the key name, with either separator", () => {
        for (const named of [
          "api_key=SECRET123",
          "apikey:SECRET123",
          "API-KEY = SECRET123",
          "x-api-key: SECRET123",
          "access_token=SECRET123",
          "access-token: SECRET123",
          "secret=SECRET123",
          "password = SECRET123",
          "authorization=SECRET123",
        ]) {
          expect(safeMessage(`failed with ${named}`), named).to.not.include("SECRET123");
        }
      });

      it("stops the redaction at the end of the value, so the next parameter survives", () => {
        expect(safeMessage("GET /quote?token=abc&amount=5")).to.equal("GET /quote?token=[redacted]&amount=5");
      });

      it("removes a bearer token, which is the one credential separated by a space", () => {
        const out = safeMessage('upstream rejected header "Bearer abcdefgh12345"');
        expect(out).to.not.include("abcdefgh12345");
        expect(out).to.equal('upstream rejected header "Bearer [redacted]"');
      });

      it("removes a bearer token from a JSON-shaped header dump", () => {
        const out = safeMessage('request failed, headers: {"Authorization":"Bearer abcdefgh12345"}');
        expect(out).to.not.include("abcdefgh12345");
      });

      // BUG (stocks/redact.ts, reported in bugs_found): the credential pattern
      // runs first and treats the word "Bearer" as the *value* of
      // `Authorization:`, replacing "Authorization: Bearer" with
      // "Authorization=[redacted]". That deletes the word the bearer pattern
      // keys on, so the token itself is left standing:
      //   safeMessage("Authorization: Bearer abcdefgh12345")
      //     -> "Authorization=[redacted] abcdefgh12345"
      // This is the most common way a bearer token appears in an error. The
      // assertion below is the right one; the code is wrong, not the test.
      it("removes the token from a full 'Authorization: Bearer <token>' header", () => {
        const out = safeMessage("401 from upstream, sent Authorization: Bearer abcdefgh12345");
        expect(out).to.not.include("abcdefgh12345");
      });

      // BUG (same root cause): any two-word Authorization value loses its
      // scheme and keeps its secret. "Basic" carries a base64 user:password.
      //   safeMessage("Authorization: Basic dXNlcjpwYXNzd29yZA==")
      //     -> "Authorization=[redacted] dXNlcjpwYXNzd29yZA=="
      it("removes the credential from an 'Authorization: Basic <base64>' header", () => {
        const out = safeMessage("sent Authorization: Basic dXNlcjpwYXNzd29yZA==");
        expect(out).to.not.include("dXNlcjpwYXNzd29yZA");
      });

      // BUG: the pattern wants the separator directly after the name, so a
      // JSON-quoted key ("token":"...") - the shape of every echoed request
      // body - is not recognised at all.
      //   safeMessage('{"api_key":"SECRET123","token":"SECRET456"}') -> unchanged
      it("removes a credential from a JSON-shaped body", () => {
        const out = safeMessage('upstream echoed body {"api_key":"SECRET123","token":"SECRET456"}');
        expect(out).to.not.include("SECRET123");
        expect(out).to.not.include("SECRET456");
      });

      // BUG: `\b` does not fall between "_" and a letter, and the name must be
      // followed directly by the separator, so compound names slip through
      // untouched: client_secret=, refresh_token=, id_token=, secretKey=.
      it("removes a credential whose name is a compound of a known name", () => {
        for (const named of ["client_secret=SECRET123", "refresh_token=SECRET123", "id_token=SECRET123", "secretKey=SECRET123"]) {
          expect(safeMessage(`oauth exchange failed: ${named}`), named).to.not.include("SECRET123");
        }
      });

      // BUG: invisible characters are stripped *after* the URL and credential
      // patterns run, so one zero-width space inside the name (or the scheme)
      // hides the credential from the patterns and is then removed, leaving
      // the credential in the clear:
      //   "api-k" + U+200B + "ey=SECRET123"              -> "api-key=SECRET123"
      //   "ht" + U+200B + "tps://rpc.example.com/v2/KEY" -> "https://rpc.example.com/v2/KEY"
      // Stripping invisibles first would close both.
      it("is not fooled by a zero-width character inside the credential name or URL scheme", () => {
        expect(safeMessage(`api-k${ZERO_WIDTH_SPACE}ey=SECRET123`)).to.not.include("SECRET123");
        expect(safeMessage(`ht${ZERO_WIDTH_SPACE}tps://rpc.example.com/v2/SECRET123`)).to.not.include("SECRET123");
      });
    });

    describe("ordinary sentences", () => {
      it("leaves a sentence alone when 'token' is merely a word in it", () => {
        // A price-gate explanation. Redacting "sits" would make the hub's own
        // refusals unreadable.
        const message = "the token sits 45bps from its underlying";
        expect(safeMessage(message)).to.equal(message);
      });

      it("leaves 'the bearer of bad news' alone", () => {
        const message = "the bearer of bad news";
        expect(safeMessage(message)).to.equal(message);
      });

      it("leaves 'secret', 'password' and 'authorization' alone when nothing is being assigned to them", () => {
        for (const message of [
          "the secret is safe with the operator",
          "a password was not supplied",
          "authorization failed for this agent",
          "this token has no route on devnet",
          "Bearer short", // under eight characters is not an opaque token
        ]) {
          expect(safeMessage(message), message).to.equal(message);
        }
      });

      it("leaves the kind of refusal the hub writes itself alone", () => {
        for (const message of [
          "amount is below the 1.00 USDC minimum trade",
          "quote expired 12s ago; preview again",
          "AAPLx is 45bps from its reference; limit is 30bps (tokenized vs reference)",
          "daily execution limit of 20 reached, resets at 00:00 UTC",
        ]) {
          expect(safeMessage(message), message).to.equal(message);
        }
      });

      // BUG (legitimate message mangled): "token:" followed by anything is
      // read as a credential, so a sentence that *names* a token loses the name:
      //   safeMessage("unknown token: AAPLx is not in the catalog")
      //     -> "unknown token=[redacted] is not in the catalog"
      // In a product whose whole subject is tokens, this shape is ordinary.
      it("does not redact the name of a token after 'token:'", () => {
        const message = "unknown token: AAPLx is not in the catalog";
        expect(safeMessage(message)).to.equal(message);
      });

      // BUG (legitimate message mangled): "bearer" followed by any word of
      // eight or more letters is read as a bearer token:
      //   safeMessage("the bearer certificates were lost") -> "the Bearer [redacted] were lost"
      it("does not redact an ordinary long word after 'bearer'", () => {
        const message = "the bearer certificates were lost";
        expect(safeMessage(message)).to.equal(message);
      });
    });

    describe("invisible characters", () => {
      it("strips zero-width characters", () => {
        const hidden = `quote${ZERO_WIDTH_SPACE} ex${ZERO_WIDTH_JOINER}pired${WORD_JOINER}${BYTE_ORDER_MARK}`;
        expect(safeMessage(hidden)).to.equal("quote expired");
      });

      it("strips bidirectional overrides, so the text reads the way it is stored", () => {
        // An override makes stored text render in a different order than a
        // model reads it. What the model sees must be what a human sees.
        const spoofed = `route ${RTL_OVERRIDE}live${POP_DIRECTIONAL} is ${LTR_OVERRIDE}fine${RTL_ISOLATE}`;
        const out = safeMessage(spoofed);
        expect(out).to.equal("route live is fine");
        for (const code of [0x200b, 0x200d, 0x2060, 0xfeff, 0x202a, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2069]) {
          expect(out, `U+${code.toString(16)}`).to.not.include(ch(code));
        }
      });

      it("strips control characters and folds newlines and tabs into single spaces", () => {
        // A multi-line upstream error must not be able to forge a second log
        // line, and an escape byte must not reach a terminal.
        const out = safeMessage(`line one${ch(0x0a)}${ch(0x0d)}[stocks] forged${ch(0x09)}entry${ch(0x00)}${ch(0x1b)}[31m${ch(0x07)}`);
        expect(out).to.equal("line one [stocks] forged entry[31m");
      });
    });

    describe("length", () => {
      it("truncates to maxLength, ending in an ellipsis that is counted in the length", () => {
        const out = safeMessage("x".repeat(500), 40);
        expect(out).to.have.lengthOf(40);
        expect(out).to.equal(`${"x".repeat(39)}${ELLIPSIS}`);
      });

      it("defaults to 240 characters", () => {
        const out = safeMessage("word ".repeat(200));
        expect(out).to.have.lengthOf(240);
        expect(out.endsWith(ELLIPSIS)).to.equal(true);
      });

      it("leaves a message of exactly maxLength untouched", () => {
        const exact = "y".repeat(40);
        expect(safeMessage(exact, 40)).to.equal(exact);
      });

      it("redacts before it truncates, so a cut can never expose half a key", () => {
        // If truncation ran first, a URL straddling the limit would be cut into
        // something the URL pattern no longer recognises.
        const out = safeMessage(`${"z".repeat(30)} ${HELIUS}`, 45);
        expect(out).to.not.include("SECRET");
        expect(out).to.not.include("api-key");
        expect(out).to.have.lengthOf(45);
      });
    });

    describe("inputs that are not strings", () => {
      it("reads the message of an Error, and cleans it like any other", () => {
        expect(safeMessage(new Error(`fetch failed: ${HELIUS}`))).to.equal("fetch failed: https://devnet.helius-rpc.com");
      });

      it("reads the message of an Error subclass, not its name or stack", () => {
        class UpstreamError extends Error {}
        const out = safeMessage(new UpstreamError("upstream said token=abc"));
        expect(out).to.equal("upstream said token=[redacted]");
      });

      it("turns null and undefined into an empty string rather than the words", () => {
        expect(safeMessage(null)).to.equal("");
        expect(safeMessage(undefined)).to.equal("");
      });

      it("stringifies numbers, booleans, bigints and plain objects", () => {
        expect(safeMessage(429)).to.equal("429");
        expect(safeMessage(false)).to.equal("false");
        expect(safeMessage(10n ** 20n)).to.equal("100000000000000000000");
        // An object thrown as an error says nothing, which is the safe thing to say.
        expect(safeMessage({ message: `leak ${HELIUS}` })).to.equal("[object Object]");
      });

      it("cleans a non-Error whose string form carries a key", () => {
        const thrown = { toString: () => `rpc ${HELIUS} refused` };
        expect(safeMessage(thrown)).to.equal("rpc https://devnet.helius-rpc.com refused");
      });

      // BUG (robustness): safeMessage is called from error handlers, where
      // throwing is the one thing it must not do, but String() throws for a
      // value with no usable toString:
      //   safeMessage(Object.create(null)) -> TypeError: Cannot convert object to primitive value
      it("never throws, whatever was thrown at it", () => {
        expect(() => safeMessage(Object.create(null))).to.not.throw();
        expect(() =>
          safeMessage({
            toString() {
              throw new Error("boom");
            },
          }),
        ).to.not.throw();
      });
    });
  });

  describe("plainText: third-party display text, bounded", () => {
    it("turns markup into spaces, so a tag cannot survive as a tag", () => {
      const out = plainText("<script>alert(1)</script>Apple Inc.", 80);
      expect(out).to.not.match(/[<>]/);
      // "/" is ordinary punctuation and stays; without "<" and ">" it is inert.
      expect(out).to.equal("script alert(1) /script Apple Inc.");
    });

    it("turns markdown backticks, brackets and emphasis into spaces", () => {
      const out = plainText("`rm -rf` [click here](javascript:alert) **bold** _under_ ~strike~ | pipe", 120);
      expect(out).to.not.match(/[`\[\]*_~|]/);
      expect(out).to.equal("rm -rf click here (javascript:alert) bold under strike pipe");
    });

    it("removes the characters that open a quotation, a template or an escape", () => {
      const out = plainText('say "hi" {{system}} ${env} \\n ^caret =equals', 120);
      expect(out).to.not.match(/["{}\\^=]/);
      expect(out).to.equal("say hi system $ env n caret equals");
    });

    it("collapses runs of whitespace, including newlines and tabs, and trims the ends", () => {
      expect(plainText(`  SpaceX${ch(0x0a)}${ch(0x0a)}Ignore previous${ch(0x09)}instructions   `, 80)).to.equal(
        "SpaceX Ignore previous instructions",
      );
    });

    it("strips zero-width and bidi characters without leaving a gap where they were", () => {
      // Removed, not replaced by a space: "Open" + ZWSP + "AI" is the word OpenAI.
      expect(plainText(`Open${ZERO_WIDTH_SPACE}AI ${RTL_OVERRIDE}Inc${POP_DIRECTIONAL}`, 80)).to.equal("OpenAI Inc");
    });

    it("enforces the maximum length", () => {
      expect(plainText("A".repeat(500), 32)).to.equal("A".repeat(32));
    });

    it("measures the length after cleaning, so padding cannot push the real text out", () => {
      expect(plainText(`${" ".repeat(100)}<<<<>>>>Anthropic`, 9)).to.equal("Anthropic");
    });

    it("keeps letters, digits, currency signs and ordinary punctuation", () => {
      const text = "AT&T (Class-A), 5% +/- 2; #1 @ $10: what?! it's fine.";
      expect(plainText(text, 120)).to.equal(text);
    });

    it("keeps currency signs from outside ASCII", () => {
      const text = `${ch(0x20ac)}5 ${ch(0xa3)}4 ${ch(0xa5)}300 ${ch(0x20b9)}250`; // euro, pound, yen, rupee
      expect(plainText(text, 80)).to.equal(text);
    });

    it("keeps names written in other scripts", () => {
      for (const name of [
        "Nestlé S.A.", // Latin with a precomposed accent
        "Газпром", // Cyrillic
        "Αλφα Βήτα", // Greek
        "腾讯控股", // Han
        "トヨタ自動車", // Katakana + Han
        "삼성전자", // Hangul
        "أرامكو", // Arabic
        "טבע", // Hebrew
      ]) {
        expect(plainText(name, 80), name).to.equal(name);
      }
    });

    it("keeps digits from other scripts", () => {
      const arabicIndic = "١٢٣";
      expect(plainText(arabicIndic, 10)).to.equal(arabicIndic);
    });

    // BUG (legitimate text broken): the allow-list has \p{L} but not \p{M}, so
    // every combining mark becomes a space. Scripts that *spell* with marks are
    // shredded - Devanagari, Bengali, Tamil, Thai, vocalised Arabic/Hebrew -
    // and so is any Latin text that arrives decomposed (NFD):
    //   plainText("टेस्ला", 50) -> "ट स ल"  (three bare consonants)
    //   plainText("Nestlé", 50)                         -> "Nestle"               (accent silently lost)
    // Normalising to NFC and allowing \p{M} would fix both.
    it("keeps names in scripts that are written with combining marks", () => {
      const tesla = "टेस्ला"; // Devanagari: "Tesla"
      expect(plainText(tesla, 50)).to.equal(tesla);
      // Decomposed Latin should come out as the same name, in either normal form.
      expect(plainText("Nestlé", 50).normalize("NFC")).to.equal("Nestlé");
    });

    // BUG (minor): the cut is made in UTF-16 units and after the trim, so it
    // can land in the middle of a surrogate pair and return a lone surrogate,
    // or leave the trailing space the trim was there to remove:
    //   plainText(String.fromCodePoint(0x1d400, 0x1d401, 0x1d402), 3) -> U+1D400 followed by a lone \ud835
    //   plainText("ab cd", 3)                                         -> "ab "
    it("never cuts a character in half or leaves a trailing space", () => {
      const bold = String.fromCodePoint(0x1d400, 0x1d401, 0x1d402); // mathematical bold A B C, all \p{L}
      expect(plainText(bold, 3)).to.not.match(/[\ud800-\udbff](?![\udc00-\udfff])/);
      expect(plainText("ab cd", 3)).to.equal("ab");
    });

    it("turns null and undefined into an empty string, and stringifies anything else", () => {
      expect(plainText(null, 10)).to.equal("");
      expect(plainText(undefined, 10)).to.equal("");
      expect(plainText(12345, 3)).to.equal("123");
      expect(plainText({ name: "x" }, 40)).to.equal("object Object");
    });

    it("leaves nothing of a string that was only markup", () => {
      expect(plainText("<<<>>>```[[]]", 40)).to.equal("");
    });
  });

  describe("inert: a value on its way into a model's context", () => {
    it("recurses through objects and arrays, cleaning every string it finds", () => {
      const out = inert({
        name: `Open${ZERO_WIDTH_SPACE}AI`,
        routes: [{ label: `${RTL_OVERRIDE}jupiter` }, [`me${BYTE_ORDER_MARK}teora`]],
      });
      expect(out).to.deep.equal({ name: "OpenAI", routes: [{ label: "jupiter" }, ["meteora"]] });
    });

    it("returns a copy and leaves the original untouched", () => {
      // Tool results are built from live platform objects; cleaning them for
      // the model must not rewrite the order book.
      const original = { note: `a${ZERO_WIDTH_SPACE}b`, legs: [1n] };
      const out = inert(original);
      expect(out).to.not.equal(original);
      expect(original.note).to.equal(`a${ZERO_WIDTH_SPACE}b`);
      expect(original.legs[0]).to.equal(1n);
    });

    it("converts a bigint to a string, at any depth, without losing precision", () => {
      // Base units are bigints, and JSON.stringify throws on them.
      const out = inert({ in_amount: 5_000_000n, fills: [{ out_amount: 2n ** 64n }] });
      expect(out).to.deep.equal({ in_amount: "5000000", fills: [{ out_amount: "18446744073709551616" }] });
      expect(() => JSON.stringify(out)).to.not.throw();
    });

    it("leaves numbers, booleans, null and undefined exactly as they were", () => {
      const values = { price: 336.99, zero: 0, negative: -1.5, ok: true, no: false, none: null, missing: undefined };
      expect(inert(values)).to.deep.equal(values);
      expect(inert(42)).to.equal(42);
      expect(inert(true)).to.equal(true);
      expect(inert(null)).to.equal(null);
      expect(inert(undefined)).to.equal(undefined);
      expect(Number.isNaN(inert(Number.NaN) as number)).to.equal(true);
    });

    it("caps a very long string at 1200 characters, ending in an ellipsis", () => {
      const out = inert("d".repeat(5_000)) as string;
      expect(out).to.have.lengthOf(1_200);
      expect(out).to.equal(`${"d".repeat(1_199)}${ELLIPSIS}`);
    });

    it("leaves a string of exactly 1200 characters whole", () => {
      const exact = "e".repeat(1_200);
      expect(inert(exact)).to.equal(exact);
    });

    it("measures a string after removing invisible characters, not before", () => {
      // 1200 visible characters padded with invisible ones is still 1200 characters.
      const padded = "f".repeat(1_200) + ZERO_WIDTH_SPACE.repeat(300);
      expect(inert(padded)).to.equal("f".repeat(1_200));
    });

    it("caps a very long array at 200 items, keeping the first ones", () => {
      const out = inert(Array.from({ length: 1_000 }, (_, i) => i)) as number[];
      expect(out).to.have.lengthOf(200);
      expect(out[0]).to.equal(0);
      expect(out[199]).to.equal(199);
    });

    it("cleans the items it keeps from a long array", () => {
      const out = inert(Array.from({ length: 300 }, () => `x${ZERO_WIDTH_SPACE}`)) as string[];
      expect(out).to.have.lengthOf(200);
      expect(out.every((item) => item === "x")).to.equal(true);
    });

    it("stops at the depth limit, replacing what lies below with a marker", () => {
      // { next: { next: ... { leaf } } } with the leaf twelve levels down.
      let nested: unknown = { leaf: "unreachable" };
      for (let i = 0; i < 12; i += 1) nested = { next: nested };

      const out = inert(nested);
      let cursor: unknown = out;
      let levels = 0;
      while (cursor && typeof cursor === "object") {
        cursor = (cursor as Record<string, unknown>).next;
        levels += 1;
      }
      // Depths 0 to 8 are walked; whatever sits at depth 9 becomes the marker.
      expect(levels).to.equal(9);
      expect(cursor).to.equal("[nested too deeply]");
      expect(JSON.stringify(out)).to.not.include("unreachable");
    });

    it("keeps everything that sits within the depth limit", () => {
      let nested: unknown = "bottom";
      for (let i = 0; i < 8; i += 1) nested = [nested];
      let cursor = inert(nested);
      for (let i = 0; i < 8; i += 1) cursor = (cursor as unknown[])[0];
      expect(cursor).to.equal("bottom");
    });

    it("terminates on a value that contains itself", () => {
      // Nothing parsed from JSON is cyclic, but a platform object might be one
      // day, and the depth limit is the only thing that would stop the walk.
      const cyclic: Record<string, unknown> = { name: "loop" };
      cyclic.self = cyclic;
      const out = inert(cyclic);
      expect(() => JSON.stringify(out)).to.not.throw();
      expect(JSON.stringify(out)).to.include("[nested too deeply]");
    });

    // BUG (minor): values are cleaned, keys are not. A provider that controls a
    // map's keys can put invisible (or unbounded) text in front of the model
    // through them:
    //   inert({ ["a" + U+200B + "b"]: 1 }) -> the key still contains U+200B
    it("cleans object keys as well as values", () => {
      const out = inert({ [`a${ZERO_WIDTH_SPACE}b`]: 1 }) as Record<string, unknown>;
      expect(Object.keys(out)).to.deep.equal(["ab"]);
    });
  });
});
