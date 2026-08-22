/** Uploaded-background registry — shares the `background` fragment with the table file. */

let backgrounds: string[] = [];

export function addBackground(url: string): void {
  backgrounds.push(url);
}

export function listBackgrounds(): string[] {
  return [...backgrounds];
}
