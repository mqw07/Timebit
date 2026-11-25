import assert from "node:assert/strict";
import test from "node:test";
import { buildSiteRules, createBlocking } from "../extension/background/blocking.js";
import { applyCommand, createInitialState, reconcile } from "../extension/core/timer.js";
import { siteOrigin } from "../extension/core/distractions.js";

const redirect = "chrome-extension://timebit/redirect/index.html";

test("rules target top-level requests and preserve domain precedence without exposing the original URL", () => {
  const rules = buildSiteRules(["video.test", "live.video.test"], redirect);
  assert.deepEqual(rules.map(({ condition }) => condition), [
    { requestDomains: ["live.video.test"], resourceTypes: ["main_frame"] },
    { requestDomains: ["video.test"], resourceTypes: ["main_frame"] },
  ]);
  assert.ok(rules[0].priority > rules[1].priority);
  assert.equal(rules[0].action.redirect.url, `${redirect}#live.video.test`);
});

function setup() {
  const granted = new Set([siteOrigin("youtube.com")]);
  const tabs = new Map([
    [1, { id: 1, windowId: 1, active: true }],
    [2, { id: 2, windowId: 1, url: "https://m.youtube.com/watch?q=private" }],
    [3, { id: 3, windowId: 1, url: "https://notyoutube.com" }],
    [4, { id: 4, windowId: 1, url: "https://instagram.com" }],
  ]);
  const navigations = [];
  const session = {};
  let rules = [];
  let clock = 1_000;
  const api = {
    runtime: { getURL: (path) => `chrome-extension://timebit/${path}` },
    permissions: {
      async contains({ origins }) {
        return [...granted].some((origin) => origins[0] === origin || origins[0].endsWith(`.${origin.slice(6)}`));
      },
      async getAll() { return { origins: [...granted] }; },
      async remove({ origins }) { origins.forEach((origin) => granted.delete(origin)); },
    },
    declarativeNetRequest: {
      async getSessionRules() { return rules; },
      async updateSessionRules({ removeRuleIds, addRules }) {
        rules = rules.filter(({ id }) => !removeRuleIds.includes(id)).concat(addRules);
      },
    },
    storage: { session: {
      async get(key) { return { [key]: session[key] }; },
      async set(values) { Object.assign(session, values); },
    } },
    tabs: {
      async query() { return [...tabs.values()]; },
      async get(id) { return tabs.get(id); },
      async update(id, update) {
        navigations.push([id, update]);
        tabs.set(id, { ...tabs.get(id), ...update });
      },
    },
  };
  let state = createInitialState();
  const startWorker = () => createBlocking(api, () => clock);
  let blocker = startWorker();
  async function change(command, context) {
    const previous = state;
    state = reconcile(state, clock);
    if (command) state = applyCommand(state, command, clock).state;
    return blocker.sync(state, previous, context);
  }
  return {
    change, tabs, granted, navigations, rules: () => rules, get state() { return state; },
    setTime: (timestamp) => { clock = timestamp; }, restart: () => { blocker = startWorker(); },
    returnToStudy: (tab) => blocker.returnToStudy(tab, state),
  };
}

test("granted tabs redirect during study, with pause, revocation, expiry and restart clearing or rebuilding rules", async () => {
  const t = setup();
  await t.change({ type: "distractions.set", enabled: true });
  assert.equal(t.rules().length, 0);
  assert.deepEqual(await t.change({ type: "timer.start" }), ["youtube.com"]);
  assert.deepEqual(t.navigations, [[2, { url: `${redirect}#youtube.com` }]]);
  assert.equal(t.rules().length, 1);
  await t.change({ type: "timer.pause" });
  assert.equal(t.rules().length, 0);
  await t.change({ type: "timer.start" });
  t.restart();
  assert.deepEqual(await t.change(), ["youtube.com"]);
  t.granted.delete(siteOrigin("youtube.com"));
  await t.change();
  assert.equal(t.rules().length, 0);
  t.granted.add(siteOrigin("youtube.com"));
  await t.change();
  assert.equal(t.rules().length, 1);
  t.setTime(t.state.timer.endsAt);
  await t.change();
  assert.equal(t.rules().length, 0);
  await t.change({ type: "timer.start" });
  assert.equal(t.rules().length, 0);
});

test("a later tab visit is checked, removing a domain releases its grant, and returning focuses a suitable tab", async () => {
  const t = setup();
  await t.change({ type: "distractions.set", enabled: true });
  await t.change({ type: "timer.start" });
  t.tabs.set(5, { id: 5, windowId: 1, url: "https://youtube.com/feed" });
  await t.change(null, { tabId: 5 });
  assert.deepEqual(t.navigations.at(-1), [5, { url: `${redirect}#youtube.com` }]);
  await t.returnToStudy(t.tabs.get(5));
  assert.deepEqual(t.navigations.at(-1), [1, { active: true }]);
  t.tabs.delete(1);
  await t.returnToStudy(t.tabs.get(5));
  assert.deepEqual(t.navigations.at(-1), [5, { url: "chrome-extension://timebit/popup/popup.html" }]);
  await t.change({ type: "distractions.remove", domain: "youtube.com" });
  assert.equal(t.rules().length, 0);
  assert.equal(t.granted.has(siteOrigin("youtube.com")), false);
});

test("a covered subdomain can keep its grant until both list entries are removed", async () => {
  const t = setup();
  await t.change({ type: "distractions.add", domain: "m.youtube.com" });
  await t.change({ type: "distractions.remove", domain: "youtube.com" });
  assert.equal(t.granted.has(siteOrigin("youtube.com")), true);
  await t.change({ type: "distractions.remove", domain: "m.youtube.com" });
  assert.equal(t.granted.has(siteOrigin("youtube.com")), false);
});

test("reset and disabling blocking clear rules immediately", async () => {
  const t = setup();
  await t.change({ type: "distractions.set", enabled: true });
  await t.change({ type: "timer.start" });
  assert.equal(t.rules().length, 1);
  await t.change({ type: "timer.reset" });
  assert.equal(t.rules().length, 0);
  await t.change({ type: "timer.start" });
  assert.equal(t.rules().length, 1);
  await t.change({ type: "distractions.set", enabled: false });
  assert.equal(t.rules().length, 0);
});
