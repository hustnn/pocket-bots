import type { Bot } from "../../../shared/bot";
import { setBotUses } from "../../../shared/library";
import { Button, Toggle } from "../../components/ui";
import { useStoreDoc } from "../../lib/data";
import { navigate } from "../../lib/router";
import { Section, useUpdateBot } from "./common";

export function SkillsSection({ bot }: { bot: Bot }) {
  const doc = useStoreDoc();
  const update = useUpdateBot();
  const skills = doc.data?.values.library?.skills ?? [];
  return (
    <Section
      title="Skills"
      info={`Skills from Skills & Tools that ${bot.name} reads before a task they cover. Send /learn in a chat to turn what the bot just did into a new skill.`}
      actions={
        <Button small icon="library" onClick={() => navigate({ page: "library", tab: "skills" })}>
          Library
        </Button>
      }
    >
      {skills.length === 0 ? <div className="hint">The library has no skills yet. Import one from GitHub in Skills & Tools.</div> : null}
      <div>
        {skills.map((skill) => {
          const on = bot.skillIds.includes(skill.id);
          const unreviewed = skill.reviewedSha === null;
          return (
            <div key={skill.id} className="check-row">
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="row">
                  <strong className="truncate">{skill.id}</strong>
                  {!skill.enabled ? <span className="badge">Off in library</span> : null}
                  {unreviewed ? <span className="badge warning">Needs review</span> : null}
                </div>
                {skill.description ? <div className="hint">{skill.description}</div> : null}
              </div>
              <Toggle on={on} label={`Use ${skill.id}`} onChange={(next) => void update(bot.id, (current) => setBotUses(current, "skill", skill.id, next))} />
            </div>
          );
        })}
      </div>
    </Section>
  );
}
