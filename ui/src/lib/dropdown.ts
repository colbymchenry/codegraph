import './dropdown.css';

/** Dismiss a popup only after leaving both its trigger and its contents. */
export function dismissDropdown(node: HTMLElement, close = () => { (node as HTMLDetailsElement).open = false; }) {
  const dismiss = () => { close(); if (node.contains(document.activeElement)) (document.activeElement as HTMLElement)?.blur(); };
  const outside = (event: Event) => { if (!node.contains(event.target as Node)) dismiss(); };
  const keyboard = (event: KeyboardEvent) => { if (event.key === 'Escape') { close(); node.querySelector<HTMLElement>('summary,button')?.focus(); } };
  node.addEventListener('pointerleave', dismiss);
  node.addEventListener('focusout', outsideFocus);
  node.addEventListener('keydown', keyboard);
  document.addEventListener('pointerdown', outside, true);
  function outsideFocus(event: FocusEvent) { if (!node.contains(event.relatedTarget as Node)) close(); }
  return { destroy() {
    node.removeEventListener('pointerleave', dismiss);
    node.removeEventListener('focusout', outsideFocus);
    node.removeEventListener('keydown', keyboard);
    document.removeEventListener('pointerdown', outside, true);
  } };
}

/** Keep the select as the value/form source, with a dismissible popup for its options. */
export function selectDropdown(select: HTMLSelectElement) {
  const wrapper = document.createElement('span'); wrapper.className = 'cg-select';
  const trigger = document.createElement('button'); trigger.type = 'button'; trigger.className = select.className;
  const menu = document.createElement('span'); menu.className = 'cg-select-menu'; menu.hidden = true;
  trigger.setAttribute('aria-haspopup', 'listbox'); menu.setAttribute('role', 'listbox');
  select.before(wrapper); wrapper.append(trigger, menu); select.hidden = true;
  const close = () => { menu.hidden = true; trigger.setAttribute('aria-expanded', 'false'); };
  const sync = () => {
    trigger.textContent = `${select.selectedOptions[0]?.textContent ?? '—'} ▾`;
    trigger.disabled = select.disabled;
    const name = select.getAttribute('aria-label'); if (name) trigger.setAttribute('aria-label', name);
    menu.replaceChildren();
    for (const option of select.options) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = option.textContent;
      button.disabled = option.disabled || (option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled);
      button.setAttribute('role', 'option'); button.setAttribute('aria-selected', String(option.selected));
      button.onclick = () => { select.value = option.value; select.dispatchEvent(new Event('change', { bubbles: true })); sync(); close(); trigger.focus(); };
      menu.append(button);
    }
  };
  trigger.onclick = () => {
    const opening = menu.hidden; sync(); menu.hidden = !opening; trigger.setAttribute('aria-expanded', String(opening));
    if (opening) {
      const box = trigger.getBoundingClientRect();
      menu.style.position = 'fixed'; menu.style.top = `${box.bottom}px`; menu.style.left = `${box.left}px`;
      menu.style.right = 'auto'; menu.style.minWidth = `${box.width}px`;
      const below = window.innerHeight - box.bottom - 16;
      const above = box.top - 16;
      menu.style.maxHeight = `${Math.max(80, below < 180 && above > below ? above : below)}px`;
      if (below < 180 && above > below) menu.style.top = `${box.top - menu.getBoundingClientRect().height}px`;
      if (menu.getBoundingClientRect().right > window.innerWidth - 8) menu.style.left = `${Math.max(8, window.innerWidth - menu.getBoundingClientRect().width - 8)}px`;
    }
  };
  wrapper.onkeydown = event => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    if (menu.hidden) trigger.click();
    const options = Array.from(menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
    const index = options.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + options.length) % options.length;
    options[next]?.focus();
  };
  const dismiss = dismissDropdown(wrapper, close);
  const scroll = (event: Event) => { if (!menu.contains(event.target as Node)) close(); };
  window.addEventListener('scroll', scroll, true); window.addEventListener('resize', close);
  const observer = new MutationObserver(sync); observer.observe(select, { subtree: true, childList: true, attributes: true, characterData: true });
  select.addEventListener('change', sync); sync(); close();
  // Svelte bindings update the DOM value property without a mutation event.
  let previous = select.value;
  const timer = window.setInterval(() => { if (select.value !== previous) { previous = select.value; sync(); } }, 100);
  return { destroy() { clearInterval(timer); observer.disconnect(); dismiss.destroy(); window.removeEventListener('scroll', scroll, true); window.removeEventListener('resize', close); select.removeEventListener('change', sync); wrapper.remove(); select.hidden = false; } };
}
