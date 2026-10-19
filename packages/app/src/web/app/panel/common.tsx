import { useCallback, type ReactNode } from "react";
import { pushHistory, type Bot } from "../../../shared/bot";
import { useFeedback } from "../../components/ui";
import { errorText } from "../../lib/api";
import { useCommit } from "../../lib/data";

/**
 * Saves a change to one bot, recording its previous settings under History:
 * `true` merges quick edits into one step, "always" never does, `false` skips it.
 */
export function useUpdateBot() {
  const commit = useCommit();
  const feedback = useFeedback();
  return useCallback(
    async (botId: string, change: Partial<Bot> | ((bot: Bot) => Bot), recordHistory: boolean | "always" = true): Promise<boolean> => {
      try {
        return await commit((values) => {
          const previous = values.bots.find((bot) => bot.id === botId);
          if (!previous) throw new Error("That bot no longer exists.");
          const next = typeof change === "function" ? change(previous) : { ...previous, ...change };
          const updated = { ...next, updatedAt: new Date().toISOString() };
          return {
            ...values,
            bots: values.bots.map((bot) => (bot.id === botId ? updated : bot)),
            history: recordHistory ? pushHistory(values.history, previous, new Date(), { always: recordHistory === "always" }) : values.history,
          };
        });
      } catch (error) {
        feedback.error(`Couldn't save: ${errorText(error)}`);
        return false;
      }
    },
    [commit, feedback],
  );
}

export function Section({ title, children, actions, info }: { title: ReactNode; children: ReactNode; actions?: ReactNode; info?: ReactNode }) {
  return (
    <section className="section">
      <h3 className="section-title">
        <span style={{ flex: 1 }}>{title}</span>
        {actions}
      </h3>
      {info ? (
        <p className="hint" style={{ marginTop: -4 }}>
          {info}
        </p>
      ) : null}
      <div className="stack">{children}</div>
    </section>
  );
}
