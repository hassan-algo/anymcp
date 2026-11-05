import type { AskUserRequest } from "@anymcp/shared";
import type { Reply } from "./messages.js";

const id = new URLSearchParams(location.search).get("id") ?? "";
const titleEl = document.getElementById("title")!;
const messageEl = document.getElementById("message")!;
const form = document.getElementById("form") as HTMLFormElement;
const label = document.getElementById("label")!;
const input = document.getElementById("answer") as HTMLInputElement;
const choicesEl = document.getElementById("choices")!;

async function answer(choice: string): Promise<void> {
  await chrome.runtime.sendMessage({ type: "ask-answer", id, choice, text: form.hidden ? undefined : input.value });
  window.close();
}

async function main(): Promise<void> {
  const reply = (await chrome.runtime.sendMessage({ type: "ask-get", id })) as Reply<AskUserRequest | null>;
  const req = reply.ok ? reply.result : null;
  if (!req) {
    titleEl.textContent = "Nothing to answer";
    messageEl.textContent = "This question already finished or timed out.";
    setTimeout(() => window.close(), 1500);
    return;
  }
  document.title = `AnyMCP: ${req.title}`;
  titleEl.textContent = req.title;
  messageEl.textContent = req.message;
  if (req.input) {
    form.hidden = false;
    label.textContent = req.input.label;
    input.placeholder = req.input.placeholder ?? "";
  }
  const choices = req.choices?.length ? req.choices : ["OK", "Cancel"];
  choices.forEach((choice, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = choice;
    if (i === 0) b.className = "primary";
    b.addEventListener("click", () => void answer(choice));
    choicesEl.append(b);
  });
  // Enter in the text box picks the first (main) choice.
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    void answer(choices[0]!);
  });
  if (req.input) input.focus();
  else (choicesEl.querySelector("button.primary") as HTMLButtonElement | null)?.focus();

}

void main();
