export const PRESET_SITES = Object.freeze([
  { domain: "youtube.com", name: "YouTube", icon: "youtube" },
  { domain: "instagram.com", name: "Instagram", icon: "instagram" },
  { domain: "reddit.com", name: "Reddit", icon: "reddit" },
]);

export const REDIRECT_PATH = "redirect/index.html";

export function webUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol === "http:" || url.protocol === "https:") return url;
  } catch {
    // Empty, malformed, and non-web tab URLs are outside the block list.
  }
  return null;
}

export function normalizeDomain(value) {
  if (typeof value !== "string") return null;
  const input = value.trim();
  if (!input || /\s|\\/.test(input)) return null;
  const url = webUrl(input.includes("://") ? input : `https://${input}`);
  if (!url || url.username || url.password) return null;
  const host = url.hostname.replace(/\.$/, "");
  const label = /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/;
  return host.length <= 253 && (host === "localhost" || host.includes("."))
    && host.split(".").every((part) => label.test(part)) ? host : null;
}

export function distractionSites(settings) {
  return settings.distractionSites ?? PRESET_SITES.map(({ domain }) => domain);
}

export function siteOrigin(domain) {
  return `*://*.${domain}/*`;
}

export function matchingSite(url, domains) {
  const host = webUrl(url)?.hostname.replace(/\.$/, "");
  return domains.find((domain) => host === domain || host?.endsWith(`.${domain}`));
}

export function shouldBlock(state, now) {
  const { timer, settings } = state;
  return settings.blockDistractions === true && timer.phase === "study"
    && timer.status === "running" && now < timer.endsAt;
}

export async function permittedSites(permissions, domains) {
  const grants = await Promise.all(domains.map((domain) => permissions.contains({ origins: [siteOrigin(domain)] })));
  return domains.filter((domain, index) => grants[index]);
}

export function applyDistractionCommand(state, command) {
  const { settings } = state;
  const sites = distractionSites(settings);
  let changes;
  if (command.type === "distractions.set") {
    if (typeof command.enabled !== "boolean") return { state, error: "Choose a valid blocking preference." };
    if ((settings.blockDistractions === true) === command.enabled) return { state };
    changes = { blockDistractions: command.enabled };
  } else {
    const domain = normalizeDomain(command.domain);
    if (!domain) return { state, error: "Enter a website domain or an HTTP or HTTPS address." };
    if (command.type === "distractions.add") {
      if (sites.includes(domain)) return { state, error: "This website is already in your list." };
      changes = { distractionSites: [...sites, domain] };
    } else {
      if (!sites.includes(domain)) return { state };
      changes = { distractionSites: sites.filter((site) => site !== domain) };
    }
  }
  return { state: { ...state, settings: { ...settings, ...changes }, revision: state.revision + 1 } };
}
