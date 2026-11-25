import { distractionSites, matchingSite, permittedSites, REDIRECT_PATH, shouldBlock, siteOrigin } from "../core/distractions.js";

const LAST_STUDY_TABS = "timebit:last-study-tabs";

export function buildSiteRules(domains, redirectUrl) {
  return [...domains].sort().map((domain, index) => ({
    id: index + 1,
    priority: domain.length,
    action: { type: "redirect", redirect: { url: `${redirectUrl}#${domain}` } },
    condition: { requestDomains: [domain], resourceTypes: ["main_frame"] },
  }));
}

function sameRules(existing, wanted) {
  return existing.length === wanted.length && wanted.every((rule) => existing.some((old) => (
    old.id === rule.id && old.priority === rule.priority
    && old.action.redirect?.url === rule.action.redirect.url
    && old.condition.requestDomains?.length === 1 && old.condition.requestDomains[0] === rule.condition.requestDomains[0]
    && old.condition.resourceTypes?.length === 1 && old.condition.resourceTypes[0] === "main_frame"
  )));
}

export function createBlocking(api, now = Date.now) {
  const redirectUrl = api.runtime.getURL(REDIRECT_PATH);
  let scanned;

  function siteForTab(tab, domains) {
    return matchingSite(tab.pendingUrl ?? tab.url, domains);
  }

  function isStudyTab(tab, sites) {
    const url = tab.pendingUrl ?? tab.url;
    // Chrome may hide an ungranted URL. Focusing an existing tab doesn't require reading it.
    return !url || (/^https?:\/\//.test(url) && !matchingSite(url, sites));
  }

  async function rememberTab(tab, sites) {
    if (!isStudyTab(tab, sites) || !Number.isInteger(tab.id)) return;
    const stored = await api.storage.session.get(LAST_STUDY_TABS);
    const windows = stored[LAST_STUDY_TABS] ?? {};
    if (windows[tab.windowId] === tab.id) return;
    await api.storage.session.set({ [LAST_STUDY_TABS]: { ...windows, [tab.windowId]: tab.id } });
  }

  async function visitTab(tab, domains, state) {
    const domain = siteForTab(tab, domains);
    if (domain && shouldBlock(state, now())) {
      await api.tabs.update(tab.id, { url: `${redirectUrl}#${domain}` });
    }
  }

  async function inspectTab(tabId, domains, sites, state, activated) {
    try {
      const tab = await api.tabs.get(tabId);
      if (activated) await rememberTab(tab, sites);
      // Avoid replacing a pending navigation; the DNR rule or commit will handle it.
      if (!tab.pendingUrl) await visitTab(tab, domains, state);
    } catch {
      // Tabs can disappear between a navigation event and querying them.
    }
  }

  async function releaseUnusedSiteAccess(sites) {
    const { origins = [] } = await api.permissions.getAll();
    const unused = origins.filter((origin) => {
      const host = /^\*:\/\/\*\.([a-z\d.-]+)\/\*$/.exec(origin)?.[1];
      return host && !sites.some((site) => site === host || site.endsWith(`.${host}`));
    });
    if (unused.length) await api.permissions.remove({ origins: unused });
  }

  async function sync(state, previous, { tabId, activated } = {}) {
    const sites = distractionSites(state.settings);
    const permitted = shouldBlock(state, now()) ? await permittedSites(api.permissions, sites) : [];
    const domains = shouldBlock(state, now()) ? permitted.sort((a, b) => b.length - a.length) : [];
    const wanted = buildSiteRules(domains, redirectUrl);
    const old = await api.declarativeNetRequest.getSessionRules();
    if (!sameRules(old, wanted)) {
      await api.declarativeNetRequest.updateSessionRules({
        removeRuleIds: old.map(({ id }) => id),
        addRules: wanted,
      });
    }
    if (sites.length < distractionSites(previous.settings).length) {
      await releaseUnusedSiteAccess(sites).catch((error) => {
        console.warn("Timebit could not release unused website access.", error);
      });
    }

    const scanKey = domains.length ? JSON.stringify([state.timer.runId, domains]) : null;
    if (scanKey && scanKey !== scanned) {
      const tabs = await api.tabs.query({});
      for (const tab of tabs) {
        if (tab.active) await rememberTab(tab, sites);
      }
      await Promise.allSettled(tabs.filter((tab) => !tab.pendingUrl).map((tab) => visitTab(tab, domains, state)));
    }
    scanned = scanKey;
    if (Number.isInteger(tabId) && (domains.length || (activated && state.settings.blockDistractions))) {
      await inspectTab(tabId, domains, sites, state, activated);
    }
    return domains;
  }

  async function returnToStudy(tab, state) {
    const fallback = { url: api.runtime.getURL("popup/popup.html") };
    const stored = await api.storage.session.get(LAST_STUDY_TABS);
    const previousId = stored[LAST_STUDY_TABS]?.[tab.windowId];
    if (Number.isInteger(previousId) && previousId !== tab.id) {
      try {
        const previous = await api.tabs.get(previousId);
        if (previous.windowId === tab.windowId && isStudyTab(previous, distractionSites(state.settings))) {
          await api.tabs.update(previousId, { active: true });
          return;
        }
      } catch {
        // The study tab may have closed.
      }
    }
    await api.tabs.update(tab.id, fallback);
  }

  return { sync, returnToStudy };
}
