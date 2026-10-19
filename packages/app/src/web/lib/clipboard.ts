/**
 * Copies text. The Clipboard API only exists on secure pages (https, or
 * localhost), and a browser may refuse it, so a page opened by its network
 * address (over Tailscale, say) falls back to the older copy command.
 */
export async function copyText(text: string): Promise<void> {
  if (window.isSecureContext && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Refused; try the copy command below.
    }
  }
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  area.style.pointerEvents = "none";
  document.body.append(area);
  area.select();
  try {
    if (!document.execCommand("copy")) throw new Error("This browser didn't allow copying.");
  } finally {
    area.remove();
    focused?.focus();
  }
}
