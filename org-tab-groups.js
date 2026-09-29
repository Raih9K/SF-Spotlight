// Org-wise browser tab groups.
// When "orgTabGroups" is on in the Spotlight settings, every Salesforce tab is put
// into a Chrome tab group named after its org (one group per org per window).
// Off by default; turning it off ungroups the tabs this feature grouped.
(() => {
  const chromeApi = globalThis.chrome;
  if (!chromeApi?.tabs?.group || !chromeApi?.tabGroups) return;

  const SETTINGS_KEY = "sf_log_analyzer_settings";
  // Groups we own carry this marker so user-made groups are never touched
  const MARK = "☁ ";
  const COLORS = ["blue", "green", "purple", "cyan", "orange", "pink", "yellow", "red", "grey"];
  const SF_HOST =
    /\.(salesforce|salesforce-setup|force|cloudforce|visualforce|sfcrmapps|sfcrmproducts|crmforce)\.(com|mil|cn)(\.mcas\.ms)?$|\.salesforce-experience\.com$/i;

  let enabled = false;

  // "acme--uat.sandbox.lightning.force.com" → { key: "acme--uat", title: "acme · uat" }
  function orgFromUrl(url) {
    let host;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      return null;
    }
    if (!SF_HOST.test(host)) return null;
    let name = host.split(".")[0];
    // Visualforce hosts append "--c" or "--<namespace>" to the My Domain name
    if (/\.(vf|visual)\.force\.|\.visualforce\./.test(host)) name = name.replace(/--[a-z0-9_]+$/, "");
    if (!name || name === "login" || name === "test" || name === "www") return null;
    const [base, sandbox] = name.split("--");
    return { key: name, title: `${MARK}${sandbox ? `${base} · ${sandbox}` : base}` };
  }

  function colorFor(key) {
    let h = 0;
    for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return COLORS[h % COLORS.length];
  }

  async function ownGroup(groupId) {
    if (groupId === -1 || groupId == null) return null;
    try {
      const g = await chromeApi.tabGroups.get(groupId);
      return g.title?.startsWith(MARK) ? g : null;
    } catch {
      return null;
    }
  }

  async function placeTab(tab) {
    if (!enabled || !tab?.id || !tab.url || tab.pinned) return;
    const org = orgFromUrl(tab.url);
    const current = tab.groupId ?? -1;
    if (!org) {
      // Left Salesforce: drop it from our group, leave user groups alone
      if (current !== -1 && (await ownGroup(current))) await chromeApi.tabs.ungroup(tab.id).catch(() => {});
      return;
    }
    if (current !== -1) {
      const g = await ownGroup(current);
      if (!g) return; // user put it in their own group — respect that
      if (g.title === org.title) return; // already in the right group
    }
    const [existing] = await chromeApi.tabGroups.query({ windowId: tab.windowId, title: org.title }).catch(() => []);
    if (existing) {
      await chromeApi.tabs.group({ tabIds: tab.id, groupId: existing.id }).catch(() => {});
    } else {
      const groupId = await chromeApi.tabs.group({ tabIds: tab.id, createProperties: { windowId: tab.windowId } }).catch(() => null);
      groupId != null &&
        (await chromeApi.tabGroups.update(groupId, { title: org.title, color: colorFor(org.key) }).catch(() => {}));
    }
  }

  // One tab at a time, so two tabs of the same org can't each create a group
  let queue = Promise.resolve();
  const enqueue = (tab) => (queue = queue.then(() => placeTab(tab)).catch(() => {}));

  async function groupAll() {
    const tabs = await chromeApi.tabs.query({}).catch(() => []);
    tabs.forEach(enqueue);
  }

  async function ungroupAll() {
    const groups = await chromeApi.tabGroups.query({}).catch(() => []);
    for (const g of groups) {
      if (!g.title?.startsWith(MARK)) continue;
      const tabs = await chromeApi.tabs.query({ groupId: g.id }).catch(() => []);
      tabs.length && (await chromeApi.tabs.ungroup(tabs.map((t) => t.id)).catch(() => {}));
    }
  }

  function applySetting(value) {
    const next = value === true;
    if (next === enabled) return;
    enabled = next;
    enabled ? groupAll() : ungroupAll();
  }

  chromeApi.storage?.local?.get([SETTINGS_KEY], (o) => applySetting(o?.[SETTINGS_KEY]?.orgTabGroups));
  chromeApi.storage?.onChanged?.addListener((changes, area) => {
    if (area === "local" && changes[SETTINGS_KEY]) applySetting(changes[SETTINGS_KEY].newValue?.orgTabGroups);
  });

  chromeApi.tabs.onUpdated.addListener((tabId, info, tab) => {
    if (enabled && (info.url || info.status === "complete")) enqueue(tab);
  });
  chromeApi.tabs.onCreated.addListener((tab) => {
    if (enabled && (tab.url || tab.pendingUrl)) enqueue({ ...tab, url: tab.url || tab.pendingUrl });
  });
})();
