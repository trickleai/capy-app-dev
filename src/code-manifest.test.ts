import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { contentTypeFor, FALLBACK_IGNORE, makeIgnoreMatcher } from "./code-manifest.ts";

describe("makeIgnoreMatcher", () => {
  const ig = makeIgnoreMatcher(FALLBACK_IGNORE);

  it("ignores dependency dirs anywhere in the tree", () => {
    assert.equal(ig("/node_modules/left-pad/index.js"), true);
    assert.equal(ig("/src/.venv/lib/x.py"), true);
    assert.equal(ig("/a/__pycache__/m.pyc"), true);
    assert.equal(ig("/.git/config"), true);
  });

  it("ignores by file glob and exact name", () => {
    assert.equal(ig("/logs/app.log"), true);
    assert.equal(ig("/.DS_Store"), true);
    assert.equal(ig("/x/y.pyc"), true);
  });

  it("does NOT ignore source files or build outputs", () => {
    assert.equal(ig("/src/index.js"), false);
    assert.equal(ig("/dist/bundle.js"), false); // build outputs are NOT default-ignored
    assert.equal(ig("/build/out.css"), false);
    assert.equal(ig("/README.md"), false);
    assert.equal(ig("/.capy-app.json"), false);
  });

  it("supports extra patterns and a bare token matching dir or file", () => {
    const ig2 = makeIgnoreMatcher(["secret.txt", "coverage/"]);
    assert.equal(ig2("/a/secret.txt"), true);
    assert.equal(ig2("/coverage/lcov.info"), true);
    assert.equal(ig2("/src/app.ts"), false);
  });
});

describe("contentTypeFor", () => {
  it("maps common extensions", () => {
    assert.equal(contentTypeFor("index.js"), "text/javascript");
    assert.equal(contentTypeFor("styles.css"), "text/css");
    assert.equal(contentTypeFor("data.json"), "application/json");
    assert.equal(contentTypeFor("page.html"), "text/html");
  });
  it("defaults to octet-stream for unknown extensions", () => {
    assert.equal(contentTypeFor("mystery.xyz"), "application/octet-stream");
    assert.equal(contentTypeFor("noext"), "application/octet-stream");
  });
});
