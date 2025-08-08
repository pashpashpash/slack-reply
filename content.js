(() => {
  'use strict';

  // Configuration: tweak if Slack changes DOM
  const SELECTORS = {
    actionsGroup: '[data-qa="message-actions"], .c-message_actions__group',
    messageContainer: '[data-qa="message_container"]',
    authorButton: '[data-qa="message_sender_name"]',
    messageText: '[data-qa="message-text"], .p-rich_text_block',
    composerPreferred: '[data-qa="message_input"][contenteditable="true"]',
    composerFallback: 'div[role="textbox"][contenteditable="true"]'
  };

  const ATTR = {
    replyButtonQa: 'cline-reply'
  };

  // Cache display name -> userId when available so we can resolve compact messages
  const NAME_TO_ID = new Map();

  function once(fn, ms) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  function isElement(node) {
    return node && node.nodeType === Node.ELEMENT_NODE;
  }

  function findClosestMessageContainer(fromEl) {
    if (!fromEl) return null;
    return fromEl.closest(SELECTORS.messageContainer);
  }

  function getAuthorInfo(messageEl) {
    if (!messageEl) return { userId: null, name: null };

    // Preferred: full sender button on the "first" message in a run
    const btn = messageEl.querySelector(SELECTORS.authorButton);
    if (btn) {
      const userId = btn.getAttribute('data-message-sender');
      const name = (btn.textContent || '').trim() || null;
      if (name && userId) NAME_TO_ID.set(name.toLowerCase(), userId);
      return { userId, name };
    }

    // Fallback 1: offscreen "primary-...-sender" span on compact messages
    const offscreen = messageEl.querySelector('[id$="-sender"].offscreen, .offscreen[id*="-sender"]');
    let name = offscreen ? (offscreen.textContent || '').trim() : null;

    // Fallback 2: message sender wrapper with data-stringify-text (older builds)
    if (!name) {
      const senderWrap = messageEl.querySelector('[data-qa="message_sender"]');
      const attrName = senderWrap ? senderWrap.getAttribute('data-stringify-text') : null;
      if (attrName) name = attrName.trim();
    }

    // Resolve userId from cache when we only have a compact message (no button)
    let userId = null;
    if (name) {
      userId = NAME_TO_ID.get(name.toLowerCase()) || null;
    }

    return { userId, name };
  }

  function readSelectedTextWithin(containerEl) {
    try {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return '';
      const range = sel.getRangeAt(0);
      if (!containerEl.contains(range.commonAncestorContainer)) return '';
      const text = sel.toString();
      return text ? sanitizeMessageText(text) : '';
    } catch {
      return '';
    }
  }

  function readMessageText(containerEl) {
    if (!containerEl) return '';
    const preferred = containerEl.querySelector(SELECTORS.messageText);
    let raw = '';
    if (preferred && preferred.innerText) {
      raw = preferred.innerText;
    } else {
      raw = (containerEl.innerText || containerEl.textContent || '');
    }
    return sanitizeMessageText(raw);
  }

  // Remove Slack UI artifacts like "(edited)" and normalize whitespace
  function sanitizeMessageText(raw) {
    if (!raw) return '';
    let t = String(raw);
    // Normalize NBSP to space
    t = t.replace(/\u00A0/g, ' ');
    // Remove "(edited)" tokens (end-of-line and inline)
    t = t.replace(/\s*\(edited\)\s*$/gm, '');
    t = t.replace(/\s*\(edited\)\s*/g, ' ');
    // Collapse spaces before newlines and excessive blank lines
    t = t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
    return t.trim();
  }

  function buildQuoteOnly(rawText) {
    const text = (rawText || '').trim();
    if (!text) return '';
    const lines = text.split(/\r?\n/);
    return lines.map(l => `> ${l}`).join('\n');
  }

  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  }

  function getActiveComposer() {
    // Prefer the currently focused contenteditable if it matches a composer
    const ae = document.activeElement;
    if (ae && ae.matches && ae.matches(SELECTORS.composerFallback) && isVisible(ae)) {
      return ae;
    }
    // Else try preferred selector
    const preferred = document.querySelector(SELECTORS.composerPreferred);
    if (preferred && isVisible(preferred)) return preferred;
    // Else any visible contenteditable textbox
    const all = Array.from(document.querySelectorAll(SELECTORS.composerFallback));
    const visible = all.find(isVisible);
    return visible || null;
  }

  function placeCaretAtEnd(el) {
    if (!el) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    if (!sel) return;
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function insertIntoComposer(text) {
    if (!text) return;
    const composer = getActiveComposer();
    if (!composer) return;

    composer.focus();

    // Try execCommand first (still widely supported in Slack's environment)
    const ok = document.execCommand('insertText', false, text);
    if (!ok) {
      // Fallback: manual range insertion
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        range.deleteContents();
        range.insertNode(document.createTextNode(text));
        sel.collapseToEnd();
      } else {
        placeCaretAtEnd(composer);
        const sel2 = window.getSelection();
        if (sel2 && sel2.rangeCount > 0) {
          const r = sel2.getRangeAt(0);
          r.insertNode(document.createTextNode(text));
          sel2.collapseToEnd();
        }
      }
    }

    // Notify React/Slack that content changed
    composer.dispatchEvent(new InputEvent('input', { bubbles: true }));
  }

  // Helpers for creating a true Slack mention via autosuggest
  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function sendKey(target, key, code = key, keyCode = key === 'Enter' ? 13 : undefined) {
    const opts = { key, code, which: keyCode, keyCode, bubbles: true, cancelable: true };
    target.dispatchEvent(new KeyboardEvent('keydown', opts));
    target.dispatchEvent(new KeyboardEvent('keypress', opts));
    target.dispatchEvent(new KeyboardEvent('keyup', opts));
  }

  // Lightweight tooltip that mimics Slack's style and always appears above
  let CLINE_ACTIVE_TOOLTIP = null;
  let CLONE_REPOSITION = null;

  function createTooltipElement(text, dark) {
    // Colors tuned to match Slack tooltip closely
    const BG = 'rgba(44,45,48,0.98)';               // medium gray fill
    const BORDER = 'rgba(255,255,255,0.18)';        // subtle light border

    const tip = document.createElement('div');
    tip.setAttribute('role', 'tooltip');
    tip.style.position = 'fixed';
    tip.style.zIndex = '99999999';
    tip.style.pointerEvents = 'none';
    tip.style.padding = '8px 12px';
    tip.style.borderRadius = '10px';
    tip.style.fontSize = '13px';
    tip.style.fontWeight = '600';
    tip.style.lineHeight = '18px';
    tip.style.whiteSpace = 'nowrap';
    tip.style.background = BG;
    tip.style.border = `1px solid ${BORDER}`;
    tip.style.boxShadow = '0 2px 8px rgba(0,0,0,0.30)';
    tip.style.color = '#F5F5F5';
    tip.textContent = text;

    // Arrow with border: outer triangle (border color) + inner triangle (fill)
    const arrowOuter = document.createElement('div');
    arrowOuter.style.position = 'absolute';
    arrowOuter.style.left = '50%';
    arrowOuter.style.transform = 'translateX(-50%)';
    arrowOuter.style.width = '0';
    arrowOuter.style.height = '0';
    arrowOuter.style.borderLeft = '8px solid transparent';
    arrowOuter.style.borderRight = '8px solid transparent';

    const arrowInner = document.createElement('div');
    arrowInner.style.position = 'absolute';
    arrowInner.style.left = '50%';
    arrowInner.style.transform = 'translateX(-50%)';
    arrowInner.style.width = '0';
    arrowInner.style.height = '0';
    arrowInner.style.borderLeft = '7px solid transparent';
    arrowInner.style.borderRight = '7px solid transparent';

    tip.appendChild(arrowOuter);
    tip.appendChild(arrowInner);
    return { tip, arrowOuter, arrowInner };
  }

  function isDarkBackground() {
    const bg = getComputedStyle(document.body).backgroundColor;
    const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
    if (!m) return true;
    const r = parseInt(m[1], 10), g = parseInt(m[2], 10), b = parseInt(m[3], 10);
    const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    return luminance < 0.5;
  }

  function positionTooltipForButton(btn, tip, arrowOuter, arrowInner) {
    // Append to measure so computed styles are available
    if (!tip.parentNode) document.body.appendChild(tip);

    const rect = btn.getBoundingClientRect();
    const tipRect = tip.getBoundingClientRect();
    const gap = 6;

    // Always render above, centered horizontally
    let top = rect.top - tipRect.height - gap;
    let left = rect.left + rect.width / 2 - tipRect.width / 2;

    // Keep within viewport horizontally
    const margin = 6;
    left = Math.max(margin, Math.min(left, window.innerWidth - tipRect.width - margin));

    const clampedTop = Math.max(4, top);

    tip.style.top = `${clampedTop}px`;
    tip.style.left = `${left}px`;

    // Sync arrow colors to the tip's computed background and border to ensure exact match
    const cs = getComputedStyle(tip);
    const BG = cs.backgroundColor;
    const BORDER = cs.borderTopColor || cs.borderColor || 'rgba(255,255,255,0.18)';

    // Arrow pointing down, horizontally centered with the tooltip bubble
    const OUTER = 6;
    const INNER = 5;

    arrowOuter.style.top = `${tipRect.height - 1}px`;
    arrowOuter.style.bottom = '';
    arrowOuter.style.borderLeft = `${OUTER}px solid transparent`;
    arrowOuter.style.borderRight = `${OUTER}px solid transparent`;
    arrowOuter.style.borderTop = `${OUTER}px solid ${BORDER}`;
    arrowOuter.style.borderBottom = '0 solid transparent';
    arrowOuter.style.left = '50%';
    arrowOuter.style.transform = 'translateX(-50%)';

    arrowInner.style.top = `${tipRect.height}px`;
    arrowInner.style.bottom = '';
    arrowInner.style.borderLeft = `${INNER}px solid transparent`;
    arrowInner.style.borderRight = `${INNER}px solid transparent`;
    arrowInner.style.borderTop = `${INNER}px solid ${BG}`;
    arrowInner.style.borderBottom = '0 solid transparent';
    arrowInner.style.left = '50%';
    arrowInner.style.transform = 'translateX(-50%)';
  }

  function showTooltipFor(btn, text) {
    hideTooltip();
    const dark = isDarkBackground();
    const { tip, arrowOuter, arrowInner } = createTooltipElement(text, dark);
    CLONE_REPOSITION = () => positionTooltipForButton(btn, tip, arrowOuter, arrowInner);
    CLONE_REPOSITION();
    window.addEventListener('scroll', CLONE_REPOSITION, true);
    window.addEventListener('resize', CLONE_REPOSITION, true);
    CLINE_ACTIVE_TOOLTIP = tip;
  }

  function hideTooltip() {
    if (CLINE_ACTIVE_TOOLTIP && CLINE_ACTIVE_TOOLTIP.parentNode) {
      CLINE_ACTIVE_TOOLTIP.parentNode.removeChild(CLINE_ACTIVE_TOOLTIP);
    }
    CLINE_ACTIVE_TOOLTIP = null;
    if (CLONE_REPOSITION) {
      window.removeEventListener('scroll', CLONE_REPOSITION, true);
      window.removeEventListener('resize', CLONE_REPOSITION, true);
      CLONE_REPOSITION = null;
    }
  }

  function attachTooltipHandlers(btn, text) {
    const show = () => showTooltipFor(btn, text);
    const hide = () => hideTooltip();
    btn.addEventListener('mouseenter', show);
    btn.addEventListener('focus', show);
    btn.addEventListener('mouseleave', hide);
    btn.addEventListener('blur', hide);
  }

  function findTypeaheadOption(name, userId) {
    const lower = (name || '').toLowerCase();
    const lists = Array.from(document.querySelectorAll('[role="listbox"], [data-qa*="typeahead"], .c-menu, .c-typeahead__popper, .ql-autocomplete__list'));
    const attrCandidates = ['data-user-id', 'data-entity-id', 'data-qa-user-id', 'data-member-id', 'data-id', 'data-uid'];

    for (const list of lists) {
      const opts = list.querySelectorAll('[role="option"], .c-menu_item, [data-qa="typeahead-item"]');
      for (const opt of opts) {
        // Prefer exact match by userId via known attributes
        if (userId) {
          for (const attr of attrCandidates) {
            const val = opt.getAttribute(attr);
            if (val && val === userId) {
              return opt;
            }
            // also check nested nodes
            if (opt.querySelector(`[${attr}="${userId}"]`)) {
              return opt;
            }
          }
        }
        // Fallback to display text match
        const text = (opt.textContent || '').trim().toLowerCase();
        if (!text) continue;
        if (text === lower || text.startsWith(lower) || text.includes(lower)) {
          return opt;
        }
      }
    }
    return null;
  }

  async function createMentionEntity(displayName, userId) {
    const composer = getActiveComposer();
    if (!composer) return false;
    composer.focus();

    // Type "@{displayName}" to trigger Slack's autosuggest
    insertIntoComposer(`@${displayName}`);

    // Wait briefly for the typeahead to render and try to click the right option
    const deadline = Date.now() + 900;
    let clicked = false;
    while (Date.now() < deadline) {
      const opt = findTypeaheadOption(displayName, userId);
      if (opt) {
        opt.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        opt.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        opt.click();
        clicked = true;
        break;
      }
      await delay(60);
    }
    if (!clicked) {
      // Only press Enter if a typeahead list exists; otherwise avoid sending the message by accident.
      const anyList = document.querySelector('[role="listbox"], [data-qa*="typeahead"], .c-menu, .c-typeahead__popper, .ql-autocomplete__list');
      if (anyList) {
        sendKey(composer, 'Enter', 'Enter', 13);
      }
    }
    return true;
  }

  async function handleReplyClick(actionsGroup) {
    try {
      const messageEl = findClosestMessageContainer(actionsGroup);
      if (!messageEl) return;

      const { userId, name } = getAuthorInfo(messageEl);
      const displayName = name || 'user';

      const selected = readSelectedTextWithin(messageEl);
      const fullText = selected || readMessageText(messageEl);
      if (!fullText) return;

      const lines = fullText.trim().split(/\r?\n/);
      if (!lines.length) return;

      // First quoted line: "> " + real mention entity + " " + text
      insertIntoComposer('> ');
      await createMentionEntity(displayName, userId);
      insertIntoComposer(' ' + lines[0] + '\n');

      // Remaining quoted lines
      for (let i = 1; i < lines.length; i++) {
        insertIntoComposer('> ' + lines[i] + '\n');
      }

      // Blank line after quote, caret ready for typing
      insertIntoComposer('\n');
    } catch {
      // Silently ignore to avoid breaking Slack UI
    }
  }

  function createReplyButton() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('data-qa', ATTR.replyButtonQa);
    btn.setAttribute('aria-label', 'Quote reply');
    // Avoid native browser tooltip; we present our own styled tooltip
    btn.setAttribute('title', '');
    btn.className = 'c-button-unstyled c-icon_button c-icon_button--size_small c-message_actions__button c-icon_button--default';
    btn.style.cursor = 'pointer';

    // Simple reply arrow SVG (16x16), inline to avoid external fetches
    btn.innerHTML = `
      <svg viewBox="0 0 20 20" width="0.9em" height="0.9em" aria-hidden="true" focusable="false">
        <path fill="currentColor" d="M2.3 7.3a1 1 0 0 0 0 1.4l5 5a1 1 0 0 0 1.4-1.4L5.42 9H11a7 7 0 0 1 7 7v4a1 1 0 1 0 2 0v-4a9 9 0 0 0-9-9H5.41l3.3-3.3a1 1 0 0 0-1.42-1.4l-5 5Z"></path>
      </svg>
    `.trim();

    // Custom Slack-like tooltip (above, matching style)
    attachTooltipHandlers(btn, 'Quote reply');

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const actionsGroup = btn.closest(SELECTORS.actionsGroup);
      if (actionsGroup) handleReplyClick(actionsGroup);
    });

    return btn;
  }

  function ensureReplyButton(actionsGroup) {
    if (!actionsGroup || !isElement(actionsGroup)) return;
    // De-dupe
    if (actionsGroup.querySelector(`[data-qa="${ATTR.replyButtonQa}"]`)) return;

    // Insert our button second from the right (before the more actions button)
    const btn = createReplyButton();
    const lastButton = actionsGroup.lastElementChild;
    if (lastButton) {
      actionsGroup.insertBefore(btn, lastButton);
    } else {
      actionsGroup.appendChild(btn);
    }
  }

  function scanInitial() {
    const groups = document.querySelectorAll(SELECTORS.actionsGroup);
    groups.forEach(ensureReplyButton);
  }

  const handleMutations = (mutations) => {
    for (const m of mutations) {
      if (!m.addedNodes || m.addedNodes.length === 0) continue;
      for (const node of m.addedNodes) {
        if (!isElement(node)) continue;
        const el = node;
        if (el.matches && el.matches(SELECTORS.actionsGroup)) {
          ensureReplyButton(el);
        }
        const nested = el.querySelectorAll ? el.querySelectorAll(SELECTORS.actionsGroup) : [];
        nested.forEach(ensureReplyButton);
      }
    }
  };

  function startObserver() {
    const obs = new MutationObserver(handleMutations);
    obs.observe(document.documentElement, { childList: true, subtree: true });
  }

  // Preload reply button as soon as hover starts to avoid flicker/jumpiness
  function ensureReplySoonForMessage(messageEl) {
    let attempts = 8; // try across a few frames as Slack renders the toolbar
    function tick() {
      const group = messageEl.querySelector(SELECTORS.actionsGroup);
      if (group) {
        ensureReplyButton(group);
        return;
      }
      if (attempts-- > 0) {
        requestAnimationFrame(tick);
      }
    }
    tick();
  }

  // Capture-phase mouseenter to run before Slack's own hover handlers
  document.addEventListener('mouseenter', (e) => {
    const target = e.target;
    if (!(target instanceof Element)) return;
    const message = target.closest(SELECTORS.messageContainer);
    if (message) ensureReplySoonForMessage(message);
  }, true);

  // Boot
  scanInitial();
  startObserver();
})();
