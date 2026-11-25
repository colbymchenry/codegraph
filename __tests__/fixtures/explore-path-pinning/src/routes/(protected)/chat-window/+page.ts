/** Detached chat window page — session presence + streaming state. */

let chatAtBottom = true;
let isStreaming = false;
let messages: string[] = [];

export function handleMessagesScroll(distance: number): void {
  chatAtBottom = distance < 50;
}

export function sendMessage(text: string): void {
  messages = [...messages, text];
  isStreaming = true;
}

export function stopResponse(): void {
  isStreaming = false;
}

export function redock(): void {
  messages = [];
  isStreaming = false;
  chatAtBottom = true;
}

export function chatSnapshot(): { messages: string[]; streaming: boolean } {
  return { messages: [...messages], streaming: isStreaming };
}
