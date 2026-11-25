import { distractionSites, normalizeDomain, permittedSites, PRESET_SITES, siteOrigin } from "../core/distractions.js";

export function createDistractionControls(send) {
  const toggles = [...document.querySelectorAll("[data-block-setting]")];
  const list = document.getElementById("distraction-sites");
  const presets = document.getElementById("distraction-presets");
  const form = document.getElementById("add-distraction");
  const input = form.elements.namedItem("domain");
  const message = document.getElementById("distraction-message");
  let settings;
  let grants = [];
  let permissionCheck = 0;

  function button(label, action, domain) {
    const control = document.createElement("button");
    control.type = "button";
    control.textContent = label;
    control.dataset[action] = domain;
    return control;
  }

  function draw() {
    const domains = distractionSites(settings);
    const enabled = settings.blockDistractions === true;
    for (const toggle of toggles) toggle.checked = enabled;
    document.getElementById("missing-site-access").hidden = !enabled || domains.every((domain) => grants.includes(domain));

    const focused = document.activeElement;
    const previousLabel = focused?.getAttribute("aria-label");
    const restoreFocus = list.contains(focused) || presets.contains(focused);
    list.replaceChildren(...domains.map((domain) => {
      const row = document.createElement("li");
      row.className = "site-row";
      const preset = PRESET_SITES.find((site) => site.domain === domain);
      if (preset) {
        const icon = document.createElement("img");
        icon.src = `../assets/${preset.icon}.svg`;
        icon.alt = "";
        row.append(icon);
      }
      const name = document.createElement("span");
      name.textContent = domain;
      row.append(name);
      if (enabled && !grants.includes(domain)) {
        const access = button("Grant access", "grantSite", domain);
        access.setAttribute("aria-label", `Grant access to ${domain}`);
        row.append(access);
      }
      const remove = button("Remove", "removeSite", domain);
      remove.setAttribute("aria-label", `Remove ${domain}`);
      row.append(remove);
      return row;
    }));
    presets.replaceChildren(...PRESET_SITES.filter(({ domain }) => !domains.includes(domain)).map(({ domain, name }) => (
      button(`Add ${name}`, "addPreset", domain)
    )));
    presets.hidden = !presets.childElementCount;
    if (restoreFocus) {
      const target = [...list.querySelectorAll("button")].find((control) => control.getAttribute("aria-label") === previousLabel);
      (target ?? input).focus();
    }
  }

  async function refreshPermissions() {
    if (!settings) return;
    const check = ++permissionCheck;
    try {
      const available = await permittedSites(chrome.permissions, distractionSites(settings));
      if (check !== permissionCheck) return;
      grants = available;
      draw();
    } catch {
      message.textContent = "Could not check website access.";
    }
  }

  function requestAccess(domains) {
    if (!domains.length) return Promise.resolve();
    // Call directly from the gesture. Saving the preference can proceed if Chrome closes the popup.
    return chrome.permissions.request({ origins: domains.map(siteOrigin) }).then((granted) => {
      if (!granted) message.textContent = "Sites without access stay unblocked. Use Grant access to try again.";
    }, () => {
      message.textContent = "Could not request website access. Use Grant access to try again.";
    });
  }

  async function add(domainInput) {
    const domain = normalizeDomain(domainInput);
    if (!domain || distractionSites(settings).includes(domain)) {
      message.textContent = domain ? "This website is already in your list." : "Enter a website domain or an HTTP or HTTPS address.";
      input.focus();
      return false;
    }
    const access = settings.blockDistractions === true && requestAccess([domain]);
    const saved = await send({ type: "distractions.add", domain }, { status: message });
    await access;
    return saved;
  }

  for (const toggle of toggles) {
    toggle.addEventListener("change", async () => {
      const enabled = toggle.checked;
      const access = enabled && requestAccess(distractionSites(settings).filter((domain) => !grants.includes(domain)));
      if (!await send({ type: "distractions.set", enabled }, { status: message })) draw();
      await access;
    });
  }
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const value = input.value;
    if (await add(value) && input.value === value) input.value = "";
  });
  list.addEventListener("click", async (event) => {
    const control = event.target.closest("button");
    if (!control) return;
    if (control.dataset.removeSite) await send({ type: "distractions.remove", domain: control.dataset.removeSite }, { status: message });
    else {
      message.textContent = "";
      await requestAccess([control.dataset.grantSite]);
      await refreshPermissions();
    }
  });
  presets.addEventListener("click", (event) => {
    if (event.target.dataset.addPreset) add(event.target.dataset.addPreset);
  });
  chrome.permissions.onAdded.addListener(refreshPermissions);
  chrome.permissions.onRemoved.addListener(refreshPermissions);

  return (next) => {
    if (settings && settings.blockDistractions === next.blockDistractions
        && distractionSites(settings).join(",") === distractionSites(next).join(",")) return;
    settings = next;
    draw();
    refreshPermissions();
  };
}
