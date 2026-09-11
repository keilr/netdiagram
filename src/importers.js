"use strict";
/* Importers: scaffold a netdiagram spec from an existing inventory.
 *   Ansible   — INI or YAML inventory files, or `ansible-inventory --list` JSON
 *   Terraform — `terraform show -json` output or a raw .tfstate (v4)
 *   NetBox    — devices / virtual-machines API JSON ({results: [...]} or arrays)
 * Output is nodes + groups only: inventories don't describe traffic, so
 * connections are left for the author. Only addressing is read from host
 * variables — never other vars, which commonly hold credentials.
 * Runs in node (require) and in the browser, where the build concatenates it
 * after the core and it publishes window.Importers. */
(function (root) {
  const yamlLib = (typeof jsyaml !== "undefined") ? jsyaml : require("js-yaml");

  /* ---------- shared helpers ---------- */
  const slug = s => String(s).trim().replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "item";
  function idAllocator() {
    const used = new Set();
    return base => {
      const b = slug(base);
      let id = b, k = 2;
      while (used.has(id)) id = `${b}-${k++}`;
      used.add(id);
      return id;
    };
  }
  const IP_RE = /^(\d{1,3}(\.\d{1,3}){3}|[0-9a-f]{0,4}(:[0-9a-f]{0,4}){2,7})$/i;
  const stripPrefixLen = a => String(a).replace(/\/\d+$/, "");
  /* address -> {ip} when it is an IP literal, else a named attribute */
  const addrFields = (addr, key = "host") =>
    addr == null || addr === "" ? {} : IP_RE.test(stripPrefixLen(addr)) ? { ip: stripPrefixLen(addr) } : { [key]: String(addr) };

  /* name hints -> node type (null when nothing matches) */
  const TYPE_HINTS = [
    [/(^|[^a-z])(fw|firewall|pfsense|opnsense|fortigate|asa|paloalto)([^a-z]|$)/, "firewall"],
    [/(^|[^a-z])(sw|switch|leaf|spine)([^a-z]|$)/, "switch"],
    [/(^|[^a-z])(rtr|router|gw|gateway)([^a-z]|$)/, "router"],
    [/(^|[^a-z])(lb|haproxy|f5|loadbalancer|load-balancer)([^a-z]|$)/, "lb"],
    [/(postgres|pgsql|mysql|mariadb|mongo|redis|oracle|mssql|database)|(^|[^a-z])(db|pg|sql)([^a-z]|$)/, "db"],
    [/(^|[^a-z])(nas|san|storage|backup|ceph|minio)([^a-z]|$)/, "storage"],
    [/(^|[^a-z])(esxi?|kvm|proxmox|pve|hypervisor)([^a-z]|$)/, "hypervisor"],
    [/(^|[^a-z])(gpu|cuda)([^a-z]|$)/, "gpu"],
    [/(^|[^a-z])(siem|splunk|graylog|wazuh)([^a-z]|$)/, "siem"],
    [/(^|[^a-z])(ap|wifi|wlan)([^a-z]|$)/, "wifi"],
  ];
  function guessType(text) {
    const t = String(text || "").toLowerCase();
    for (const [re, type] of TYPE_HINTS) if (re.test(t)) return type;
    return null;
  }

  /* compact YAML in the style of the bundled examples: one flow mapping per
   * node / connection, block-style groups */
  function toYaml(doc, comment) {
    const flow = v => yamlLib.dump(v, { flowLevel: 0, lineWidth: -1 }).trim();
    const out = [];
    if (comment) out.push(...comment.split("\n").map(l => ("# " + l).trimEnd()));
    out.push(yamlLib.dump({ diagram: doc.diagram || {} }, { lineWidth: -1 }).trim(), "");
    out.push("nodes:", ...(doc.nodes || []).map(n => "  - " + flow(n)));
    function emitGroups(list, ind) {
      for (const g of list) {
        const { nodes, groups, ...rest } = g;
        const lines = Object.entries(rest).filter(([, v]) => v != null).map(([k, v]) => `${k}: ${flow(v)}`);
        if (nodes && nodes.length) lines.push(`nodes: ${flow(nodes)}`);
        lines.forEach((l, i) => out.push(ind + (i ? "  " : "- ") + l));
        if (groups && groups.length) { out.push(ind + "  groups:"); emitGroups(groups, ind + "    "); }
      }
    }
    if (doc.groups && doc.groups.length) { out.push("", "groups:"); emitGroups(doc.groups, "  "); }
    if (doc.connections && doc.connections.length)
      out.push("", "connections:", ...doc.connections.map(c => "  - " + flow(c)));
    else out.push("", "connections: []");
    return out.join("\n") + "\n";
  }
  const countGroups = list => (list || []).reduce((a, g) => a + 1 + countGroups(g.groups), 0);
  const result = (kind, label, doc) => ({
    kind, label, doc,
    summary: `${doc.nodes.length} nodes, ${countGroups(doc.groups)} groups`,
    yaml: toYaml(doc, `Imported from ${label} by netdiagram — add connections: to describe the traffic.`),
  });

  /* ---------- Ansible ---------- */
  function newModel() { return { groups: new Map(), hostvars: new Map() }; }
  function group(m, name) {
    if (!m.groups.has(name)) m.groups.set(name, { hosts: [], children: [] });
    return m.groups.get(name);
  }
  function addHost(m, groupName, host, vars) {
    const g = group(m, groupName);
    if (!g.hosts.includes(host)) g.hosts.push(host);
    m.hostvars.set(host, { ...(m.hostvars.get(host) || {}), ...(vars || {}) });
  }
  function addChild(m, parent, child) {
    const g = group(m, parent);
    if (!g.children.includes(child)) g.children.push(child);
    group(m, child);
  }
  /* web[01:03].example.com, db-[a:c] (optional :step) */
  function expandHosts(pattern, budget = { left: 5000 }) {
    const m = /^(.*?)\[([0-9]+|[a-z]):([0-9]+|[a-z])(?::(\d+))?\](.*)$/i.exec(pattern);
    if (!m) return budget.left-- > 0 ? [pattern] : [];
    const [, pre, a, b, stepText, post] = m;
    const step = Math.max(1, Number(stepText) || 1);
    const out = [];
    if (/^\d+$/.test(a)) {
      for (let i = Number(a); i <= Number(b) && budget.left > 0; i += step)
        out.push(...expandHosts(pre + String(i).padStart(a.length, "0") + post, budget));
    } else {
      for (let c = a.charCodeAt(0); c <= b.charCodeAt(0) && budget.left > 0; c += step)
        out.push(...expandHosts(pre + String.fromCharCode(c) + post, budget));
    }
    return out;
  }
  function parseKv(text) {
    const out = {};
    for (const m of text.matchAll(/([\w.]+)=("[^"]*"|'[^']*'|\S+)/g)) out[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
    return out;
  }
  function parseAnsibleIni(text) {
    const m = newModel();
    let section = "ungrouped", kind = "hosts";
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.replace(/\s+[#;].*$/, "").trim();
      if (!line || /^[#;]/.test(line)) continue;
      const sec = /^\[([^\]:]+)(?::(\w+))?\]$/.exec(line);
      if (sec) { section = sec[1]; kind = sec[2] || "hosts"; group(m, section); continue; }
      if (kind === "vars") continue;                       // group vars are not imported
      const [name, ...rest] = line.split(/\s+/);
      if (kind === "children") { addChild(m, section, name); continue; }
      const vars = parseKv(rest.join(" "));
      for (const host of expandHosts(name)) addHost(m, section, host, vars);
    }
    return m;
  }
  function parseAnsibleYaml(data) {
    const m = newModel();
    for (const [name, node] of Object.entries(data)) (function walk(n, nd, seen) {
      group(m, n);
      if (!nd || typeof nd !== "object" || seen.has(n)) return;
      const next = new Set(seen).add(n);
      for (const [pattern, vars] of Object.entries(nd.hosts || {}))
        for (const host of expandHosts(pattern)) addHost(m, n, host, vars && typeof vars === "object" ? vars : {});
      for (const [child, sub] of Object.entries(nd.children || {})) { addChild(m, n, child); walk(child, sub, next); }
    })(name, node, new Set());
    return m;
  }
  function parseAnsibleList(data) {
    const m = newModel();
    for (const [host, vars] of Object.entries(data._meta?.hostvars || {})) m.hostvars.set(host, vars || {});
    for (const [name, g] of Object.entries(data)) {
      if (name === "_meta") continue;
      const node = Array.isArray(g) ? { hosts: g } : (g || {});
      group(m, name);
      (node.hosts || []).forEach(h => addHost(m, name, String(h), {}));
      (node.children || []).forEach(c => addChild(m, name, String(c)));
    }
    return m;
  }
  function ansibleDoc(m) {
    const IMPLICIT = new Set(["all", "ungrouped"]);
    const parent = new Map();                            // first parent wins
    for (const [name, g] of m.groups)
      for (const c of g.children) if (c !== name && !parent.has(c) && !IMPLICIT.has(c)) parent.set(c, name);
    const chain = name => {                              // ancestors, nearest first (cycle-safe)
      const out = [], seen = new Set([name]);
      for (let p = parent.get(name); p && !IMPLICIT.has(p) && !seen.has(p); p = parent.get(p)) { out.push(p); seen.add(p); }
      return out;
    };
    const ids = idAllocator();
    const hostId = new Map(), home = new Map(), nodes = [];
    const hosts = new Set([...m.hostvars.keys()]);
    for (const g of m.groups.values()) g.hosts.forEach(h => hosts.add(h));
    for (const host of hosts) {
      const member = [...m.groups].filter(([n, g]) => !IMPLICIT.has(n) && g.hosts.includes(host)).map(([n]) => n);
      /* the most specific (deepest) group is home; the others become tags */
      const best = member.reduce((a, n) => (a == null || chain(n).length > chain(a).length ? n : a), null);
      const redundant = new Set(best ? [best, ...chain(best)] : []);
      const vars = m.hostvars.get(host) || {};
      const id = ids(host);
      const node = { id, label: host, type: guessType(host) || (vars.ansible_network_os ? "switch" : "host") };
      Object.assign(node, addrFields(vars.ansible_host ?? vars.ansible_ssh_host));
      if (vars.ansible_network_os) node.os = String(vars.ansible_network_os);
      else if (/^(winrm|psrp)$/.test(String(vars.ansible_connection || ""))) node.os = "windows";
      const tags = member.filter(n => !redundant.has(n));
      if (tags.length) node.tags = tags;
      nodes.push(node);
      hostId.set(host, id);
      if (best) home.set(host, best);
    }
    function build(name) {
      const kids = [...m.groups.keys()].filter(c => parent.get(c) === name).map(build).filter(Boolean);
      const members = m.groups.get(name).hosts.filter(h => home.get(h) === name).map(h => hostId.get(h));
      if (!kids.length && !members.length) return null;
      const g = { id: ids(name), label: name };
      if (members.length) g.nodes = members;
      if (kids.length) g.groups = kids;
      return g;
    }
    const groups = [...m.groups.keys()]
      .filter(n => !IMPLICIT.has(n) && (!parent.has(n) || IMPLICIT.has(parent.get(n))))
      .map(build).filter(Boolean);
    return { diagram: { title: "Ansible inventory" }, nodes, groups };
  }

  /* ---------- Terraform ---------- */
  const TF_NODES = {
    aws_instance: "vm", aws_db_instance: "db", aws_rds_cluster: "db", aws_elasticache_cluster: "db",
    aws_lb: "lb", aws_alb: "lb", aws_elb: "lb", aws_nat_gateway: "router", aws_internet_gateway: "internet",
    aws_vpn_gateway: "router", aws_networkfirewall_firewall: "firewall", aws_efs_file_system: "storage",
    azurerm_linux_virtual_machine: "vm", azurerm_windows_virtual_machine: "vm", azurerm_virtual_machine: "vm",
    azurerm_lb: "lb", azurerm_application_gateway: "waf", azurerm_firewall: "firewall", azurerm_nat_gateway: "router",
    azurerm_postgresql_flexible_server: "db", azurerm_mssql_server: "db",
    google_compute_instance: "vm", google_sql_database_instance: "db", google_compute_router: "router",
    google_compute_forwarding_rule: "lb",
    openstack_compute_instance_v2: "vm", proxmox_vm_qemu: "vm", proxmox_lxc: "container", libvirt_domain: "vm",
    vsphere_virtual_machine: "vm", hcloud_server: "vm", digitalocean_droplet: "vm",
  };
  const TF_GROUPS = {
    aws_vpc: "cloud", aws_subnet: "subnet", azurerm_virtual_network: "cloud", azurerm_subnet: "subnet",
    google_compute_network: "cloud", google_compute_subnetwork: "subnet",
  };
  function terraformResources(data) {
    const out = [];
    const shown = data.values || data.planned_values;
    if (shown && shown.root_module) {
      (function walk(mod) {
        (mod.resources || []).forEach(r => r.mode !== "data" &&
          out.push({ type: r.type, name: r.name, address: r.address || `${r.type}.${r.name}`, values: r.values || {} }));
        (mod.child_modules || []).forEach(walk);
      })(shown.root_module);
    } else if (Array.isArray(data.resources)) {
      for (const r of data.resources) {
        if (r.mode === "data") continue;
        const base = (r.module ? r.module + "." : "") + `${r.type}.${r.name}`;
        (r.instances || []).forEach(inst => out.push({
          type: r.type, name: r.name, values: inst.attributes || {},
          address: inst.index_key == null ? base : `${base}[${JSON.stringify(inst.index_key)}]`,
        }));
      }
    }
    return out;
  }
  const lastSeg = s => String(s).split("/").pop();
  function terraformDoc(data) {
    const resources = terraformResources(data);
    const ids = idAllocator();
    const short = r => r.address.replace(/^(module\.[^.]+\.)+/, "");
    const label = r => r.values.tags?.Name || r.values.name || short(r);
    const groupKey = new Map();                          // provider id / self_link / name -> group object
    const groups = [];
    for (const r of resources.filter(r => TF_GROUPS[r.type])) {
      const v = r.values;
      const cidr = v.cidr_block || v.ip_cidr_range || (v.address_space || [])[0] || (v.address_prefixes || [])[0] || v.address_prefix;
      const g = { id: ids(short(r)), label: label(r), class: TF_GROUPS[r.type], ...(cidr ? { cidr: String(cidr) } : {}), nodes: [], groups: [] };
      groups.push({ r, g });
      for (const k of [v.id, v.self_link, v.name]) if (k != null && !groupKey.has(String(k))) groupKey.set(String(k), g);
    }
    const findGroup = (...keys) => {
      for (const k of keys) {
        if (k == null) continue;
        const g = groupKey.get(String(k)) || groupKey.get(lastSeg(k));
        if (g) return g;
      }
      return null;
    };
    const top = [];
    for (const { r, g } of groups) {
      const v = r.values;
      const p = r.type === "aws_subnet" ? findGroup(v.vpc_id)
        : r.type === "google_compute_subnetwork" ? findGroup(v.network)
        : r.type === "azurerm_subnet" ? findGroup(v.virtual_network_name) : null;
      if (p && p !== g) p.groups.push(g); else top.push(g);
    }
    const nics = new Map(resources.filter(r => r.type === "azurerm_network_interface").map(r => [String(r.values.id), r.values]));
    const nodes = [];
    for (const r of resources.filter(r => TF_NODES[r.type])) {
      const v = r.values;
      const nic = nics.get(String((v.network_interface_ids || [])[0]));
      const nicCfg = (nic?.ip_configuration || [])[0] || {};
      const gcpIf = Array.isArray(v.network_interface) ? v.network_interface[0] || {} : {};
      const node = { id: ids(short(r)), label: String(label(r)), type: TF_NODES[r.type] };
      const ip = v.private_ip || v.private_ip_address || nicCfg.private_ip_address || gcpIf.network_ip
        || v.ipv4_address || v.default_ip_address || v.address;
      Object.assign(node, addrFields(ip, "endpoint"));
      nodes.push(node);
      const home = findGroup(v.subnet_id, nicCfg.subnet_id, gcpIf.subnetwork, (v.subnets || [])[0], v.vpc_id, gcpIf.network);
      if (home) home.nodes.push(node.id);
    }
    const prune = list => list.map(g => {
      const out = { ...g, groups: prune(g.groups) };
      if (!out.nodes.length) delete out.nodes;
      if (!out.groups.length) delete out.groups;
      return out;
    });
    return { diagram: { title: "Terraform state" }, nodes, groups: prune(top) };
  }

  /* ---------- NetBox ---------- */
  function netboxItems(data) {
    const list = x => Array.isArray(x) ? x : (x && Array.isArray(x.results)) ? x.results : [];
    if (Array.isArray(data) || Array.isArray(data?.results)) return list(data);
    return [...list(data?.devices), ...list(data?.virtual_machines)];
  }
  const isNetbox = data => {
    const items = netboxItems(data);
    return items.length > 0 && items.every(i => i && typeof i === "object" && "name" in i
      && ("device_type" in i || "vcpus" in i || "cluster" in i || "site" in i));
  };
  function netboxDoc(data) {
    const ids = idAllocator();
    const nodes = [], sites = new Map(), loose = [];
    const nameOf = x => x == null ? null : String(typeof x === "object" ? (x.name ?? x.display ?? x.slug ?? "") : x) || null;
    const sub = (parentGroup, key, name) => {
      let g = parentGroup.subs.get(key);
      if (!g) { g = { id: ids(name), label: name, nodes: [] }; parentGroup.subs.set(key, g); }
      return g;
    };
    for (const item of netboxItems(data)) {
      const isVm = "vcpus" in item || ("cluster" in item && !("device_type" in item));
      const role = nameOf(item.role) || nameOf(item.device_role) || "";
      const nameHint = guessType(item.name);
      const type = isVm ? "vm" : (guessType(role) || guessType(item.device_type?.model) || "server");
      const node = { id: ids(item.name), label: String(item.name), type };
      if ((type === "vm" || type === "server") && nameHint) node.icon = nameHint;
      const addr = (item.primary_ip4 || item.primary_ip || item.primary_ip6 || {}).address;
      Object.assign(node, addrFields(addr));
      if (nameOf(item.platform)) node.os = nameOf(item.platform);
      if (role) node.role = role;
      const tags = (item.tags || []).map(t => nameOf(t)).filter(Boolean);
      if (tags.length) node.tags = tags;
      nodes.push(node);
      const siteName = nameOf(item.site);
      if (!siteName) { loose.push(node.id); continue; }
      if (!sites.has(siteName)) sites.set(siteName, { id: ids(siteName), label: siteName, class: "onprem", nodes: [], subs: new Map() });
      const site = sites.get(siteName);
      const inner = isVm ? nameOf(item.cluster) : nameOf(item.rack);
      if (inner) sub(site, (isVm ? "cluster:" : "rack:") + inner, inner).nodes.push(node.id);
      else site.nodes.push(node.id);
    }
    const groups = [...sites.values()].map(({ subs, ...s }) => {
      const g = { ...s, groups: [...subs.values()] };
      if (!g.nodes.length) delete g.nodes;
      if (!g.groups.length) delete g.groups;
      return g;
    });
    return { diagram: { title: "NetBox inventory" }, nodes, groups };
  }

  /* ---------- detection ---------- */
  const IMPORTERS = {
    ansible: { label: "Ansible inventory" },
    terraform: { label: "Terraform state" },
    netbox: { label: "NetBox export" },
  };
  function parseData(text) {
    const t = text.trimStart();
    if (/^[{[]/.test(t)) { try { return { data: JSON.parse(text), json: true }; } catch (e) { /* not JSON */ } }
    try { return { data: yamlLib.load(text), json: false }; } catch (e) { return { data: null, json: false }; }
  }
  const looksLikeAnsibleYaml = data => Object.values(data).some(v => v && typeof v === "object" && !Array.isArray(v)
    && (typeof v.hosts === "object" || typeof v.children === "object"));
  /* Import `text` as `kind` ('ansible' | 'terraform' | 'netbox'); throws when
   * the content does not fit. */
  function importAs(kind, text) {
    const { data, json } = parseData(text);
    if (kind === "terraform") {
      if (!data || typeof data !== "object") throw new Error("Terraform import expects `terraform show -json` output or a .tfstate file.");
      return result("terraform", IMPORTERS.terraform.label, terraformDoc(data));
    }
    if (kind === "netbox") {
      if (!isNetbox(data)) throw new Error("NetBox import expects devices / virtual-machines API JSON.");
      return result("netbox", IMPORTERS.netbox.label, netboxDoc(data));
    }
    if (kind === "ansible") {
      let model;
      if (data && typeof data === "object" && json && (data._meta || Array.isArray(data.all?.children))) model = parseAnsibleList(data);
      else if (data && typeof data === "object" && !Array.isArray(data) && looksLikeAnsibleYaml(data)) model = parseAnsibleYaml(data);
      else model = parseAnsibleIni(text);
      const doc = ansibleDoc(model);
      if (!doc.nodes.length) throw new Error("No hosts found in the Ansible inventory.");
      return result("ansible", IMPORTERS.ansible.label, doc);
    }
    throw new Error(`Unknown import format "${kind}" — use ansible, terraform or netbox.`);
  }
  /* Recognize an inventory format; null for netdiagram YAML or unknown text. */
  function detectImport(text, filename) {
    const name = String(filename || "").toLowerCase();
    const { data, json } = parseData(text);
    if (data && typeof data === "object" && !Array.isArray(data)) {
      if (Array.isArray(data.nodes) || data.diagram || Array.isArray(data.connections)) return null;
      if ((data.format_version && (data.values || data.planned_values)) || (data.terraform_version && Array.isArray(data.resources)))
        return importAs("terraform", text);
      if (isNetbox(data)) return importAs("netbox", text);
      if ((json && (data._meta || Array.isArray(data.all?.children))) || looksLikeAnsibleYaml(data)) return importAs("ansible", text);
      return null;
    }
    if (Array.isArray(data) && isNetbox(data)) return importAs("netbox", text);
    if (/\.ini$|(^|[/\\])(hosts|inventory)[^/\\]*$/.test(name) || /^\s*\[[\w.-]+(:(children|vars))?\]\s*$/m.test(text))
      return importAs("ansible", text);
    return null;
  }

  const api = { detectImport, importAs, toYaml, guessType, expandHosts };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Importers = api;
})(typeof window !== "undefined" ? window : globalThis);
