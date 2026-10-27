import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { randomSeed } from "../../../shared/avatar";
import { MAX_STARTERS, type Bot, type Starter } from "../../../shared/bot";
import { PALETTE_COUNT, paletteSwatch } from "../../../shared/pixel";
import { avatarGenerateRpc, avatarKeyStatusRpc } from "../../../shared/rpc";
import { voiceGroups } from "../../../shared/speech";
import { Avatar } from "../../components/Avatar";
import { Button, CommitInput, Field, IconButton, Segmented, Toggle, useAction } from "../../components/ui";
import { rpc } from "../../lib/api";
import { squareImage } from "../../lib/images";
import { canSpeak, speak } from "../../lib/speech";
import { Section, useUpdateBot } from "./common";

function useVoices(): SpeechSynthesisVoice[] {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  useEffect(() => {
    const synth = window.speechSynthesis;
    if (!synth) return;
    const load = () => setVoices(synth.getVoices());
    load();
    synth.addEventListener("voiceschanged", load);
    return () => synth.removeEventListener("voiceschanged", load);
  }, []);
  return voices;
}

/** "zh" → "Chinese" (in the reader's language), for grouping voices. */
function languageName(code: string): string {
  try {
    return new Intl.DisplayNames([navigator.language], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}

export function IdentitySection({ bot }: { bot: Bot }) {
  const update = useUpdateBot();
  const { busy, run } = useAction();
  const keyStatus = useQuery({ queryKey: ["avatar", "key"], queryFn: () => rpc(avatarKeyStatusRpc, {}) });
  const [direction, setDirection] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const imageUrlOk = /^https?:\/\/\S+$/i.test(imageUrl.trim());
  const voices = useVoices();
  const avatar = bot.avatar;
  // Changes apply to the bot as saved, so two quick ones (a new face, then a shape) both stick.
  const setAvatar = (patch: Partial<Bot["avatar"]>) => void update(bot.id, (current) => ({ ...current, avatar: { ...current.avatar, ...patch } }));
  const setVoice = (patch: Partial<Bot["voice"]>) => void update(bot.id, (current) => ({ ...current, voice: { ...current.voice, ...patch } }));
  const setStarter = (index: number, patch: Partial<Starter>) =>
    void update(bot.id, (current) => ({ ...current, starters: current.starters.map((starter, at) => (at === index ? { ...starter, ...patch } : starter)) }));

  const pickPicture = (file: File) =>
    run("picture", async () => {
      const url = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error ?? new Error("Couldn't read the file."));
        reader.readAsDataURL(file);
      });
      setAvatar({ imageUrl: await squareImage(url) });
    });

  return (
    <>
      <Section title="Identity">
        <Field label="Name">
          <CommitInput value={bot.name} onCommit={(name) => void update(bot.id, { name: name.trim() || bot.name })} />
        </Field>
        <Field label="Role" hint="One line: what the bot does.">
          <CommitInput value={bot.title} placeholder="Researcher" onCommit={(title) => void update(bot.id, { title })} />
        </Field>
        <Field label="About" hint="Shown in the bot list and given to the agent.">
          <CommitInput multiline rows={3} value={bot.description} onCommit={(description) => void update(bot.id, { description })} />
        </Field>
      </Section>
      <Section title="Starters" info="Examples of what to ask, shown in a new chat with the bot. Picking one puts its text in the message box, to finish and send. They aren't given to the agent.">
        {bot.starters.map((starter, index) => (
          <div key={index} className="row" style={{ alignItems: "flex-start" }}>
            <div className="stack grow" style={{ gap: 6 }}>
              <CommitInput mono value={starter.text} placeholder="What to ask, like: summarize today's mail" onCommit={(text) => setStarter(index, { text })} />
              <CommitInput value={starter.hint} placeholder="What it does (optional)" onCommit={(hint) => setStarter(index, { hint })} />
            </div>
            <IconButton icon="x" title="Remove starter" onClick={() => void update(bot.id, (current) => ({ ...current, starters: current.starters.filter((_, at) => at !== index) }))} />
          </div>
        ))}
        {bot.starters.length < MAX_STARTERS ? (
          <div>
            <Button small icon="plus" onClick={() => void update(bot.id, (current) => ({ ...current, starters: [...current.starters, { text: "", hint: "" }] }))}>
              Add starter
            </Button>
          </div>
        ) : null}
      </Section>
      <Section title="Avatar">
        <div className="row" style={{ gap: 14 }}>
          <Avatar avatar={avatar} size={64} />
          <div className="stack" style={{ gap: 8 }}>
            <div className="row wrap">
              <Button small icon="refresh" onClick={() => setAvatar({ seed: randomSeed(), imageUrl: null })}>
                New face
              </Button>
              <label className="btn small">
                Upload picture
                <input type="file" accept="image/*" hidden onChange={(event) => event.target.files?.[0] && void pickPicture(event.target.files[0])} />
              </label>
              {avatar.imageUrl ? (
                <Button small onClick={() => setAvatar({ imageUrl: null })}>
                  Use pixel face
                </Button>
              ) : null}
            </div>
            <Segmented
              value={avatar.shape}
              onChange={(shape) => setAvatar({ shape })}
              options={[
                { value: "circle", label: "Circle" },
                { value: "rounded", label: "Rounded" },
                { value: "square", label: "Square" },
              ]}
            />
          </div>
        </div>
        {!avatar.imageUrl ? (
          <div className="row wrap" style={{ gap: 6 }}>
            <button type="button" className={`tab${avatar.palette === null ? " active" : ""}`} onClick={() => setAvatar({ palette: null })}>
              Auto
            </button>
            {Array.from({ length: PALETTE_COUNT }, (_, index) => (
              <button
                key={index}
                type="button"
                title={`Palette ${index + 1}`}
                onClick={() => setAvatar({ palette: index })}
                style={{ width: 22, height: 22, borderRadius: 11, border: avatar.palette === index ? "2px solid var(--fg)" : "1px solid var(--border)", background: paletteSwatch(index), cursor: "pointer" }}
              />
            ))}
          </div>
        ) : null}
        <Field label="Image URL" hint="A picture on the web to use as the avatar, shown as it is.">
          <div className="row">
            <input className="input" value={imageUrl} placeholder="https://…" onChange={(event) => setImageUrl(event.target.value)} />
            <Button
              small
              disabled={!imageUrlOk}
              onClick={() => {
                setAvatar({ imageUrl: imageUrl.trim() });
                setImageUrl("");
              }}
            >
              Use
            </Button>
          </div>
        </Field>
        <Field label="Draw a picture" hint={keyStatus.data?.configured ? `Uses your OpenAI key (${keyStatus.data.keyHint}).` : "Add an OpenAI key in Settings to draw pictures."}>
          <div className="row">
            <input className="input" value={direction} placeholder="A cheerful fox librarian" onChange={(event) => setDirection(event.target.value)} />
            <Button
              small
              icon="sparkles"
              disabled={!keyStatus.data?.configured}
              busy={busy === "draw"}
              onClick={() =>
                void run("draw", async () => {
                  const { image } = await rpc(avatarGenerateRpc, { name: bot.name, title: bot.title, description: bot.description, direction });
                  setAvatar({ imageUrl: await squareImage(image) });
                })
              }
            >
              Draw
            </Button>
          </div>
        </Field>
      </Section>
      <Section title="Voice" info="Replies are read aloud with this browser's voices.">
        {canSpeak ? (
          <Button small icon="volume" onClick={() => speak(`voice-test:${bot.id}`, `Hi, I'm ${bot.name || "your bot"}.`, bot.voice.name)}>
            Hear it
          </Button>
        ) : null}
        <div className="row">
          <span style={{ flex: 1 }}>Read finished replies aloud while the chat is open</span>
          <Toggle on={bot.voice.readReplies} onChange={(readReplies) => setVoice({ readReplies })} />
        </div>
        <Field label="Voice">
          <select className="select" value={bot.voice.name ?? ""} onChange={(event) => setVoice({ name: event.target.value || null })}>
            <option value="">Browser default</option>
            {voiceGroups(voices, navigator.languages ?? [navigator.language], languageName).map((group) => (
              <optgroup key={group.label} label={group.label}>
                {group.voices.map((voice) => (
                  <option key={voice.name} value={voice.name}>
                    {voice.name} ({voice.lang})
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </Field>
      </Section>
    </>
  );
}
