---
name: egm
description: Design before code with the Elephant-Goldfish Model (EGM). Use when the user's message starts with "egm" (egm brainstorm, egm draft, egm review, egm review loop, egm resolve, egm drift report) or asks for an EGM brainstorm, design doc, review or drift report.
---

# EGM in Pocket Bots

You are the Elephant: you hold the user's context, draft and revise design documents, and settle
with the user what to change. The Goldfish reviewers are another bot, which reads only what you
send it and doesn't know this conversation.

The files in `workflows/`, `references/` and `execution_instructions.md` are Google's EGM
(github.com/google/elephant-goldfish-model, Apache-2.0, see `LICENSE`), unchanged. They were
written for Claude Code, Codex and Antigravity. Follow them, with the changes below for Pocket
Bots; where they disagree, this file wins. Paths here are relative to the folder this file is in.

## Commands

| The user says | Read and follow |
|---|---|
| egm brainstorm <idea> | `workflows/brainstorm.md` |
| egm draft [file] | `workflows/draft.md` |
| egm review <file> | `workflows/review.md` |
| egm review loop <file> | `workflows/review_loop.md` |
| egm resolve <report> | `workflows/resolve.md` |
| egm drift report <folder> | `workflows/drift_report.md` |

Read the workflow the user asked for, and the ones it hands work to (review hands findings to
resolve and review loop). Don't read the others.

## What the workflows' references mean here

- Skip each workflow's opening lines about Codex, Claude Code, Cowork, `docs/codex.md`,
  `docs/claude.md`, `docs/harnesses.md` and `${CLAUDE_PLUGIN_ROOT}`: this file takes their place.
- `resources/execution_instructions.md` is `execution_instructions.md` here.
- `references/design_doc.md` is `references/design_doc.md` here.
- `agents/synthesizer.md` is `workflows/synthesizer.md`. Its job (collect the reviewers' findings,
  deduplicate, rank, write the report) is yours; you don't start a synthesizer.
- `agents/<persona>.md` and `resources/document_standards/<standard>.md` live with the Goldfish
  bot. Name them in the task; don't look for them or send their text.
- "Invoke egm-resolve" or "egm-review-loop" means: read that workflow here and follow it in this
  chat.

## Goldfish reviews

Wherever a workflow says to spawn a subagent, a Goldfish, a reviewer swarm or the synthesizer:

1. **Find the Goldfish.** Call `list_bots` and use the bot whose role is "EGM reviewer". If there
   is none, stop and tell the user to add one (New bot, then Goldfish). Never review in this chat
   or with sub-agents of your own: a review that shares your context is not a Goldfish review.
2. **One `ask_bot` per reviewer**, with `wait: false`, and `in_my_folder: true` when the target is
   in your working folder. Send every reviewer of a stage before you wait for any of them.
3. **The message is the task and nothing else:**

   ```text
   EGM task
   Mode: REVIEW
   Persona: design_critic
   Standards: feature-spec-standard
   Target: /Users/ann/site/docs/designs/webhooks.md, lines 1-142
   Context: /Users/ann/site/src/delivery/README.md
   ```

   For a brainstorm lens, `Mode: BRAINSTORM`, no `Standards` or `Target`, and
   `Concept:` followed by the hypothesis the user confirmed. Use absolute paths. Never add this
   chat's discussion, your reasoning, earlier findings, or answers the document should give itself.
4. **Persona and standard names.** Use the persona's file name; the workflows use the names on the
   left:

   | Workflow | Persona |
   |---|---|
   | egm-zoom-out | zoom_out |
   | egm-comprehension | comprehension |
   | egm-design | design_critic |
   | egm-structural | structural |
   | egm-style | style |
   | egm-implementation-readiness | implementation_readiness |
   | egm-codebase-details | codebase_details |

   Standards go by file name without `.md`: feature-spec-standard,
   implementation-readiness-standard, re-implementation-standard, zoom-out-standard,
   heilmeier-standard. Give each reviewer the standards its workflow step names.

   The second zoom-out (Stage 8 of a review) also gets the first one's report under `Context:`,
   in every mode, as the zoom-out step in `workflows/review.md` says: it looks at what the
   comprehension and critic stages added, not at the document from scratch.
5. **Answers come back one at a time** as messages in this chat. Once a stage's tasks are sent,
   tell the user how many reviewers you're waiting for and end your turn. Note each answer as it
   arrives; when all of the stage's answers are in, combine them as `workflows/synthesizer.md`
   says and write the stage's report. Each answer ends with a `Read:` line: the files that
   reviewer read and the code it searched. Keep it with the reviewer's findings in the report, so
   a claim about the code shows what it was checked against. An answer that starts with "Incomplete review", or a
   reviewer that stopped with an error, leaves the stage incomplete: tell the user and offer to ask
   again. Never count it as "no findings".
6. **One stage at a time.** Don't send the next stage until this one's report is written and, in
   an interactive review, the user chose to go on.

## Files and questions

- Write briefs, drafts and reports in your working folder, or in the folder named by a line
  `EGM artifact directory: <path>` in the user's message or the project's AGENTS.md (a relative
  path is relative to the working folder; create the folder if it's missing).
- In chat, give the file's path and the few points the workflow asks you to highlight, not the
  document.
- A workflow's single-select gate: use your tool for asking the user if you have one (Pocket Bots
  shows it as a form); otherwise ask in plain text with numbered options, and wait for the answer.
- A drift report needs no Goldfish: read the documents and the code yourself.
