// Questions an agent asks the user, from each CLI's own tool, as one kind of approval.
//
// A question is an ApprovalRequest of kind "question" whose input carries `questions`, each with
// its text, a short header, its options, whether several may be picked, whether a typed answer
// is allowed (isOther) and whether it's secret (isSecret; `metadata.secret` then marks the whole
// request). The caller answers with "allow" and `updatedInput.answers`, one string per question
// keyed by its header or its text (several picks are joined by ", ", a typed answer last), or
// with "deny" to dismiss it. Each adapter turns that into its CLI's own reply:
// - Claude Code: AskUserQuestion, answered through canUseTool's updatedInput, keyed by question text;
// - Codex: item/tool/requestUserInput (request_user_input, offered in plan mode), keyed by question id;
// - OpenCode: its question tool's form (form.created with metadata.kind "question"), keyed q0, q1, …;
// - Grok Build: the _x.ai/ask_user_question request (ask_user_question), keyed by question text.
// Pi has no question tool of its own.
//
// Types only, so the app's shared and web code can use it too.
import type { ApprovalDecision, ApprovalRequest } from "./types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface QuestionSpec {
  question: string;
  header: string;
  options: { label: string; description?: string }[];
  multiSelect: boolean;
  /** A typed answer is allowed besides the options. */
  isOther?: boolean;
  /** The answer is a secret (a token, a password). */
  isSecret?: boolean;
}

/** The questions a question approval asks, or null when its input has none. */
export function questionsOf(input: unknown): QuestionSpec[] | null {
  if (!isRecord(input) || !Array.isArray(input.questions)) return null;
  const questions: QuestionSpec[] = [];
  for (const [index, item] of input.questions.entries()) {
    if (!isRecord(item) || typeof item.question !== "string") return null;
    const options = Array.isArray(item.options) ? item.options.filter(isRecord).filter((option) => typeof option.label === "string") : [];
    questions.push({
      question: item.question,
      header: typeof item.header === "string" && item.header.trim() ? item.header : defaultHeader(index, input.questions.length),
      options: options.map((option) => ({ label: String(option.label), ...(typeof option.description === "string" && option.description ? { description: option.description } : {}) })),
      multiSelect: item.multiSelect === true,
      ...(item.isOther === true || item.allowOther === true ? { isOther: true } : {}),
      ...(item.isSecret === true ? { isSecret: true } : {}),
    });
  }
  return questions.length ? questions : null;
}

function defaultHeader(index: number, count: number): string {
  return count === 1 ? "Question" : `Question ${index + 1}`;
}

/** Each question's answer in order (null: unanswered), from an allowed question's answers by question text or header. */
export function answersInOrder(questions: readonly QuestionSpec[], decision: ApprovalDecision): (string | null)[] {
  const answers = decision.behavior === "allow" && isRecord(decision.updatedInput?.answers) ? decision.updatedInput.answers : {};
  return questions.map((question) => {
    const answer = answers[question.question] ?? answers[question.header];
    return typeof answer === "string" ? answer : Array.isArray(answer) ? answer.map(String).join(", ") : null;
  });
}

/**
 * A multi-select answer split back into its picks: the options it starts with (labels joined by
 * ", "; a label may itself hold ", "), then anything typed as one more.
 */
export function splitChoices(value: string, labels: readonly string[]): string[] {
  const byLength = [...labels].sort((a, b) => b.length - a.length);
  const picks: string[] = [];
  let at = 0;
  while (at < value.length) {
    const label = byLength.find((candidate) => candidate && value.startsWith(candidate, at) && (at + candidate.length === value.length || value.startsWith(", ", at + candidate.length)));
    if (!label) {
      const rest = value.slice(at).trim();
      if (rest) picks.push(rest);
      break;
    }
    picks.push(label);
    at += label.length + 2;
  }
  return picks;
}

const secretMetadata = (questions: readonly QuestionSpec[]) => (questions.some((question) => question.isSecret) ? { metadata: { secret: true } } : {});

// ---------------------------------------------------------------- Claude Code

/**
 * AskUserQuestion's input once answered: Claude Code reads `answers` keyed by each question's
 * text, while the answer may come keyed by header (the form in the web UI keys it so).
 */
export function claudeAnswered(input: Record<string, unknown>, decision: Extract<ApprovalDecision, { behavior: "allow" }>): Record<string, unknown> {
  const merged = { ...input, ...(decision.updatedInput ?? {}) };
  const questions = questionsOf(input);
  if (!questions) return merged;
  const answers: Record<string, string> = {};
  answersInOrder(questions, decision).forEach((answer, index) => {
    if (answer !== null) answers[questions[index]!.question] = answer;
  });
  return { ...merged, answers };
}

// ---------------------------------------------------------------- Codex

/** Codex's item/tool/requestUserInput as a question approval. */
export function codexQuestion(params: any): ApprovalRequest {
  const questions: QuestionSpec[] = (Array.isArray(params?.questions) ? params.questions : []).map((question: any, index: number, all: unknown[]) => ({
    question: String(question?.question ?? ""),
    header: typeof question?.header === "string" && question.header.trim() ? question.header : defaultHeader(index, all.length),
    options: (Array.isArray(question?.options) ? question.options : []).map((option: any) => ({ label: String(option?.label ?? ""), ...(option?.description ? { description: String(option.description) } : {}) })),
    multiSelect: false,
    ...(question?.isOther ? { isOther: true } : {}),
    ...(question?.isSecret ? { isSecret: true } : {}),
  }));
  return { id: String(params?.itemId ?? params?.turnId ?? "request_user_input"), provider: "codex", name: "request_user_input", kind: "question", input: { questions }, ...secretMetadata(questions) };
}

/** Codex's ToolRequestUserInputResponse: each answered question's id with its answers; none when dismissed. */
export function codexAnswers(params: any, decision: ApprovalDecision): { answers: Record<string, { answers: string[] }> } {
  const asked: any[] = Array.isArray(params?.questions) ? params.questions : [];
  const questions = codexQuestion(params).input!.questions as QuestionSpec[];
  const answers: Record<string, { answers: string[] }> = {};
  answersInOrder(questions, decision).forEach((answer, index) => {
    const id = asked[index]?.id;
    if (answer !== null && typeof id === "string") answers[id] = { answers: [answer] };
  });
  return { answers };
}

// ---------------------------------------------------------------- OpenCode

/** OpenCode's question tool asks through a form (form.created, metadata.kind "question"): as a question approval, or null for another form. */
export function opencodeQuestion(form: any): ApprovalRequest | null {
  if (!isRecord(form) || !isRecord(form.metadata) || form.metadata.kind !== "question" || !Array.isArray(form.fields)) return null;
  const fields = form.fields.filter(isRecord);
  const questions: QuestionSpec[] = fields.map((field, index) => ({
    question: String(field.description ?? field.title ?? ""),
    header: typeof field.title === "string" && field.title.trim() ? field.title : defaultHeader(index, fields.length),
    options: (Array.isArray(field.options) ? field.options : []).filter(isRecord).map((option) => ({ label: String(option.label ?? option.value ?? ""), ...(option.description ? { description: String(option.description) } : {}) })),
    multiSelect: field.type === "multiselect",
    ...(field.custom === true || !Array.isArray(field.options) || field.options.length === 0 ? { isOther: true } : {}),
  }));
  return { id: String(form.id), provider: "opencode", name: "question", kind: "question", title: String(form.title ?? "Questions"), input: { questions } };
}

/** The form's answer: each field's key with the picked option's value (several for a multiselect field), or what was typed. */
export function opencodeFormAnswer(form: any, decision: ApprovalDecision): Record<string, string | string[]> {
  const fields: Record<string, unknown>[] = Array.isArray(form?.fields) ? form.fields.filter(isRecord) : [];
  const questions = (opencodeQuestion(form)?.input?.questions ?? []) as QuestionSpec[];
  const answer: Record<string, string | string[]> = {};
  answersInOrder(questions, decision).forEach((value, index) => {
    const field = fields[index];
    if (value === null || !field || typeof field.key !== "string") return;
    const options = (Array.isArray(field.options) ? field.options : []).filter(isRecord);
    const valueOf = (label: string) => String(options.find((option) => option.label === label)?.value ?? label);
    answer[field.key] = field.type === "multiselect" ? splitChoices(value, options.map((option) => String(option.label ?? ""))).map(valueOf) : valueOf(value);
  });
  return answer;
}

// ---------------------------------------------------------------- Grok Build

/** Grok Build's _x.ai/ask_user_question (its ask_user_question tool) as a question approval. */
export function grokQuestion(params: any): ApprovalRequest {
  const asked: any[] = Array.isArray(params?.questions) ? params.questions : [];
  const questions: QuestionSpec[] = asked.map((question, index) => ({
    question: String(question?.question ?? ""),
    header: typeof question?.header === "string" && question.header.trim() ? question.header : defaultHeader(index, asked.length),
    options: (Array.isArray(question?.options) ? question.options : []).map((option: any) => ({ label: String(option?.label ?? ""), ...(option?.description ? { description: String(option.description) } : {}) })),
    multiSelect: question?.multiSelect === true,
    isOther: true,
  }));
  return { id: String(params?.toolCallId ?? "ask_user_question"), provider: "grok", name: "ask_user_question", kind: "question", input: { questions } };
}

/** Grok Build's AskUserQuestionExtResponse: accepted with answers keyed by question text, or cancelled. */
export function grokAnswers(params: any, decision: ApprovalDecision): { outcome: "accepted"; answers: Record<string, string> } | { outcome: "cancelled" } {
  if (decision.behavior !== "allow") return { outcome: "cancelled" };
  const questions = grokQuestion(params).input!.questions as QuestionSpec[];
  const answers: Record<string, string> = {};
  answersInOrder(questions, decision).forEach((answer, index) => {
    if (answer !== null) answers[questions[index]!.question] = answer;
  });
  return { outcome: "accepted", answers };
}
