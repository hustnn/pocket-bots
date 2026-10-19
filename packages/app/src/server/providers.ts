import type { ProviderId, RuntimeAdapter } from "@pocket-bots/runtime";
import type { ProviderEntry, ProvidersSnapshot } from "../shared/chat-types";

// The runtimes bots can run on, with what each CLI reports: installed, logged in, its models and
// approval modes. Probing runs the CLIs, so the result is kept for a while.

const TTL_MS = 5 * 60_000;
/** The approval mode a bot on "Provider default" gets, per runtime. */
const DEFAULT_MODES: Partial<Record<ProviderId, string>> = { claude: "default", codex: "auto", opencode: "ask", pi: "ask", grok: "ask" };

export class Providers {
  private cached: { at: number; snapshot: ProvidersSnapshot } | null = null;
  private pending: Promise<ProvidersSnapshot> | null = null;

  constructor(private readonly runtimes: ReadonlyMap<ProviderId, RuntimeAdapter>) {}

  snapshot(refresh = false): Promise<ProvidersSnapshot> {
    if (!refresh && this.cached && Date.now() - this.cached.at < TTL_MS) return Promise.resolve(this.cached.snapshot);
    this.pending ??= this.load().finally(() => (this.pending = null));
    return this.pending;
  }

  private async load(): Promise<ProvidersSnapshot> {
    const entries = await Promise.all(
      [...this.runtimes.values()]
        .filter((adapter) => adapter.id !== "fake")
        .map(async (adapter): Promise<ProviderEntry> => {
          try {
            const probe = await adapter.probe();
            const models = probe.installed ? await adapter.models() : [];
            const status = !probe.installed ? "unavailable" : probe.auth === "logged_out" ? "error" : "ready";
            return {
              provider: adapter.id,
              label: adapter.label,
              status,
              enabled: probe.installed,
              ...(probe.diagnostic ? { error: probe.diagnostic } : {}),
              ...(probe.version ? { version: probe.version } : {}),
              models: models.map((model) => ({ ...model, ...(model.thinkingOptions?.find((option) => option.isDefault) ? { defaultThinkingOptionId: model.thinkingOptions.find((option) => option.isDefault)!.id } : {}) })),
              modes: adapter.modes(),
              defaultModeId: DEFAULT_MODES[adapter.id] ?? adapter.modes()[0]?.id ?? null,
            };
          } catch (error) {
            return { provider: adapter.id, label: adapter.label, status: "error", enabled: false, error: error instanceof Error ? error.message : String(error), models: [], modes: [], defaultModeId: null };
          }
        }),
    );
    const snapshot = { entries };
    this.cached = { at: Date.now(), snapshot };
    return snapshot;
  }
}
