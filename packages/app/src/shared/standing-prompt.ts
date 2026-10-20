// The standing-prompt update: Claude Code and Codex keep a resumed session's first system
// prompt, so a group seat whose standing prompt changed while its session was closed gets the
// current one in front of its first input after the resume (ChatService). The timeline keeps
// that input as the model got it; chat titles and the chat view split the update off again.

const OPEN = "<pocket-bots-standing-prompt-update>";
const CLOSE = "</pocket-bots-standing-prompt-update>";
const INTRO =
  "pocket-bots updated your standing instructions since this session started. The instructions below replace the earlier standing instructions (system or developer prompt) for the rest of this session; where they differ, follow these.";

/** The update put in front of the input. Nothing earlier in the conversation changes, so the prompt cache stays valid. */
export function standingPromptUpdate(standingPrompt: string): string {
  return [OPEN, INTRO, "", standingPrompt, CLOSE, "", ""].join("\n");
}

/** An input taken apart: the standing prompt an update in front of it carried (null without one) and the input itself. */
export function splitStandingUpdate(text: string): { standing: string | null; text: string } {
  const end = text.indexOf(CLOSE);
  if (!text.startsWith(OPEN) || end < 0) return { standing: null, text };
  const inner = text.slice(OPEN.length, end).trim();
  const standing = inner.startsWith(INTRO) ? inner.slice(INTRO.length).trim() : inner;
  return { standing, text: text.slice(end + CLOSE.length).trimStart() };
}
