import assert from "node:assert/strict";
import test from "node:test";
import { distractionSites, matchingSite, normalizeDomain, shouldBlock } from "../extension/core/distractions.js";
import { applyCommand, createInitialState } from "../extension/core/timer.js";

test("custom entries normalize host names and match whole domains and subdomains", () => {
  assert.equal(normalizeDomain("  HTTPS://YouTube.COM.:443/watch?v=one  "), "youtube.com");
  assert.equal(normalizeDomain("https://bücher.de/path"), "xn--bcher-kva.de");
  for (const input of ["", "not a website", "*.example.org", "https://user@example.org", "file:///page", "chrome://settings", "https://bad_.test", "https://example..org"]) {
    assert.equal(normalizeDomain(input), null, input);
  }
  const sites = ["youtube.com"];
  for (const url of ["http://youtube.com", "https://m.youtube.com:8443/", "https://youtube.com./"]) {
    assert.equal(matchingSite(url, sites), "youtube.com");
  }
  for (const url of ["https://notyoutube.com", "https://youtube.com.example.org", "https://example.org/youtube.com", "chrome-extension://example/"]) {
    assert.equal(matchingSite(url, sites), undefined);
  }
});

test("saved defaults can be removed and restored through the same list, with duplicates rejected", () => {
  const initial = createInitialState();
  assert.deepEqual(distractionSites(initial.settings), ["youtube.com", "instagram.com", "reddit.com"]);
  const duplicate = applyCommand(initial, { type: "distractions.add", domain: "https://YouTube.com/video" }, 0);
  assert.match(duplicate.error, /already/);
  const removed = applyCommand(initial, { type: "distractions.remove", domain: "youtube.com" }, 0).state;
  assert.deepEqual(distractionSites(removed.settings), ["instagram.com", "reddit.com"]);
  const restored = applyCommand(removed, { type: "distractions.add", domain: "youtube.com" }, 0).state;
  assert.deepEqual(distractionSites(restored.settings), ["instagram.com", "reddit.com", "youtube.com"]);
  assert.deepEqual(restored.timer, initial.timer);
});

test("blocking requires a live running study and a separate enabled preference", () => {
  const { state } = applyCommand(createInitialState(), { type: "distractions.set", enabled: true }, 0);
  const running = applyCommand(state, { type: "timer.start" }, 1_000).state;
  assert.equal(shouldBlock(state, 1_001), false);
  assert.equal(shouldBlock(running, 1_001), true);
  assert.equal(shouldBlock(running, running.timer.endsAt), false);
  const paused = applyCommand(running, { type: "timer.pause" }, 1_001).state;
  assert.equal(shouldBlock(paused, 1_002), false);
  const next = applyCommand(paused, { type: "timer.skip" }, 1_002).state;
  assert.equal(shouldBlock(applyCommand(next, { type: "timer.start" }, 1_002).state, 1_003), false);
});
