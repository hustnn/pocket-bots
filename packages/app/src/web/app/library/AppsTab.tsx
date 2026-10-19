import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { accountLabel, faviconUrl, type AppAccount } from "../../../shared/apps";
import type { Bot } from "../../../shared/bot";
import { matchesQuery } from "../../../shared/library";
import { appsAccountsRpc, appsCatalogRpc, appsConnectRpc, appsDisconnectRpc, appsRemoveKeyRpc, appsRenameRpc, appsSetKeyRpc, appsStatusRpc } from "../../../shared/rpc";
import { Avatar } from "../../components/Avatar";
import { Button, IconButton, Toggle, useAction, useFeedback } from "../../components/ui";
import { rpc } from "../../lib/api";
import { useCommit, useStoreDoc } from "../../lib/data";

function AppLogo({ app, size = 20 }: { app: { logo?: string | null; domain?: string | null; name: string }; size?: number }) {
  const src = app.logo ?? (app.domain ? faviconUrl(app.domain) : null);
  if (!src) return <span className="badge" style={{ width: size, height: size, padding: 0, justifyContent: "center" }}>{app.name.slice(0, 1)}</span>;
  return <img src={src} width={size} height={size} style={{ borderRadius: 4, flexShrink: 0 }} alt="" />;
}

function KeySetup() {
  const client = useQueryClient();
  const [key, setKey] = useState("");
  const { busy, run } = useAction();
  return (
    <div className="card stack">
      <strong>Connect your Composio project</strong>
      <p className="hint" style={{ margin: 0 }}>
        Connected apps run on your own Composio account: create a project at platform.composio.dev and copy its API key (it starts with ak_). The key stays on this computer; bots reach Composio through
        pocket-bots's local relay, which only lets each bot use the apps you switch on for it.
      </p>
      <div className="row">
        <input className="input mono" type="password" placeholder="ak_…" value={key} onChange={(event) => setKey(event.target.value)} />
        <Button
          variant="primary"
          busy={busy === "key"}
          disabled={!key.trim()}
          onClick={() =>
            void run("key", async () => {
              await rpc(appsSetKeyRpc, { key: key.trim() });
              await client.invalidateQueries({ queryKey: ["apps"] });
            }, "Composio connected")
          }
        >
          Connect
        </Button>
      </div>
    </div>
  );
}

/** One connected app: its accounts, and which bots may use it. */
function AppCard({
  app,
  accounts,
  bots,
  busy,
  onConnect,
  onRename,
  onDisconnect,
  onToggleBot,
}: {
  app: { slug: string; name: string; logo?: string | null; domain?: string | null };
  accounts: AppAccount[];
  bots: Bot[];
  busy: string | null;
  onConnect: () => void;
  onRename: (account: AppAccount) => void;
  onDisconnect: (account: AppAccount) => void;
  onToggleBot: (bot: Bot, on: boolean) => void;
}) {
  return (
    <div className="card stack" style={{ gap: 8 }}>
      <div className="row">
        <AppLogo app={app} size={24} />
        <strong className="grow truncate">{app.name}</strong>
        <Button small icon="plus" busy={busy === `connect:${app.slug}`} onClick={onConnect} title="Sign in with another account, like a work and a personal one">
          Add account
        </Button>
      </div>
      <div>
        {accounts.map((account) => (
          <div key={account.id} className="list-item" style={{ cursor: "default", padding: "4px 6px" }}>
            <div className="grow">
              <div className="small">{accountLabel(account, app.name)}</div>
              {account.name && account.alias ? <div className="hint">{account.name}</div> : null}
            </div>
            <span className={`badge ${account.status === "connected" ? "success" : account.status === "pending" ? "warning" : "danger"}`}>{account.status}</span>
            <IconButton icon="edit" title="Name this account" onClick={() => onRename(account)} />
            <IconButton icon="trash" title="Disconnect" onClick={() => onDisconnect(account)} />
          </div>
        ))}
      </div>
      {bots.length ? (
        <>
          <div className="field-label">Bots using it</div>
          <div>
            {bots.map((bot) => (
              <div key={bot.id} className="check-row" style={{ alignItems: "center" }}>
                <Avatar avatar={bot.avatar} size={22} />
                <span style={{ flex: 1 }}>{bot.name}</span>
                <Toggle on={bot.apps.includes(app.slug)} label={`${bot.name} uses ${app.name}`} onChange={(on) => onToggleBot(bot, on)} />
              </div>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

export function AppsTab({ query }: { query: string }) {
  const client = useQueryClient();
  const feedback = useFeedback();
  const doc = useStoreDoc();
  const commit = useCommit();
  const { busy, run } = useAction();
  const status = useQuery({ queryKey: ["apps", "status"], queryFn: () => rpc(appsStatusRpc, {}) });
  const configured = status.data?.configured ?? false;
  const [waiting, setWaiting] = useState(false);
  const accounts = useQuery({ queryKey: ["apps", "accounts"], queryFn: () => rpc(appsAccountsRpc, { fresh: waiting }), enabled: configured, refetchInterval: waiting ? 4000 : false });
  const catalog = useQuery({ queryKey: ["apps", "catalog"], queryFn: () => rpc(appsCatalogRpc, {}), enabled: configured, staleTime: 3_600_000 });
  const catalogApp = (slug: string) => catalog.data?.apps.find((app) => app.slug === slug);
  const nameOf = (slug: string) => catalogApp(slug)?.name ?? slug;
  const bots = (doc.data?.values.bots ?? []).filter((bot) => !bot.archived);
  // Connected apps, one card each with their accounts; the search matches the app or an account.
  const connected = useMemo(() => {
    const bySlug = new Map<string, AppAccount[]>();
    for (const account of accounts.data?.accounts ?? []) bySlug.set(account.slug, [...(bySlug.get(account.slug) ?? []), account]);
    return [...bySlug].map(([slug, list]) => ({ slug, accounts: list, app: catalog.data?.apps.find((app) => app.slug === slug) }));
  }, [accounts.data, catalog.data]);
  const shownConnected = connected.filter(({ slug, accounts: list, app }) => matchesQuery(query, slug, app?.name, ...list.map((account) => accountLabel(account, app?.name ?? slug))));
  const apps = useMemo(() => (catalog.data?.apps ?? []).filter((app) => matchesQuery(query, app.name, app.slug, app.description)).slice(0, 60), [catalog.data, query]);
  const refresh = () => client.invalidateQueries({ queryKey: ["apps"] });

  if (status.isPending) return <span className="spinner" />;
  if (!configured) return <KeySetup />;

  const connect = async (slug: string) => {
    const alias = await feedback.prompt({ title: `Connect ${nameOf(slug)}`, label: "Account name (optional)", placeholder: "work, personal…", action: "Continue", optional: true });
    if (alias === null) return;
    await run(`connect:${slug}`, async () => {
      const { url } = await rpc(appsConnectRpc, { slug, ...(alias ? { alias } : {}) });
      window.open(url, "_blank", "noopener");
      setWaiting(true);
      setTimeout(() => setWaiting(false), 5 * 60_000);
    });
  };

  const rename = async (account: AppAccount) => {
    const alias = await feedback.prompt({ title: "Name this account", label: "Bots pick accounts by this name", value: account.alias ?? "", action: "Save", optional: true });
    if (alias === null) return;
    await run("rename", async () => {
      await rpc(appsRenameRpc, { accountId: account.id, alias });
      await refresh();
    });
  };

  const disconnect = async (account: AppAccount) => {
    if (!(await feedback.confirm({ title: `Disconnect ${nameOf(account.slug)}?`, body: accountLabel(account, nameOf(account.slug)), action: "Disconnect", danger: true }))) return;
    await run("disconnect", async () => {
      await rpc(appsDisconnectRpc, { accountId: account.id });
      await refresh();
    });
  };

  const toggleBot = (slug: string) => (bot: Bot, on: boolean) =>
    void commit((values) => ({ ...values, bots: values.bots.map((entry) => (entry.id === bot.id ? { ...entry, apps: on ? [...new Set([...entry.apps, slug])] : entry.apps.filter((app) => app !== slug) } : entry)) }));

  return (
    <div className="stack">
      <div className="row">
        <span className="badge success">Composio connected</span>
        <span className="hint">{status.data?.keyHint}</span>
        <span className="spacer" />
        <Button
          small
          variant="danger"
          onClick={async () => {
            if (!(await feedback.confirm({ title: "Remove the Composio key?", body: "Bots lose access to every connected app until you add it again.", action: "Remove", danger: true }))) return;
            await run("remove", async () => {
              await rpc(appsRemoveKeyRpc, {});
              await refresh();
            });
          }}
        >
          Remove key
        </Button>
      </div>
      <div className="section-title" style={{ margin: "8px 0 0" }}>
        Your apps {waiting ? <span className="spinner" /> : null}
      </div>
      {connected.length === 0 ? <div className="hint">No apps connected yet. Connect one below, or let a bot ask for it in a chat.</div> : null}
      {connected.length > 0 && shownConnected.length === 0 ? <div className="hint">None of your apps match.</div> : null}
      {shownConnected.map(({ slug, accounts: list, app }) => (
        <AppCard
          key={slug}
          app={{ slug, name: app?.name ?? slug, logo: app?.logo ?? null, domain: app?.domain ?? null }}
          accounts={list}
          bots={bots}
          busy={busy}
          onConnect={() => void connect(slug)}
          onRename={(account) => void rename(account)}
          onDisconnect={(account) => void disconnect(account)}
          onToggleBot={toggleBot(slug)}
        />
      ))}
      <div className="section-title" style={{ margin: "8px 0 0" }}>
        Connect an app
      </div>
      {catalog.isPending ? <span className="spinner" /> : null}
      {catalog.data && apps.length === 0 ? <div className="hint">No apps match.</div> : null}
      <div className="grid-2">
        {apps.map((app) => (
          <div key={app.slug} className="tile" style={{ cursor: "default" }}>
            <div className="row">
              <AppLogo app={app} size={24} />
              <strong style={{ flex: 1 }} className="truncate">
                {app.name}
              </strong>
              <Button small busy={busy === `connect:${app.slug}`} onClick={() => void connect(app.slug)}>
                Connect
              </Button>
            </div>
            <span className="hint" style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
              {app.description}
            </span>
          </div>
        ))}
      </div>
      {catalog.data && catalog.data.apps.length > apps.length && apps.length === 60 ? <div className="hint">Showing 60 of {catalog.data.apps.length.toLocaleString()} apps. Search to find more.</div> : null}
    </div>
  );
}
