// SFPilot AI Agent: natural-language Salesforce assistant.
// Runs in the same isolated world as content-ui.js and reuses its globals:
// $e, Wo, kt, it, globalPrefs, AI_PROVIDERS, callAIProvider.
// Reads run automatically; every write (DML, Apex save) waits for user approval
// unless "Auto-approve writes" is switched on for the session.

const AGENT_MAX_STEPS = 10;
const AGENT_RESULT_LIMIT = 8000;
const AGENT_TRANSCRIPT_LIMIT = 60000;
const AGENT_WRITE_TYPES = new Set(["create", "update", "delete", "saveApex", "deployMetadata"]);

const agentApiVersion = () => (/^\d+\.\d+$/.test(globalPrefs.apiVersion || "") ? globalPrefs.apiVersion : "60.0");

const AGENT_SYSTEM_PROMPT = () => `You are SFPilot Agent, an assistant operating inside a Salesforce org through its APIs (API v${agentApiVersion()}).

Respond with ONE JSON object and nothing else (no markdown fences, no prose outside JSON).

To act, respond:
{"thought": "one short sentence on what you are doing", "actions": [ ...one or more actions... ]}

To finish, respond:
{"final": "answer for the user in Markdown"}

Available actions:
- {"type":"describe","sobject":"Account"} — field list for an object (always describe before writing to an object you have not described).
- {"type":"query","soql":"SELECT Id, Name FROM Account LIMIT 10","tooling":false} — SOQL; set "tooling":true for Tooling API objects (ApexClass, ApexTrigger, ApexTestResult, ...).
- {"type":"search","sosl":"FIND {Acme*} IN NAME FIELDS RETURNING Account(Id, Name), Contact(Id, Name)"}
- {"type":"create","sobject":"Contact","records":[{"LastName":"Doe"}]}
- {"type":"update","sobject":"Contact","records":[{"Id":"003...","Title":"CEO"}]} — every record needs Id.
- {"type":"delete","ids":["003...","003..."]}
- {"type":"getApex","kind":"ApexClass","name":"MyClass"} — kind is ApexClass or ApexTrigger; returns the full source.
- {"type":"saveApex","kind":"ApexClass","name":"MyClass","body":"full source"} — quick create/update of ONE Apex class in sandbox/dev orgs. For production orgs, triggers, or anything else use deployMetadata.
- {"type":"getLwc","name":"myComponent"} — returns every file of an existing LWC bundle.
- {"type":"deployMetadata","files":{"<path>":"<content>", ...},"types":[{"name":"LightningComponentBundle","members":["myComponent"]}],"testLevel":"NoTestRun"}
  Deploys via the Metadata API (works in production too). package.xml is generated from "types" — do not include it.
  Paths use Metadata API (mdapi) format, NOT SFDX source format:
    lwc/myComponent/myComponent.js, lwc/myComponent/myComponent.html, lwc/myComponent/myComponent.js-meta.xml (all required; .css optional)
    aura/myCmp/myCmp.cmp + aura/myCmp/myCmp.cmp-meta.xml (+ myCmpController.js, myCmpHelper.js ...)
    classes/MyClass.cls + classes/MyClass.cls-meta.xml ; triggers/MyTrigger.trigger + triggers/MyTrigger.trigger-meta.xml
    pages/MyPage.page + pages/MyPage.page-meta.xml
    objects/Account.object — a <CustomObject> containing only the <fields> being added/changed; type CustomField, members "Account.My_Field__c"
    layouts/Account-Account Layout.layout ; flows/My_Flow.flow ; permissionsets/My_Set.permissionset ; profiles/Admin.profile
  Every file is the COMPLETE file. Always getLwc / getApex first when updating existing components, and keep unrelated code intact.
  testLevel: "NoTestRun" for sandboxes and non-Apex deploys; production deploys containing Apex need "RunLocalTests".
  New custom fields are invisible until field-level security is granted — deploy a permissionset or profile with <fieldPermissions> in the same deploy.

Rules:
- Gather what you need with read actions before writing. Never invent record Ids — query them.
- Never write to read-only fields (formula, auto-number, system fields).
- Keep SOQL selective and use LIMIT.
- Results of your actions arrive in the next message as "RESULTS". If an action failed, fix it and retry, or explain.
- Write actions may be rejected by the user; respect that and do not retry the same write.
- "final" must summarise what was done, with record names and counts. Do not output Ids alone.`;

// ---------- Salesforce REST (via background, avoids CORS) ----------

async function agentRest(method, path, body) {
  const s = await it();
  if (!s?.instanceUrl || !s?.sessionId) throw new Error("Salesforce session not detected");
  const res = await new Promise((resolve) =>
    globalThis.chrome.runtime.sendMessage(
      {
        type: "REST_EXPLORE",
        instanceUrl: s.instanceUrl,
        sessionId: s.sessionId,
        endpoint: path,
        method,
        body: body == null ? undefined : JSON.stringify(body),
      },
      (r) => resolve(r || { success: !1, error: "No response from extension" }),
    ),
  );
  if (!res.success) throw new Error(res.error || "Request failed");
  let data = null;
  try {
    data = res.data.body ? JSON.parse(res.data.body) : null;
  } catch {
    data = res.data.body;
  }
  if (!res.data.ok) {
    const msg = Array.isArray(data) ? data.map((e) => e.message).join("; ") : data?.message || res.data.body;
    throw new Error(`HTTP ${res.data.status}: ${String(msg).slice(0, 500)}`);
  }
  return data;
}

const agentData = (p) => `/services/data/v${agentApiVersion()}${p}`;

async function agentQueryAll(soql, tooling) {
  let data = await agentRest("GET", agentData(`/${tooling ? "tooling/" : ""}query/?q=${encodeURIComponent(soql)}`));
  const records = [...(data.records || [])];
  while (data.nextRecordsUrl && records.length < 2000) {
    data = await agentRest("GET", data.nextRecordsUrl);
    records.push(...(data.records || []));
  }
  return { totalSize: data.totalSize ?? records.length, records };
}

const stripAttributes = (v) => {
  if (Array.isArray(v)) return v.map(stripAttributes);
  if (v && typeof v == "object") {
    const o = {};
    for (const k of Object.keys(v)) if (k !== "attributes") o[k] = stripAttributes(v[k]);
    return o;
  }
  return v;
};

async function agentChunked(records, fn) {
  const out = [];
  for (let i = 0; i < records.length; i += 200) out.push(...(await fn(records.slice(i, i + 200))));
  return out;
}

const summariseDml = (results) => {
  const ok = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);
  return {
    succeeded: ok.length,
    failed: failed.length,
    ids: ok.map((r) => r.id).filter(Boolean),
    errors: failed.map((r) => (r.errors || []).map((e) => e.message).join("; ")),
  };
};

async function agentGetApex(kind, name) {
  const { records } = await agentQueryAll(
    `SELECT Id, Name, Body FROM ${kind} WHERE Name = '${String(name).replace(/'/g, "\\'")}' LIMIT 1`,
    !0,
  );
  return records[0] || null;
}

// Updating existing Apex needs a MetadataContainer; creating can POST the sObject directly.
async function agentSaveApex(kind, name, body) {
  const existing = await agentGetApex(kind, name);
  if (!existing) {
    if (kind === "ApexTrigger")
      throw new Error("Creating new triggers is not supported here; create the trigger in Setup first, then ask again.");
    const r = await agentRest("POST", agentData(`/tooling/sobjects/${kind}`), { Name: name, Body: body });
    return { created: !0, id: r.id };
  }
  const container = await agentRest("POST", agentData("/tooling/sobjects/MetadataContainer"), {
    Name: `SFPilot_${Date.now()}`.slice(0, 32),
  });
  try {
    await agentRest("POST", agentData(`/tooling/sobjects/${kind}Member`), {
      MetadataContainerId: container.id,
      ContentEntityId: existing.Id,
      Body: body,
    });
    const req = await agentRest("POST", agentData("/tooling/sobjects/ContainerAsyncRequest"), {
      MetadataContainerId: container.id,
      IsCheckOnly: !1,
    });
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      const st = await agentRest("GET", agentData(`/tooling/sobjects/ContainerAsyncRequest/${req.id}`));
      if (st.State === "Completed") return { updated: !0, id: existing.Id };
      if (st.State === "Queued") continue;
      const msgs = (st.DeployDetails?.componentFailures || [])
        .map((f) => `${f.fullName || name} line ${f.lineNumber ?? "?"}: ${f.problem}`)
        .join("\n");
      throw new Error(`Deploy ${st.State}: ${msgs || st.ErrorMsg || "unknown error"}`);
    }
    throw new Error("Deploy timed out");
  } finally {
    agentRest("DELETE", agentData(`/tooling/sobjects/MetadataContainer/${container.id}`)).catch(() => {});
  }
}

// --- Minimal ZIP writer (stored, no compression) for Metadata API deploys ---
const agentCrcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const agentCrc32 = (bytes) => {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = agentCrcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

function agentZip(files) {
  const enc = new TextEncoder();
  const parts = [],
    central = [];
  let offset = 0;
  for (const [path, content] of Object.entries(files)) {
    const name = enc.encode(path),
      data = enc.encode(content),
      crc = agentCrc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, !0);
    local.setUint16(4, 20, !0);
    local.setUint16(6, 0x0800, !0); // UTF-8 names
    local.setUint32(14, crc, !0);
    local.setUint32(18, data.length, !0);
    local.setUint32(22, data.length, !0);
    local.setUint16(26, name.length, !0);
    parts.push(new Uint8Array(local.buffer), name, data);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, !0);
    cd.setUint16(4, 20, !0);
    cd.setUint16(6, 20, !0);
    cd.setUint16(8, 0x0800, !0);
    cd.setUint32(16, crc, !0);
    cd.setUint32(20, data.length, !0);
    cd.setUint32(24, data.length, !0);
    cd.setUint16(28, name.length, !0);
    cd.setUint32(42, offset, !0);
    central.push(new Uint8Array(cd.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const cdSize = central.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, !0);
  end.setUint16(8, Object.keys(files).length, !0);
  end.setUint16(10, Object.keys(files).length, !0);
  end.setUint32(12, cdSize, !0);
  end.setUint32(16, offset, !0);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let pos = 0;
  for (const p of all) out.set(p, pos), (pos += p.length);
  return out;
}

const agentBase64 = (bytes) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

const agentXmlEscape = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function agentPackageXml(types) {
  const body = (types || [])
    .map(
      (t) =>
        `    <types>\n${(t.members || []).map((m) => `        <members>${agentXmlEscape(m)}</members>\n`).join("")}        <name>${agentXmlEscape(t.name)}</name>\n    </types>\n`,
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n${body}    <version>${agentApiVersion()}</version>\n</Package>\n`;
}

async function agentGetLwc(name) {
  const safe = String(name).replace(/'/g, "\\'");
  const { records: bundles } = await agentQueryAll(
    `SELECT Id FROM LightningComponentBundle WHERE DeveloperName = '${safe}' AND NamespacePrefix = null LIMIT 1`,
    !0,
  );
  if (!bundles.length) return null;
  const { records } = await agentQueryAll(
    `SELECT FilePath, Source FROM LightningComponentResource WHERE LightningComponentBundleId = '${bundles[0].Id}'`,
    !0,
  );
  const files = {};
  for (const r of records) files[r.FilePath] = r.Source;
  return files;
}

// Existing source for a deploy path, used for the approval diff ("" when new or unknown).
async function agentExistingSource(path) {
  let m = path.match(/^lwc\/([^/]+)\//);
  if (m) return (await agentGetLwc(m[1]).catch(() => null))?.[path] || "";
  m = path.match(/^classes\/([^/]+)\.cls$/);
  if (m) return (await agentGetApex("ApexClass", m[1]).catch(() => null))?.Body || "";
  m = path.match(/^triggers\/([^/]+)\.trigger$/);
  if (m) return (await agentGetApex("ApexTrigger", m[1]).catch(() => null))?.Body || "";
  return "";
}

async function agentDeployMetadata(action) {
  const files = { ...(action.files || {}) };
  if (!Object.keys(files).length) throw new Error("deployMetadata needs at least one file");
  if (!action.types?.length) throw new Error("deployMetadata needs a types list for package.xml");
  delete files["package.xml"];
  files["package.xml"] = agentPackageXml(action.types);
  const s = await it();
  if (!s?.instanceUrl || !s?.sessionId) throw new Error("Salesforce session not detected");
  const started = await new Promise((resolve) =>
    globalThis.chrome.runtime.sendMessage(
      {
        type: "METADATA_DEPLOY",
        instanceUrl: s.instanceUrl,
        sessionId: s.sessionId,
        apiVersion: agentApiVersion(),
        zipBase64: agentBase64(agentZip(files)),
        deployOptions: {
          singlePackage: !0,
          rollbackOnError: !0,
          checkOnly: !1,
          testLevel: action.testLevel || "NoTestRun",
        },
      },
      (r) => resolve(r || { success: !1, error: "No response from extension" }),
    ),
  );
  if (!started.success) throw new Error(started.error || "Deploy request failed");
  const id = started.id;
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const st = await agentRest("GET", agentData(`/metadata/deployRequest/${id}?includeDetails=true`));
    const res = st.deployResult || {};
    if (!res.done) continue;
    const det = res.details || {};
    const failures = [].concat(det.componentFailures || []).map((f) => `${f.fileName || f.fullName}: ${f.problem}`);
    const testFailures = [].concat(det.runTestResult?.failures || []).map((f) => `${f.name}.${f.methodName}: ${f.message}`);
    if (!res.success)
      throw new Error(`Deploy ${res.status}: ${[...failures, ...testFailures].join("\n") || res.errorMessage || "unknown error"}`);
    return { status: res.status, deployed: res.numberComponentsDeployed, id };
  }
  throw new Error(`Deploy ${id} still running after 4 minutes — check Setup → Deployment Status`);
}

async function agentExecute(action) {
  switch (action.type) {
    case "describe": {
      const d = await agentRest("GET", agentData(`/sobjects/${encodeURIComponent(action.sobject)}/describe`));
      return {
        name: d.name,
        label: d.label,
        fields: d.fields.map((f) => {
          const parts = [f.name, f.type];
          if (!f.nillable && f.createable && !f.defaultedOnCreate) parts.push("required");
          if (!f.createable && !f.updateable) parts.push("readonly");
          if (f.referenceTo?.length) parts.push(`ref:${f.referenceTo.join("/")}`);
          if (f.picklistValues?.length)
            parts.push(`values:${f.picklistValues.filter((p) => p.active).slice(0, 25).map((p) => p.value).join("|")}`);
          return parts.join(" ");
        }),
      };
    }
    case "query": {
      const r = await agentQueryAll(action.soql, !!action.tooling);
      return { totalSize: r.totalSize, records: stripAttributes(r.records) };
    }
    case "search": {
      const r = await agentRest("GET", agentData(`/search/?q=${encodeURIComponent(action.sosl)}`));
      return { records: stripAttributes(r.searchRecords || []) };
    }
    case "create": {
      const recs = action.records.map((r) => ({ attributes: { type: action.sobject }, ...r }));
      return summariseDml(
        await agentChunked(recs, (chunk) =>
          agentRest("POST", agentData("/composite/sobjects"), { allOrNone: !1, records: chunk }),
        ),
      );
    }
    case "update": {
      const recs = action.records.map((r) => ({ attributes: { type: action.sobject }, ...r }));
      return summariseDml(
        await agentChunked(recs, (chunk) =>
          agentRest("PATCH", agentData("/composite/sobjects"), { allOrNone: !1, records: chunk }),
        ),
      );
    }
    case "delete":
      return summariseDml(
        await agentChunked(action.ids, (chunk) =>
          agentRest("DELETE", agentData(`/composite/sobjects?allOrNone=false&ids=${chunk.join(",")}`)),
        ),
      );
    case "getApex": {
      const r = await agentGetApex(action.kind, action.name);
      return r ? { name: r.Name, body: r.Body } : { notFound: !0 };
    }
    case "saveApex":
      return agentSaveApex(action.kind, action.name, action.body);
    case "getLwc": {
      const files = await agentGetLwc(action.name);
      return files ? { name: action.name, files } : { notFound: !0 };
    }
    case "deployMetadata":
      return agentDeployMetadata(action);
    default:
      throw new Error(`Unknown action type "${action.type}"`);
  }
}

// ---------- helpers ----------

function agentParseJson(text) {
  let t = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  try {
    return JSON.parse(t);
  } catch {
    const a = t.indexOf("{"),
      b = t.lastIndexOf("}");
    if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
    throw new Error("AI did not return valid JSON");
  }
}

function agentMarkdown(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/```\w*\n([\s\S]*?)```/g, '<pre style="background:rgba(127,127,127,0.12);padding:8px;border-radius:6px;overflow-x:auto;white-space:pre">$1</pre>')
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/^#{1,6} (.+)$/gm, "<b>$1</b>")
    .replace(/^[-*] (.+)$/gm, "• $1")
    .replace(/\n/g, "<br>");
}

// Line diff (LCS); falls back to "replace everything" for very large inputs.
function agentLineDiff(before, after) {
  const a = String(before || "").split("\n"),
    b = String(after || "").split("\n");
  if (a.length * b.length > 4e6) return [...a.map((l) => ["-", l]), ...b.map((l) => ["+", l])];
  const dp = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0,
    j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) out.push([" ", a[i++]]), j++;
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push(["-", a[i++]]);
    else out.push(["+", b[j++]]);
  }
  while (i < a.length) out.push(["-", a[i++]]);
  while (j < b.length) out.push(["+", b[j++]]);
  return out;
}

const agentEscape = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function agentRecordsTable(records, th) {
  const cols = [...new Set(records.flatMap((r) => Object.keys(r)))].filter((c) => c !== "attributes").slice(0, 12);
  const cell = (v) => agentEscape(v && typeof v == "object" ? JSON.stringify(v) : v);
  return (
    `<table style="border-collapse:collapse;font-size:11.5px;width:100%"><tr>${cols
      .map((c) => `<th style="text-align:left;padding:4px 6px;border-bottom:1px solid ${th.border}">${agentEscape(c)}</th>`)
      .join("")}</tr>` +
    records
      .slice(0, 50)
      .map(
        (r) =>
          `<tr>${cols.map((c) => `<td style="padding:3px 6px;border-bottom:1px solid ${th.divider}">${cell(r[c])}</td>`).join("")}</tr>`,
      )
      .join("") +
    `</table>${records.length > 50 ? `<div style="opacity:.7;margin-top:4px">…and ${records.length - 50} more</div>` : ""}`
  );
}

// ---------- UI ----------

function renderAIAgent(container, isDark, onBack, flashToast) {
  container.innerHTML = "";
  const th = kt(isDark);
  let autoApprove = !1;
  let running = !1;
  let cancelled = !1;
  let transcript = [];

  const root = $e("div", {
    height: "100%",
    minHeight: "0",
    display: "flex",
    flexDirection: "column",
    background: th.bg,
    color: th.text,
  });
  container.appendChild(root);

  const { head, right } = Wo(th, "🧠 AI Agent", onBack, "Tools");
  root.appendChild(head);

  const providerTag = $e("select", {
    padding: "5px 8px",
    fontSize: "12px",
    fontWeight: "600",
    borderRadius: "8px",
    border: `1px solid ${th.border}`,
    background: th.inputBg,
    color: th.text,
    fontFamily: "inherit",
    cursor: "pointer",
    maxWidth: "280px",
  });
  providerTag.title = "Model (providers with an API key in Settings)";
  const autoLabel = $e("label", {
    display: "inline-flex",
    alignItems: "center",
    gap: "6px",
    fontSize: "12px",
    color: th.text,
    cursor: "pointer",
  });
  const autoBox = document.createElement("input");
  autoBox.type = "checkbox";
  autoBox.addEventListener("change", () => (autoApprove = autoBox.checked));
  autoLabel.appendChild(autoBox);
  autoLabel.appendChild(document.createTextNode("Auto-approve writes"));
  const btnStyle = {
    padding: "6px 12px",
    fontSize: "12px",
    fontWeight: "700",
    borderRadius: "8px",
    border: `1px solid ${th.border}`,
    background: "transparent",
    color: th.text,
    cursor: "pointer",
  };
  const newChatBtn = $e("button", btnStyle, "New chat");
  right.appendChild(providerTag);
  right.appendChild(autoLabel);
  right.appendChild(newChatBtn);

  // Model switcher: every model of every provider that has a key ("connected").
  // OpenRouter's full catalogue is fetched live once per session.
  const refreshProviderTag = () => {
    const current = AI_PROVIDERS[globalPrefs.aiProvider] ? globalPrefs.aiProvider : "gemini";
    const currentModel = resolveAIModel(current);
    providerTag.innerHTML = "";
    let any = !1;
    for (const [id, p] of Object.entries(AI_PROVIDERS)) {
      if (!globalPrefs[p.prefKey]) continue;
      any = !0;
      const group = document.createElement("optgroup");
      group.label = p.name;
      const seen = new Set();
      const models = aiModelsFor(id);
      if (id === current && !models.some((m) => m.id === currentModel)) models.unshift({ id: currentModel, name: currentModel });
      for (const m of models) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        const o = document.createElement("option");
        o.value = `${id}::${m.id}`;
        o.textContent = m.name;
        group.appendChild(o);
      }
      providerTag.appendChild(group);
    }
    if (!any) {
      const o = document.createElement("option");
      o.textContent = "No AI key — add one in Settings";
      o.disabled = !0;
      o.selected = !0;
      providerTag.appendChild(o);
      return;
    }
    providerTag.value = `${current}::${currentModel}`;
  };
  providerTag.addEventListener("change", () => {
    const [id, ...rest] = providerTag.value.split("::");
    const model = rest.join("::");
    saveGlobalPrefs({ aiProvider: id, aiModel: model, aiCustomModel: "" });
  });
  refreshProviderTag();
  if (globalPrefs.openrouterApiKey && !aiOpenRouterModels) loadOpenRouterModels().then((ok) => ok && refreshProviderTag());

  const messages = $e("div", {
    flex: "1",
    minHeight: "0",
    overflowY: "auto",
    padding: "16px 24px",
    display: "flex",
    flexDirection: "column",
    gap: "10px",
    fontSize: "13px",
    lineHeight: "1.5",
  });
  root.appendChild(messages);

  const welcome = () => {
    messages.innerHTML = "";
    const w = $e("div", { color: th.muted, fontSize: "13px", margin: "auto", textAlign: "center", maxWidth: "520px" });
    w.innerHTML =
      "Ask in plain language — e.g. <i>“Create 3 demo opportunities for Acme”</i>, <i>“Close all cases older than 90 days”</i>, <i>“Add null checks to the AccountService class”</i>.<br><br>Reads run automatically. Every write shows a preview and waits for your approval.";
    messages.appendChild(w);
  };
  welcome();

  const inputRow = $e("div", {
    display: "flex",
    gap: "8px",
    padding: "12px 24px 16px",
    borderTop: `1px solid ${th.divider}`,
    flexShrink: "0",
  });
  root.appendChild(inputRow);
  const input = $e("textarea", {
    flex: "1",
    padding: "9px 12px",
    fontSize: "13px",
    borderRadius: "9px",
    border: `1px solid ${th.border}`,
    background: th.inputBg,
    color: th.text,
    outline: "none",
    resize: "none",
    height: "44px",
    fontFamily: "inherit",
  });
  input.placeholder = "Tell the agent what to do…  (Ctrl/⌘ + Enter to send)";
  inputRow.appendChild(input);
  const sendBtn = $e(
    "button",
    { ...btnStyle, background: th.accent, color: "#fff", border: "none", padding: "0 18px", fontSize: "13px" },
    "Send",
  );
  inputRow.appendChild(sendBtn);

  const scroll = () => (messages.scrollTop = messages.scrollHeight);

  const bubble = (role, html) => {
    if (messages.firstChild && !messages.querySelector("[data-msg]")) messages.innerHTML = "";
    const user = role === "user";
    const b = $e("div", {
      alignSelf: user ? "flex-end" : "stretch",
      maxWidth: user ? "80%" : "100%",
      padding: user ? "8px 12px" : "4px 0",
      borderRadius: "10px",
      background: user ? th.accentSoft : "transparent",
      color: th.text,
      whiteSpace: user ? "pre-wrap" : "normal",
      wordBreak: "break-word",
    });
    b.dataset.msg = role;
    if (user) b.textContent = html;
    else b.innerHTML = html;
    messages.appendChild(b);
    scroll();
    return b;
  };

  const stepCard = (title) => {
    const card = $e("div", {
      border: `1px solid ${th.border}`,
      borderRadius: "9px",
      padding: "8px 10px",
      fontSize: "12px",
      background: th.card,
    });
    card.dataset.msg = "step";
    const hdr = $e("div", { fontWeight: "700", display: "flex", gap: "8px", alignItems: "center" });
    const status = $e("span", { color: th.muted }, "⏳");
    hdr.appendChild(status);
    hdr.appendChild($e("span", void 0, title));
    card.appendChild(hdr);
    const body = $e("div", { marginTop: "6px", display: "none", maxHeight: "260px", overflow: "auto" });
    card.appendChild(body);
    hdr.style.cursor = "pointer";
    hdr.addEventListener("click", () => (body.style.display = body.style.display === "none" ? "block" : "none"));
    messages.appendChild(card);
    scroll();
    return {
      card,
      body,
      set(state, detailHtml) {
        status.textContent = state === "ok" ? "✅" : state === "fail" ? "❌" : state === "skip" ? "⏭" : "⏳";
        if (detailHtml != null) body.innerHTML = detailHtml;
      },
    };
  };

  const describeAction = (a) => {
    switch (a.type) {
      case "describe":
        return `Describe ${a.sobject}`;
      case "query":
        return `Query: ${String(a.soql).slice(0, 140)}`;
      case "search":
        return `Search: ${String(a.sosl).slice(0, 140)}`;
      case "create":
        return `Create ${a.records?.length || 0} ${a.sobject} record(s)`;
      case "update":
        return `Update ${a.records?.length || 0} ${a.sobject} record(s)`;
      case "delete":
        return `Delete ${a.ids?.length || 0} record(s)`;
      case "getApex":
        return `Read ${a.kind} ${a.name}`;
      case "saveApex":
        return `Save ${a.kind} ${a.name}`;
      case "getLwc":
        return `Read LWC ${a.name}`;
      case "deployMetadata":
        return `Deploy ${(a.types || []).map((t) => `${t.name}: ${(t.members || []).join(", ")}`).join(" · ") || "metadata"}`;
      default:
        return a.type;
    }
  };

  const previewHtml = async (a) => {
    if (a.type === "create" || a.type === "update") return agentRecordsTable(a.records || [], th);
    if (a.type === "delete") {
      let rows = (a.ids || []).map((id) => ({ Id: id }));
      // Show names so the user knows what is being deleted
      const byPrefix = {};
      for (const id of a.ids || []) (byPrefix[id.slice(0, 3)] ||= []).push(id);
      try {
        const named = [];
        for (const ids of Object.values(byPrefix)) {
          const r = await agentRest(
            "GET",
            agentData(`/composite/sobjects?ids=${ids.slice(0, 200).join(",")}&fields=Id,Name`),
          ).catch(() => null);
          if (Array.isArray(r)) named.push(...r.filter(Boolean).map((x) => ({ Id: x.Id, Name: x.Name, Type: x.attributes?.type })));
        }
        if (named.length) rows = named;
      } catch {}
      return agentRecordsTable(rows, th);
    }
    const diffHtml = (title, before, after) => {
      const diff = agentLineDiff(before, after);
      const added = diff.filter((d) => d[0] === "+").length,
        removed = diff.filter((d) => d[0] === "-").length;
      const lines = diff
        .map(([k, l]) => {
          const bg = k === "+" ? "rgba(34,197,94,0.18)" : k === "-" ? "rgba(239,68,68,0.18)" : "transparent";
          return `<div style="background:${bg};white-space:pre;padding:0 6px">${k} ${agentEscape(l)}</div>`;
        })
        .join("");
      return `<div style="margin:6px 0 4px;color:${th.muted}"><b style="color:${th.text}">${agentEscape(title)}</b> · ${before ? "update" : "new"} · <span style="color:${th.success}">+${added}</span> <span style="color:${th.danger}">−${removed}</span></div><div style="font-family:monospace;font-size:11.5px;max-height:280px;overflow:auto;border:1px solid ${th.divider};border-radius:6px">${lines}</div>`;
    };
    if (a.type === "saveApex") {
      let before = "";
      try {
        before = (await agentGetApex(a.kind, a.name))?.Body || "";
      } catch {}
      return diffHtml(`${a.kind} ${a.name}`, before, a.body);
    }
    if (a.type === "deployMetadata") {
      const entries = Object.entries(a.files || {}).filter(([p]) => p !== "package.xml");
      const befores = await Promise.all(entries.map(([p]) => agentExistingSource(p).catch(() => "")));
      return (
        `<div style="color:${th.muted}">Test level: <b>${agentEscape(a.testLevel || "NoTestRun")}</b> · ${entries.length} file(s)</div>` +
        entries.map(([p, c], i) => diffHtml(p, befores[i], c)).join("")
      );
    }
    return "";
  };

  const askApproval = (a) =>
    new Promise(async (resolve) => {
      const card = $e("div", {
        border: `1px solid ${th.warning}`,
        borderRadius: "9px",
        padding: "10px 12px",
        fontSize: "12px",
        background: th.card,
      });
      card.dataset.msg = "approval";
      card.appendChild($e("div", { fontWeight: "800", marginBottom: "6px" }, `Approve: ${describeAction(a)}?`));
      const prev = $e("div", { maxHeight: "360px", overflow: "auto", marginBottom: "8px" }, "Loading preview…");
      card.appendChild(prev);
      const row = $e("div", { display: "flex", gap: "8px", justifyContent: "flex-end" });
      const rej = $e("button", { ...btnStyle, color: th.danger, borderColor: th.danger }, "Reject");
      const ok = $e("button", { ...btnStyle, background: th.success, color: "#fff", border: "none" }, "Approve");
      row.appendChild(rej);
      row.appendChild(ok);
      card.appendChild(row);
      messages.appendChild(card);
      scroll();
      prev.innerHTML = await previewHtml(a);
      scroll();
      const done = (v) => {
        row.remove();
        card.style.borderColor = v ? th.success : th.border;
        card.appendChild($e("div", { color: v ? th.success : th.danger, fontWeight: "700" }, v ? "Approved" : "Rejected"));
        resolve(v);
      };
      ok.addEventListener("click", () => done(!0));
      rej.addEventListener("click", () => done(!1));
    });

  const resultHtml = (a, r) => {
    if (r?.records && Array.isArray(r.records))
      return `<div style="margin-bottom:4px">${r.totalSize ?? r.records.length} record(s)</div>${r.records.length ? agentRecordsTable(r.records, th) : ""}`;
    if (r?.fields) return `<pre style="margin:0;white-space:pre-wrap">${agentEscape(r.fields.join("\n"))}</pre>`;
    if (r?.body) return `<pre style="margin:0;white-space:pre">${agentEscape(r.body)}</pre>`;
    if (r?.files)
      return Object.entries(r.files)
        .map(([p, c]) => `<div style="font-weight:700;margin-top:6px">${agentEscape(p)}</div><pre style="margin:0;white-space:pre">${agentEscape(c)}</pre>`)
        .join("");
    return `<pre style="margin:0;white-space:pre-wrap">${agentEscape(JSON.stringify(r, null, 2))}</pre>`;
  };

  const buildPrompt = () => {
    let text = transcript.map((m) => `### ${m.role}\n${m.content}`).join("\n\n");
    if (text.length > AGENT_TRANSCRIPT_LIMIT) text = "…(earlier conversation trimmed)…\n" + text.slice(-AGENT_TRANSCRIPT_LIMIT);
    return `${text}\n\n### ASSISTANT (respond with JSON only)`;
  };

  const setRunning = (v) => {
    running = v;
    sendBtn.textContent = v ? "Stop" : "Send";
    sendBtn.style.background = v ? th.danger : th.accent;
    input.disabled = v;
  };

  async function runAgent(userText) {
    refreshProviderTag();
    const cfg = AI_PROVIDERS[globalPrefs.aiProvider] || AI_PROVIDERS.gemini;
    if (!globalPrefs[cfg.prefKey]) {
      bubble("assistant", `<span style="color:${th.danger}">${cfg.name} API key is not configured. Add it in Settings → AI Assistant.</span>`);
      return;
    }
    transcript.push({ role: "USER", content: userText });
    cancelled = !1;
    setRunning(!0);
    const thinking = bubble("assistant", `<span style="color:${th.muted}">Thinking…</span>`);
    try {
      for (let step = 0; step < AGENT_MAX_STEPS; step++) {
        if (cancelled) throw new Error("Stopped by user");
        const raw = await callAIProvider(buildPrompt(), { system: AGENT_SYSTEM_PROMPT(), maxTokens: 8192 });
        if (cancelled) throw new Error("Stopped by user");
        let reply;
        try {
          reply = agentParseJson(raw);
        } catch (err) {
          transcript.push({ role: "ASSISTANT", content: String(raw).slice(0, 2000) });
          transcript.push({ role: "RESULTS", content: `Your reply was not valid JSON (${err.message}). Reply again with ONE JSON object only.` });
          continue;
        }
        transcript.push({ role: "ASSISTANT", content: JSON.stringify(reply) });
        if (reply.final != null) {
          thinking.remove();
          bubble("assistant", agentMarkdown(reply.final));
          return;
        }
        const actions = Array.isArray(reply.actions) ? reply.actions : [];
        if (!actions.length) {
          transcript.push({ role: "RESULTS", content: 'No actions given. Either return actions or {"final": "..."}.' });
          continue;
        }
        if (reply.thought) thinking.innerHTML = `<span style="color:${th.muted}">${agentEscape(reply.thought)}</span>`;
        messages.appendChild(thinking);
        const results = [];
        for (const a of actions) {
          if (cancelled) throw new Error("Stopped by user");
          const isWrite = AGENT_WRITE_TYPES.has(a.type);
          if (isWrite && !autoApprove) {
            const approved = await askApproval(a);
            if (!approved) {
              results.push({ action: a.type, rejectedByUser: !0 });
              continue;
            }
          }
          const card = stepCard(describeAction(a));
          try {
            const r = await agentExecute(a);
            const failedDml = isWrite && r?.failed > 0;
            card.set(failedDml ? "fail" : "ok", resultHtml(a, r));
            if (failedDml) card.body.style.display = "block";
            let s = JSON.stringify(r);
            if (s.length > AGENT_RESULT_LIMIT) s = s.slice(0, AGENT_RESULT_LIMIT) + "…(truncated)";
            results.push({ action: a.type, ok: !0, result: s });
          } catch (err) {
            card.set("fail", `<span style="color:${th.danger}">${agentEscape(err.message)}</span>`);
            card.body.style.display = "block";
            results.push({ action: a.type, ok: !1, error: err.message });
          }
          messages.appendChild(thinking);
          scroll();
        }
        transcript.push({ role: "RESULTS", content: JSON.stringify(results) });
      }
      thinking.remove();
      bubble("assistant", `<span style="color:${th.warning}">Stopped after ${AGENT_MAX_STEPS} steps. Ask me to continue if needed.</span>`);
    } catch (err) {
      thinking.remove();
      bubble("assistant", `<span style="color:${th.danger}">${agentEscape(err.message)}</span>`);
      transcript.push({ role: "RESULTS", content: `Run aborted: ${err.message}` });
    } finally {
      setRunning(!1);
      input.focus();
    }
  }

  const send = () => {
    if (running) {
      cancelled = !0;
      return;
    }
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    bubble("user", text);
    runAgent(text);
  };
  sendBtn.addEventListener("click", send);
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
      ev.preventDefault();
      send();
    }
  });
  newChatBtn.addEventListener("click", () => {
    if (running) return flashToast?.("Stop the current run first");
    transcript = [];
    welcome();
  });
  setTimeout(() => input.focus(), 50);
}
