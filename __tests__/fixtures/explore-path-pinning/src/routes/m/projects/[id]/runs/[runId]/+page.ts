/** Mobile run feed — event stream + scroll pinning for the run page. */

export interface FeedEvent {
  id: string;
  kind: 'output' | 'tool' | 'error';
  content: string;
}

const EVENT_CAP = 300;

let events: FeedEvent[] = [];
let workingLine: string | null = null;

/** Whether the reader is at the tail of the feed (within 50px). */
let feedAtBottom = true;

interface FeedElement {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

let feedEl: FeedElement | null = null;

export function bindFeedElement(el: FeedElement | null): void {
  feedEl = el;
}

/** Track the reader's position; called from the feed's scroll listener. */
export function handleFeedScroll(): void {
  const el = feedEl;
  if (!el) return;
  feedAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
}

/** Re-pin after async content growth (image loads), only when at the tail. */
export function pinFeedIfNearBottom(): void {
  const el = feedEl;
  if (!el) return;
  if (feedAtBottom) {
    el.scrollTop = el.scrollHeight;
  }
}

export function appendEvent(event: FeedEvent): void {
  events = events.length >= EVENT_CAP
    ? [...events.slice(-(EVENT_CAP - 1)), event]
    : [...events, event];
  if (feedAtBottom) {
    pinFeedIfNearBottom();
  }
}

export function setWorkingLine(line: string | null): void {
  workingLine = line;
  pinFeedIfNearBottom();
}

export function resetFeed(): void {
  events = [];
  workingLine = null;
  feedAtBottom = true;
}

export function feedSnapshot(): { events: FeedEvent[]; workingLine: string | null } {
  return { events: [...events], workingLine };
}
