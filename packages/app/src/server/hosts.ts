import { isIP } from "node:net";

// The web UI has no login and its RPCs start chats that run commands, so a
// page that rebinds its own domain to this machine (DNS rebinding) must not
// reach it. Requests are checked by their Host header against `web.hostnames`: localhost, *.localhost and IP addresses
// always pass; ".example.com" allows that domain and its subdomains; `true`
// allows any host.

export type AllowedHostnames = true | readonly string[];

/** The hostname in a Host header, lowercased, without its port, brackets or trailing dot. */
export function hostnameOf(header: string | undefined | null): string | null {
  const value = header?.trim().toLowerCase();
  if (!value) return null;
  let name: string;
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    if (end < 0) return null;
    name = value.slice(1, end);
  } else {
    // A bare IPv6 address has several colons and no port.
    name = value.split(":").length === 2 ? value.slice(0, value.indexOf(":")) : value;
  }
  name = name.replace(/\.$/, "");
  return name || null;
}

export function isAllowedHost(header: string | undefined | null, allowed: AllowedHostnames): boolean {
  if (allowed === true) return true;
  const name = hostnameOf(header);
  if (!name) return false;
  if (name === "localhost" || name.endsWith(".localhost") || isIP(name)) return true;
  return allowed.some((entry) => {
    const rule = entry.trim().toLowerCase().replace(/\.$/, "");
    if (!rule) return false;
    return rule.startsWith(".") ? name === rule.slice(1) || name.endsWith(rule) : name === rule;
  });
}
