/* Builder modal. */
((PS) => {
  const IS_MAC = typeof Platform !== 'undefined' && (Platform.isMacOS || Platform.isIosApp);
  const MOD = IS_MAC ? '⌘' : 'Ctrl+';
  const ALT = IS_MAC ? '⌥' : 'Alt+';
  const SHIFT = IS_MAC ? '⇧' : 'Shift+';
  const HISTORY_LIMIT = 100;
  // The focused window's document (the builder may open in a popout window).
  const activeDoc = () => (typeof activeDocument !== 'undefined' ? activeDocument : document);

  const hasCjk = (value) => /[一-鿿]/.test(String(value));
  const hasTex = (value) => /[\\$]/.test(String(value || ''));

  function cloneNode(node) {
    const copy = JSON.parse(JSON.stringify(node));
    PS.walk([copy], (child) => { child.id = PS.nextId(); });
    return copy;
  }

  function newNode(type) {
    switch (type) {
      case 'if': return PS.node('if', { branches: [{ cond: '', body: [] }], elseBody: null });
      case 'while': return PS.node('while', { cond: '', body: [] });
      case 'for': return PS.node('for', { init: '', bound: '', downto: false, body: [] });
      case 'forall': return PS.node('for', { all: true, init: '', bound: '', downto: false, body: [] });
      case 'repeat': return PS.node('repeat', { body: [], until: '' });
      case 'function': return PS.node('function', { kind: 'Procedure', name: '', args: '', body: [] });
      case 'call': return PS.node('call', { name: '', args: '' });
      case 'break':
      case 'continue': return PS.node(type);
      default: return PS.node(type, { text: '' });
    }
  }

  /* Row layouts. A part is a literal word, an input ({ key }) or a select. */
  const field = (key, placeholder, math = true) => ({ key, placeholder, math });
  const ROWS = {
    state: { chip: 'statement', parts: [field('text', 'x = Extract-Min(Q), or start with if / for / while / else / return …')] },
    require: { chip: 'require', parts: [field('text', 'input, e.g. A, n')] },
    ensure: { chip: 'ensure', parts: [field('text', 'output, e.g. A is sorted')] },
    return: { chip: 'return', parts: [field('text', 'value, e.g. Merge-Sort(A, p, r)')] },
    print: { chip: 'print', parts: [field('text', 'value')] },
    break: { chip: 'break', parts: [] },
    continue: { chip: 'continue', parts: [] },
    call: { chip: 'call', parts: [field('name', 'procedure name', false), '(', field('args', 'args, e.g. A, i'), ')'] },
    raw: { chip: 'raw', parts: [field('text', 'unrecognized raw line', false)] },
    comment: { chip: '//', parts: [field('text', 'comment text', false)], noComment: true },
    while: { chip: 'while', parts: [field('cond', 'condition, e.g. i > 0 and A[i] > key')] },
    forall: { chip: 'for each', parts: [field('init', 'element in set, e.g. v in G.V')] },
    for: {
      chip: 'for',
      parts: [
        field('init', 'start, e.g. j = 2'),
        { select: 'downto', options: [['to', false], ['downto', true]] },
        field('bound', 'end, e.g. n'),
      ],
    },
    function: {
      chip: 'procedure',
      parts: [
        { select: 'kind', options: [['Procedure', 'Procedure'], ['Function', 'Function']] },
        field('name', 'name, e.g. Max-Heapify', false),
        '(', field('args', 'args, e.g. A, x'), ')',
      ],
    },
  };

  const PRIMARY_INSERTS = [
    ['Statement', 'state'], ['If', 'if'], ['For', 'for'], ['While', 'while'],
    ['Return', 'return'], ['Call', 'call'], ['Procedure', 'function'],
  ];
  const MORE_INSERTS = [
    ['For each', 'forall'], ['Repeat … until', 'repeat'], ['Require', 'require'], ['Ensure', 'ensure'],
    ['Break', 'break'], ['Continue', 'continue'], ['Print', 'print'], ['Comment line', 'comment'],
  ];

  /* ---- help ---- */

  // [example(s), what it does]. Examples render as code; ' · ' separates several.
  const HELP_TYPING = [
    ['if x > 0', 'An if block (then, :, { and brackets are fine too)'],
    ['else · else if y < 0', 'A branch of the if above'],
    ['for i = 1 to n', 'A for loop: typing “ to ” or “ downto ” jumps to the end value'],
    ['for each v in G.V', 'A for-each loop'],
    ['while i > 0 · repeat · until done', 'Loops; until closes the repeat above'],
    ['return x · break · continue', 'Statements'],
    ['procedure Max-Heapify(A, i)', 'A procedure: typing ( jumps to the parameters'],
    ['// note', 'A comment line; x = 0 // note adds a comment to a line'],
    ['end · }', 'Leaves the block (so does Enter on an empty last line)'],
  ];
  const HELP_KEYS = [
    ['Enter', 'New line (inside a block head: its first line)'],
    ['Backspace', 'On an empty line: delete it. At the start of a block head: back to a plain line'],
    [`Tab · ${SHIFT}Tab`, 'Indent · outdent'],
    [`${ALT}↑ · ${ALT}↓`, 'Move the line'],
    ['↑ · ↓', 'Previous · next field'],
    [`${MOD}/`, 'Show or hide the comment field'],
    [`${MOD}${SHIFT}D · ${MOD}${SHIFT}K`, 'Duplicate · delete the line'],
    [`${MOD}Z · ${MOD}${SHIFT}Z`, 'Undo · redo (also undoes an automatic conversion)'],
    [`${MOD}Enter`, 'Save'],
  ];
  const HELP_MATH = [
    ['A[1..n]', 'Range dots'],
    ['<= · >= · != · ==', '≤ · ≥ · ≠ · comparison (a single = is assignment)'],
    ['NIL · TRUE · FALSE', 'Constants, in small caps'],
    ['Insertion-Sort(A)', 'Calls: capitalized names with ( are set in small caps'],
    ['key · heap-size', 'Variable names in italic, as in CLRS'],
  ];

  function renderHelp(parent) {
    const section = (title, rows, code = true) => {
      parent.createDiv({ cls: 'pb-help-heading', text: title });
      // Keys are short: two columns. Typed examples are long: example above its meaning.
      const list = parent.createDiv(code ? 'pb-help-list pb-help-stacked' : 'pb-help-list');
      rows.forEach(([examples, text]) => {
        const cell = list.createDiv('pb-help-key');
        examples.split(' · ').forEach((example, index) => {
          if (index) cell.appendText(' ');
          cell.createEl(code ? 'code' : 'kbd', { text: example });
        });
        list.createDiv({ cls: 'pb-help-text', text });
      });
    };
    section('Type at the start of a line', HELP_TYPING);
    section('Keys', HELP_KEYS, false);
    section('Writing expressions', HELP_MATH);
    parent.createDiv({
      cls: 'pb-help-note',
      text: 'Paste several lines (Python or C style, CLRS with line numbers, or algorithmicx LaTeX) into any line or the title to import them as rows.',
    });
  }

  /** The footer hint for a focused field. */
  function hintFor(node, kind, key, value, nested) {
    const empty = !String(value || '').trim();
    if (key === 'caption') return 'Enter or ↓: go to the first line · Paste several lines here to import them';
    if (key === 'comment') return `Enter: new line · ${MOD}/ on an empty comment removes it`;
    if (kind === 'until') return 'Enter: new line after the loop';
    switch (node && node.type) {
      case 'state':
        if (!empty) return `Enter: new line · type “ // ” to add a comment · Tab / ${SHIFT}Tab: indent / outdent · ${ALT}↑↓: move`;
        return nested
          ? 'Type if / for / while / else / return / // … to make a block · Enter on this empty line leaves the block · Backspace deletes it'
          : 'Type if / for / while / repeat / return / procedure / // … to make a block · or paste several lines';
      case 'if':
        return 'Enter: first line inside · type else or else if on a line below to add a branch';
      case 'for':
        if (node.all || key === 'bound') return 'Enter: first line inside the loop';
        return 'Type “ to ” or “ downto ” to jump to the end value · “each v in S” makes a for-each loop';
      case 'while':
        return 'Enter: first line inside the loop';
      case 'function':
        return key === 'name' ? 'Type ( to jump to the parameters' : 'Enter: first line of the procedure';
      case 'call':
        return key === 'name' ? 'Type ( to jump to the arguments' : 'Enter: new line';
      default:
        return `Enter: new line · Tab / ${SHIFT}Tab: indent / outdent · ${MOD}Z: undo · ${MOD}Enter: save`;
    }
  }

  class ConfirmModal extends Modal {
    constructor(app, { title, message, choices }) {
      super(app);
      this.titleText = title;
      this.message = message;
      this.choices = choices;
    }

    onOpen() {
      this.modalEl.addClass('pb-confirm');
      this.titleEl.setText(this.titleText);
      this.contentEl.createEl('p', { text: this.message });
      const buttons = this.contentEl.createDiv('modal-button-container');
      this.choices.forEach(({ label, cls, run }) => {
        const button = buttons.createEl('button', { text: label, cls });
        button.addEventListener('click', () => {
          this.close();
          run();
        });
      });
    }

    onClose() {
      this.contentEl.empty();
    }
  }

  /*
   * A field that was plain text in the source (`\State Initialize the array`) stays plain text
   * while edited. Marked as `<key>Prose` so it survives undo snapshots (JSON) and duplication;
   * the serializer ignores it.
   */
  function markSourceProse(value) {
    if (Array.isArray(value)) { value.forEach(markSourceProse); return; }
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (key.endsWith('Math') && child === false) value[`${key.slice(0, -4)}Prose`] = true;
      else if (child && typeof child === 'object') markSourceProse(child);
    }
  }

  class BuilderModal extends Modal {
    constructor(app, options) {
      super(app);
      this.model = options.model;
      this.settings = options.settings || {};
      this.sourcePath = options.sourcePath || '';
      this.onSave = options.onSave;
      this.saveSettings = options.saveSettings || null; // (patch) => void
      markSourceProse(this.model.nodes);
      this.initialLatex = PS.serializeLatex(this.model);
      this.index = new Map();
      this.undoStack = [];
      this.redoStack = [];
      this.typingKey = null;
      this.selected = null; // { id, slot }
      this.pendingFocus = null; // focus key to restore after the next render
      this.pendingCaret = null; // caret for it: a position or 'end' (else: select all)
      this.collapsed = new Set();
      this.openComments = new Set();
      this.dragId = null;
      this.dropTarget = null;
      this.previewTimer = null;
      this.previewToken = 0;
      this.previewComponent = null;
      this.forceClose = false;
    }

    onOpen() {
      this.modalEl.addClass('pb-modal');
      this.titleEl.setText('Pseudocode builder');
      this.buildLayout();
      this.renderTree();
      this.renderPreview();
      this.onKey = (event) => this.handleKey(event);
      this.modalEl.addEventListener('keydown', this.onKey);
      // Start typing right away: first field, or the title for a new block.
      // (Deferred: Modal.open() moves focus after onOpen.)
      window.setTimeout(() => {
        const first = this.listEl.querySelector('input.pb-input');
        (first || this.captionInput).focus();
        this.updateHint();
      }, 0);
    }

    onClose() {
      this.modalEl.removeEventListener('keydown', this.onKey);
      clearTimeout(this.previewTimer);
      this.previewToken += 1;
      if (this.previewComponent) this.previewComponent.unload();
      this.contentEl.empty();
    }

    isDirty() {
      return PS.serializeLatex(this.model) !== this.initialLatex;
    }

    /** Esc, the close button and clicking outside all land here. */
    close() {
      if (this.forceClose || !this.isDirty()) {
        super.close();
        return;
      }
      new ConfirmModal(this.app, {
        title: 'Discard changes?',
        message: 'This pseudocode block has unsaved changes.',
        choices: [
          { label: 'Keep editing', run: () => {} },
          { label: 'Discard', cls: 'mod-warning', run: () => this.closeNow() },
          { label: 'Save', cls: 'mod-cta', run: () => this.save() },
        ],
      }).open();
    }

    closeNow() {
      this.forceClose = true;
      this.close();
    }

    buildLayout() {
      const { contentEl } = this;
      contentEl.empty();
      contentEl.addClass('pb-content');

      const wrap = contentEl.createDiv('pb-wrap');
      const left = wrap.createDiv('pb-left');
      const right = wrap.createDiv('pb-right');

      const captionRow = left.createDiv('pb-caption');
      captionRow.createSpan({ cls: 'pb-chip', text: 'title' });
      this.captionInput = captionRow.createEl('input', {
        cls: 'pb-input',
        attr: { type: 'text', placeholder: 'Algorithm title (optional)' },
      });
      this.captionInput.value = this.model.caption || '';
      this.captionInput.addEventListener('input', () => {
        this.beginTyping('caption');
        this.model.caption = this.captionInput.value;
        this.schedulePreview();
      });
      this.captionInput.addEventListener('keydown', (event) => {
        if (event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
        if (event.key !== 'Enter' && event.key !== 'ArrowDown') return;
        event.preventDefault();
        event.stopPropagation();
        this.focusFirstLine();
      });
      this.captionInput.addEventListener('paste', (event) => {
        const text = event.clipboardData ? event.clipboardData.getData('text/plain') : '';
        if (this.pasteLines(null, text)) event.preventDefault();
      });

      const toolbar = left.createDiv('pb-toolbar');
      PRIMARY_INSERTS.forEach(([label, type]) => {
        const button = toolbar.createEl('button', { text: `+ ${label}` });
        button.addEventListener('click', () => this.insertNode(newNode(type)));
      });
      const more = toolbar.createEl('button', { text: 'More…', attr: { 'aria-label': 'More statement types' } });
      more.addEventListener('click', (event) => {
        const menu = new Menu();
        MORE_INSERTS.forEach(([label, type]) => menu.addItem((item) => item.setTitle(label).onClick(() => this.insertNode(newNode(type)))));
        this.showMenu(menu, event, more);
      });

      this.listEl = left.createDiv('pb-list');
      this.listEl.addEventListener('focusin', (event) => {
        const row = event.target.closest('.pb-row');
        if (row) this.select(row.dataset.id, row.dataset.slot);
      });

      this.previewEl = right.createDiv('pb-preview');
      const details = right.createEl('details', { cls: 'pb-latex' });
      details.createEl('summary', { text: 'Generated LaTeX' });
      this.latexEl = details.createEl('pre');

      // Tips stay open until closed once (remembered in the settings).
      this.helpEl = right.createEl('details', { cls: 'pb-help' });
      this.helpEl.open = this.settings.builderTips !== false;
      this.helpEl.createEl('summary', { text: 'Typing tips and shortcuts' });
      renderHelp(this.helpEl.createDiv('pb-help-body'));
      this.helpEl.addEventListener('toggle', () => {
        if (this.saveSettings && (this.settings.builderTips !== false) !== this.helpEl.open) {
          this.saveSettings({ builderTips: this.helpEl.open });
        }
      });

      const footer = contentEl.createDiv('pb-footer');
      const helpButton = footer.createEl('button', {
        cls: 'pb-help-btn',
        text: '?',
        attr: { type: 'button', 'aria-label': 'Typing tips and shortcuts' },
      });
      helpButton.addEventListener('click', () => {
        this.helpEl.open = true;
        this.helpEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      });
      this.hintEl = footer.createDiv({ cls: 'pb-hints' });
      this.updateHint();
      // The focused field, not the event target: a conversion re-renders the row
      // and moves focus before the input event reaches this listener.
      contentEl.addEventListener('focusin', () => this.updateHint());
      contentEl.addEventListener('input', () => this.updateHint());
      footer.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close());
      footer.createEl('button', { cls: 'mod-cta', text: 'Save' }).addEventListener('click', () => this.save());
    }

    /** Say what the keyboard does in the focused field. */
    updateHint() {
      if (!this.hintEl) return;
      const target = activeDoc().activeElement;
      let text = hintFor(null, null, null, '', false);
      if (target && target === this.captionInput) {
        text = hintFor(null, null, 'caption', '', false);
      } else if (target && target.tagName === 'INPUT' && target.closest) {
        const rowEl = target.closest('.pb-row');
        const info = rowEl ? this.index.get(rowEl.dataset.id) : null;
        if (info) text = hintFor(info.node, rowEl.dataset.kind, fieldKeyOf(target), target.value, !!info.parent);
      }
      this.hintEl.setText(text);
      this.hintEl.setAttribute('title', text);
    }

    /** From the title: into the first line, making one in an empty block. */
    focusFirstLine() {
      const first = this.listEl.querySelector('input.pb-input');
      if (first) {
        first.focus();
        first.setSelectionRange(first.value.length, first.value.length);
        return;
      }
      this.mutate(() => {
        const node = newNode('state');
        this.model.nodes.push(node);
        this.focusNew(node);
      });
    }

    showMenu(menu, event, anchor) {
      if (event && event.type === 'contextmenu') {
        menu.showAtMouseEvent(event);
        return;
      }
      const rect = anchor.getBoundingClientRect();
      menu.showAtPosition({ x: rect.left, y: rect.bottom + 2 });
    }

    /* ---- history ---- */

    snapshot() {
      return JSON.stringify(this.model);
    }

    record(before) {
      this.undoStack.push(before);
      if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
      this.redoStack = [];
    }

    /** First keystroke of a typing run (per field) becomes one undo step. */
    beginTyping(key) {
      if (this.typingKey === key) return;
      this.record(this.snapshot());
      this.typingKey = key;
    }

    /**
     * Run a structural change. `change` returns false when nothing happened,
     * so no-op moves don't leave empty undo steps.
     */
    mutate(change) {
      const before = this.snapshot();
      if (change() === false) return false;
      this.record(before);
      this.typingKey = null;
      this.renderTree();
      this.schedulePreview();
      return true;
    }

    restore(from, to) {
      if (!from.length) return;
      to.push(this.snapshot());
      this.model = JSON.parse(from.pop());
      this.typingKey = null;
      const active = activeDoc().activeElement;
      if (active && active.dataset && active.dataset.focus) this.pendingFocus = active.dataset.focus;
      this.captionInput.value = this.model.caption || '';
      this.renderTree();
      this.schedulePreview();
    }

    undo() {
      this.restore(this.undoStack, this.redoStack);
    }

    redo() {
      this.restore(this.redoStack, this.undoStack);
    }

    /* ---- keyboard ---- */

    handleKey(event) {
      const mod = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      const run = (fn) => {
        event.preventDefault();
        event.stopPropagation();
        fn();
      };

      if (mod && event.key === 'Enter') return run(() => this.save());
      if (mod && key === 'z') return run(() => (event.shiftKey ? this.redo() : this.undo()));
      if (mod && key === 'y') return run(() => this.redo());

      const rowEl = event.target.closest && event.target.closest('.pb-row');
      const info = rowEl ? this.index.get(rowEl.dataset.id) : null;
      if (!info) return undefined;
      const row = { node: info.node, slot: parseSlot(rowEl.dataset.slot), kind: rowEl.dataset.kind };

      if (event.altKey && !mod && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        return run(() => this.move(row.node, event.key === 'ArrowUp' ? -1 : 1));
      }
      if (mod && (event.key === ']' || event.key === '[')) {
        return run(() => (event.key === ']' ? this.indent(row.node) : this.outdent(row.node)));
      }
      if (mod && event.key === '/') return run(() => this.toggleComment(row));
      if (mod && event.shiftKey && key === 'd') return run(() => this.duplicate(row.node));
      if (mod && event.shiftKey && key === 'k') return run(() => this.removeRow(row));

      if (event.target.tagName !== 'INPUT') return undefined;
      // Tab / Shift+Tab indent like a code editor. Always swallowed in a row, so a
      // line that cannot move does not send focus jumping to the next control.
      if (event.key === 'Tab' && !mod && !event.altKey && !event.isComposing) {
        return run(() => (event.shiftKey ? this.outdent(row.node) : this.indent(row.node)));
      }
      if (!mod && !event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        return run(() => this.focusNeighbour(event.target, event.key === 'ArrowUp' ? -1 : 1));
      }
      if (event.key === 'Enter' && !event.isComposing) {
        return run(() => this.pressEnter(row, event.target, event.shiftKey));
      }
      if (event.key === 'Backspace' && !mod && !event.altKey && !event.isComposing
        && this.pressBackspace(row, event.target)) {
        return run(() => {});
      }
      return undefined;
    }

    /*
     * Enter: an empty last line leaves its block (like a list in a Markdown editor);
     * a bare keyword line (`else`, `repeat`, `return`, `end if`) becomes what it says;
     * then a new line inside a block head, after anything else.
     */
    pressEnter(row, input, shift) {
      const { node } = row;
      const key = fieldKeyOf(input);
      const info = this.index.get(node.id);
      if (node.type === 'state' && row.kind === 'node' && key === 'text' && info) {
        const value = input.value;
        if (!value.trim() && node.comment == null && info.parent && info.index === info.array.length - 1 && !shift) {
          this.outdent(node);
          return;
        }
        if (BARE_KEYWORD.test(value)) {
          const typed = PS.typedLine(value, { final: true });
          if (typed && this.applyTyped(node, typed, { enter: true })) return;
        }
      }
      // `if x > 0 then`, `while (i < n) {`: drop what other dialects put around a condition.
      const holder = key === 'cond' && node.type === 'if' ? node.branches[Number.isInteger(row.slot) ? row.slot : 0]
        : (key === 'cond' || key === 'until' || key === 'init' || key === 'bound') ? node : null;
      if (holder && typeof holder[key] === 'string') {
        const clean = PS.cleanCondition(holder[key]);
        if (clean !== holder[key].trim()) holder[key] = clean;
      }
      if (PS.isContainer(node) && row.kind !== 'until' && !shift) this.addInside(node, row.slot);
      else this.addAfter(node);
    }

    /*
     * Backspace at the very start of a field: an empty line goes away (focus moves
     * up); a block head whose keyword was a mistake becomes a plain line again,
     * its own lines following it.
     */
    pressBackspace(row, input) {
      if (input.selectionStart !== 0 || input.selectionEnd !== 0) return false;
      const { node } = row;
      const key = fieldKeyOf(input);
      const info = this.index.get(node.id);
      if (!info || row.kind !== 'node') return false;
      if (node.type === 'state') {
        if (key !== 'text' || input.value !== '' || node.comment != null) return false;
        const inputs = Array.from(this.listEl.querySelectorAll('input.pb-input:not(.pb-comment-input)'));
        const previous = inputs[inputs.indexOf(input) - 1];
        this.mutate(() => {
          info.array.splice(info.index, 1);
          if (previous) {
            this.pendingFocus = previous.dataset.focus;
            this.pendingCaret = 'end';
          }
        });
        if (!previous) this.captionInput.focus();
        return true;
      }
      const field = { if: 'cond', while: 'cond', for: 'init', return: 'text', print: 'text', require: 'text', ensure: 'text' }[node.type];
      if (!field || key !== field) return false;
      if (node.type === 'if' && (node.branches.length > 1 || node.elseBody)) return false;
      const source = node.type === 'if' ? node.branches[0] : node;
      let text = source[field] || '';
      if (node.type === 'for' && !node.all && node.bound) text = `${text} ${node.downto ? 'downto' : 'to'} ${node.bound}`;
      this.mutate(() => {
        const statement = PS.node('state', { text, textMath: source[`${field}Math`] !== false });
        if (node.comment != null) statement.comment = node.comment;
        const children = PS.isContainer(node) ? PS.childLists(node).flat() : [];
        info.array.splice(info.index, 1, statement, ...children);
        this.focusNew(statement, 0);
      });
      return true;
    }

    /* ---- typing shortcuts ---- */

    /**
     * A field was edited: store it, then apply typing shortcuts. Returns true when
     * a shortcut restructured the tree (the row has been re-rendered).
     */
    fieldInput(row, target, part, value, previous, composing) {
      if (part.math) {
        target[part.key] = PS.normalizeOperators(value);
        // Decided from the current text each time, so clearing the field or a stray CJK
        // character does not lock it into plain text; only source prose stays prose.
        if (!target[`${part.key}Prose`]) target[`${part.key}Math`] = !hasCjk(value);
      } else {
        target[part.key] = value;
      }
      if (composing) return false;
      return this.typedShortcut(row, target, part, value, previous);
    }

    /**
     * Shortcuts fire once, when the text first takes their shape (so editing an
     * older line that happens to start with "for" changes nothing):
     * - a keyword at the start of a plain line makes the block (`if `, `while `,
     *   `for `, `for each `, `repeat `, `return `, `procedure `, `// ` …);
     * - `else …` / `else if …` join the if above, `until …` closes the repeat;
     * - ` to ` / ` downto ` splits a for head, `in` / `each` makes it a for-each;
     * - `(` after a procedure name moves on to its arguments;
     * - ` // ` starts the trailing comment.
     */
    typedShortcut(row, target, part, value, previous) {
      const { node } = row;
      const fresh = (pattern) => pattern.test(value) && !pattern.test(previous);
      const COMMENT_AT = /\s\/\/(?:\s|$)/;
      if (part.math && row.comment && fresh(COMMENT_AT)) {
        const at = value.search(COMMENT_AT);
        const text = value.slice(0, at).trimEnd();
        const note = value.slice(at).replace(/^\s*\/\/\s?/, '');
        this.mutate(() => {
          target[part.key] = PS.normalizeOperators(text);
          row.comment.target[row.comment.key] = note;
          const id = this.commentKey(row);
          this.openComments.add(id);
          this.pendingFocus = `comment:${id}`;
          this.pendingCaret = 'end';
        });
        return true;
      }
      if (node.type === 'state' && part.key === 'text' && row.kind === 'node') {
        const typed = PS.typedLine(value);
        return typed && !PS.typedLine(previous) ? this.applyTyped(node, typed) : false;
      }
      if (node.type === 'for' && !node.all && part.key === 'init') {
        if (fresh(/^\s*(?:each|all)\s/i) || fresh(/^[^\s=]+\s+(?:in|∈)\s/i)) {
          const head = PS.splitForHead(value);
          this.mutate(() => {
            Object.assign(node, { all: true, bound: '', downto: false, init: PS.normalizeOperators(head.fields.init), initMath: !hasCjk(value) });
            this.focusNew(node, 'end');
          });
          return true;
        }
        if (fresh(/\s(?:to|downto)\s/i)) {
          const head = PS.splitForHead(value);
          if (head.kind !== 'for' || !head.fields.split) return false;
          this.mutate(() => {
            Object.assign(node, { init: PS.normalizeOperators(head.fields.init), initMath: !hasCjk(head.fields.init), downto: head.fields.downto });
            if (head.fields.bound) Object.assign(node, { bound: PS.normalizeOperators(head.fields.bound), boundMath: !hasCjk(head.fields.bound) });
            this.pendingFocus = `${node.id}::bound`;
            this.pendingCaret = 'end';
          });
          return true;
        }
      }
      if ((node.type === 'function' || node.type === 'call') && part.key === 'name' && fresh(/\(/)) {
        const signature = PS.splitSignature(value);
        this.mutate(() => {
          node.name = signature.name;
          if (signature.args) Object.assign(node, { args: PS.normalizeOperators(signature.args), argsMath: !hasCjk(signature.args) });
          this.pendingFocus = `${node.id}::args`;
          this.pendingCaret = 'end';
        });
        return true;
      }
      return false;
    }

    /** The if an `else` / `else if` typed on this line belongs to, or null. */
    ifAbove(info) {
      const before = info.index > 0 ? info.array[info.index - 1] : null;
      if (before && before.type === 'if') return before.elseBody ? null : { node: before, inside: false };
      const { parent } = info;
      // Still inside the if's last branch (Enter there makes the new line inside):
      // the line and the lines below it move into the new branch.
      if (parent && parent.type === 'if' && !parent.elseBody
        && info.array === parent.branches[parent.branches.length - 1].body) return { node: parent, inside: true };
      return null;
    }

    /** Turn a plain line into what a typed keyword says. False when it does not fit here. */
    applyTyped(node, typed, { enter = false } = {}) {
      const info = this.index.get(node.id);
      if (!info) return false;
      const carry = node.comment;
      const fields = typed.fields || {};

      if (typed.kind === 'else' || typed.kind === 'elseif') {
        const host = this.ifAbove(info);
        if (!host) return false;
        const ifNode = host.node;
        this.mutate(() => {
          const followers = (host.inside ? info.array.splice(info.index) : info.array.splice(info.index, 1)).slice(1);
          if (typed.kind === 'else') {
            const rest = String(fields.rest || '');
            const first = rest.trim() ? PS.statementNode(rest) : newNode('state');
            ifNode.elseBody = [first, ...followers];
            if (carry != null) ifNode.elseComment = carry;
            this.focusNew(first, 'end');
          } else {
            const branch = { cond: PS.normalizeOperators(fields.cond || ''), condMath: !hasCjk(fields.cond), body: followers };
            if (carry != null) branch.comment = carry;
            ifNode.branches.push(branch);
            this.selected = { id: ifNode.id, slot: ifNode.branches.length - 1 };
            this.pendingFocus = `${ifNode.id}:${ifNode.branches.length - 1}:cond`;
            this.pendingCaret = 'end';
          }
          this.collapsed.delete(ifNode.id);
        });
        return true;
      }

      if (typed.kind === 'until') {
        const { parent } = info;
        if (!parent || parent.type !== 'repeat' || info.array !== parent.body) return false;
        const owner = this.index.get(parent.id);
        this.mutate(() => {
          const followers = info.array.splice(info.index).slice(1);
          Object.assign(parent, { until: PS.normalizeOperators(fields.cond || ''), untilMath: !hasCjk(fields.cond) });
          if (carry != null) parent.untilComment = carry;
          owner.array.splice(owner.index + 1, 0, ...followers);
          this.pendingFocus = `${parent.id}:until:until`;
          this.pendingCaret = 'end';
        });
        return true;
      }

      if (typed.kind === 'end') {
        // `end`, `end if`, `}`: this line (now empty) and the ones below leave the block.
        if (!info.parent) return false;
        this.mutate(() => {
          Object.assign(node, { text: '', textMath: true });
          delete node.textProse;
          const owner = this.index.get(info.parent.id);
          owner.array.splice(owner.index + 1, 0, ...info.array.splice(info.index));
          this.focusNew(node, 'end');
        });
        return true;
      }

      if (typed.kind === 'comment') {
        // `// note` at the start of a line: this line becomes a comment line.
        this.mutate(() => {
          Object.assign(node, { text: '', textMath: true, comment: fields.text || '' });
          delete node.textProse;
          const id = this.commentKey({ node, comment: { key: 'comment' } });
          this.openComments.add(id);
          this.pendingFocus = `comment:${id}`;
          this.pendingCaret = 'end';
        });
        return true;
      }

      const replacement = PS.nodeFromTyped(typed);
      if (!replacement) return false;
      this.mutate(() => {
        if (carry != null && replacement.type !== 'comment') replacement.comment = carry;
        info.array.splice(info.index, 1, replacement);
        const fieldless = replacement.type === 'break' || replacement.type === 'continue';
        if (replacement.type === 'repeat') {
          const rest = String(fields.rest || '');
          const first = rest.trim() ? PS.statementNode(rest) : newNode('state');
          replacement.body.push(first);
          this.focusNew(first, 'end');
        } else if (enter || fieldless) {
          // Enter on `return` / `break`: next line; on a block head: its first line.
          const next = newNode('state');
          if (PS.isContainer(replacement)) replacement.body.push(next);
          else info.array.splice(info.index + 1, 0, next);
          this.focusNew(next);
        } else if (replacement.type === 'for' && !replacement.all && fields.split) {
          this.selected = { id: replacement.id };
          this.pendingFocus = `${replacement.id}::bound`;
          this.pendingCaret = 'end';
        } else {
          this.focusNew(replacement, 'end');
        }
      });
      return true;
    }

    /* ---- paste ---- */

    /**
     * Pasting several lines (plain pseudocode in any common style, or LaTeX)
     * builds them as rows: replacing an empty line, else after this one (inside
     * the branch for an else-if / else row). Single lines paste as text.
     */
    pasteLines(row, text) {
      if (!/\n/.test(String(text || '').trim())) return false;
      const parsed = PS.parsePasted(text);
      if (!parsed.nodes.length) return false;
      if (parsed.latex) markSourceProse(parsed.nodes);
      const info = row ? this.index.get(row.node.id) : null;
      this.mutate(() => {
        if (parsed.caption && !this.model.caption) {
          this.model.caption = parsed.caption;
          this.captionInput.value = parsed.caption;
        }
        if (!info) this.model.nodes.push(...parsed.nodes);
        else if (row.kind === 'branch' || row.kind === 'else') PS.slotBody(row.node, row.slot).unshift(...parsed.nodes);
        else if (row.node.type === 'state' && !String(row.node.text || '').trim() && row.node.comment == null) {
          info.array.splice(info.index, 1, ...parsed.nodes);
        } else {
          info.array.splice(info.index + 1, 0, ...parsed.nodes);
        }
        this.focusNew(parsed.nodes[parsed.nodes.length - 1], 'end');
      });
      return true;
    }

    focusNeighbour(input, step) {
      const inputs = Array.from(this.listEl.querySelectorAll('input.pb-input:not(.pb-comment-input)'));
      const current = input.classList.contains('pb-comment-input')
        ? inputs.indexOf(input.closest('.pb-row').querySelector('input.pb-input'))
        : inputs.indexOf(input);
      const next = inputs[current + step];
      if (next) {
        next.focus();
        next.setSelectionRange(next.value.length, next.value.length);
      }
    }

    /* ---- tree rendering ---- */

    buildIndex() {
      this.index.clear();
      PS.walk(this.model.nodes, (node, array, index, parent) => {
        this.index.set(node.id, { node, array, index, parent });
      });
    }

    select(id, slot) {
      this.selected = id ? { id, slot: parseSlot(slot) } : null;
      this.listEl.querySelectorAll('.pb-row').forEach((element) => {
        element.toggleClass('pb-selected', !!this.selected
          && element.dataset.id === this.selected.id
          && parseSlot(element.dataset.slot) === this.selected.slot);
      });
    }

    renderTree() {
      this.buildIndex();
      if (this.selected && !this.index.has(this.selected.id)) this.selected = null;
      const scroll = this.listEl.scrollTop;
      this.listEl.empty();
      if (!this.model.nodes.length) {
        const empty = this.listEl.createDiv({
          cls: 'pb-empty',
          text: 'Empty. Click here (or press Enter in the title) and start typing: if x > 0, for i = 1 to n, return x … — or paste pseudocode (Python, C, CLRS or LaTeX).',
        });
        empty.addEventListener('click', () => this.focusFirstLine());
      }
      this.renderNodes(this.model.nodes, 0);
      this.listEl.scrollTop = scroll;
      if (this.selected) this.select(this.selected.id, this.selected.slot);
      if (this.pendingFocus) {
        const key = this.pendingFocus;
        this.pendingFocus = null;
        const caret = this.pendingCaret;
        this.pendingCaret = null;
        const input = this.listEl.querySelector(`[data-focus="${CSS.escape(key)}"]`);
        if (input) {
          input.focus();
          // A position (or 'end') keeps typing flowing; a new empty field is selected.
          if (caret != null && input.setSelectionRange) {
            const at = caret === 'end' ? input.value.length : Math.min(caret, input.value.length);
            input.setSelectionRange(at, at);
          } else if (input.select) input.select();
          input.scrollIntoView({ block: 'nearest' });
        }
      }
      this.pendingCaret = null;
      this.updateHint();
    }

    renderNodes(nodes, depth) {
      for (const node of nodes) this.renderNode(node, depth);
    }

    renderNode(node, depth) {
      const collapsed = this.collapsed.has(node.id);
      switch (node.type) {
        case 'if':
          node.branches.forEach((branch, index) => {
            if (collapsed && index > 0) return;
            this.renderRow({
              node, depth, slot: index, kind: index === 0 ? 'node' : 'branch',
              chip: index === 0 ? 'if' : 'else if',
              target: branch,
              parts: [field('cond', 'condition, e.g. x == NIL')],
              comment: index === 0 ? { target: node, key: 'comment' } : { target: branch, key: 'comment' },
            });
            if (!collapsed) this.renderNodes(branch.body, depth + 1);
          });
          if (node.elseBody && !collapsed) {
            this.renderRow({
              node, depth, slot: 'else', kind: 'else', chip: 'else', parts: [],
              comment: { target: node, key: 'elseComment' },
            });
            this.renderNodes(node.elseBody, depth + 1);
          }
          return;

        case 'repeat':
          this.renderRow({ node, depth, chip: 'repeat', parts: [], comment: { target: node, key: 'comment' } });
          if (!collapsed) {
            this.renderNodes(node.body, depth + 1);
            this.renderRow({
              node, depth, kind: 'until', slot: 'until', chip: 'until',
              parts: [field('until', 'condition, e.g. m == 9')],
              comment: { target: node, key: 'untilComment' },
            });
          }
          return;

        default: {
          const spec = ROWS[node.type === 'for' && node.all ? 'forall' : node.type] || ROWS.raw;
          this.renderRow({
            node, depth, chip: spec.chip, parts: spec.parts,
            comment: spec.noComment ? null : { target: node, key: 'comment' },
          });
          if (PS.isContainer(node) && !collapsed) this.renderNodes(node.body, depth + 1);
        }
      }
    }

    /**
     * One editor row. `target` holds the edited fields (the node, or an if
     * branch); `slot` says which if segment the row heads.
     */
    renderRow({ node, depth, chip, parts, slot, kind = 'node', target = node, comment }) {
      const element = this.listEl.createDiv('pb-row');
      element.dataset.id = node.id;
      element.dataset.kind = kind;
      if (slot != null) element.dataset.slot = String(slot);
      element.setCssProps({ '--pb-depth': String(depth) });
      const row = { node, slot, kind, comment, element };

      const handle = element.createEl('span', {
        cls: 'pb-drag',
        text: '⠿',
        attr: { draggable: 'true', 'aria-label': 'Drag to reorder' },
      });
      this.bindDrag(handle, element, row);

      const container = PS.isContainer(node) && kind === 'node';
      if (container) {
        const collapsed = this.collapsed.has(node.id);
        const toggle = element.createEl('button', {
          cls: 'pb-toggle clickable-icon',
          attr: { type: 'button', 'aria-label': collapsed ? 'Expand' : 'Collapse' },
        });
        setIcon(toggle, collapsed ? 'chevron-right' : 'chevron-down');
        toggle.addEventListener('click', (event) => {
          event.stopPropagation();
          if (collapsed) this.collapsed.delete(node.id);
          else this.collapsed.add(node.id);
          this.renderTree();
        });
      } else {
        element.createSpan('pb-toggle-spacer');
      }

      element.createSpan({ cls: `pb-chip pb-chip-${kind === 'node' ? node.type : kind}`, text: chip });
      const fields = element.createDiv('pb-fields');
      parts.forEach((part) => this.renderPart(fields, row, target, part));
      if (comment) this.renderComment(fields, row);

      this.renderActions(element, row);
      element.addEventListener('click', () => this.select(node.id, slot));
      element.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        this.select(node.id, slot);
        this.showMenu(this.rowMenu(row), event);
      });
      return element;
    }

    renderPart(parent, row, target, part) {
      if (typeof part === 'string') {
        parent.createSpan({ cls: 'pb-word', text: part });
        return;
      }
      if (part.select) {
        const select = parent.createEl('select', { cls: 'dropdown pb-select' });
        part.options.forEach(([label, value], index) => {
          const option = select.createEl('option', { text: label, value: String(index) });
          if ((target[part.select] || false) === value) option.selected = true;
        });
        select.addEventListener('change', () => {
          this.mutate(() => {
            target[part.select] = part.options[Number(select.value)][1];
          });
        });
        return;
      }

      const focusKey = `${row.node.id}:${row.slot != null ? row.slot : ''}:${part.key}`;
      const input = parent.createEl('input', {
        cls: 'pb-input',
        attr: { type: 'text', placeholder: part.placeholder || '', spellcheck: 'false' },
      });
      input.value = target[part.key] || '';
      input.dataset.focus = focusKey;
      if (part.key === 'name') input.addClass('pb-name');
      const markTex = () => {
        const tex = hasTex(input.value);
        input.toggleClass('pb-tex', tex);
        input.title = tex ? 'Contains LaTeX; kept as written' : '';
      };
      markTex();
      // The text as of the last keystroke outside an IME composition: shortcuts
      // compare against it, so they fire once, when typed.
      let settled = input.value;
      const changed = (composing) => {
        const converted = this.fieldInput(row, target, part, input.value, settled, composing);
        if (!composing) settled = input.value;
        if (converted) return;
        markTex();
        this.schedulePreview();
      };
      input.addEventListener('input', (event) => {
        this.beginTyping(focusKey);
        changed(!!event.isComposing);
      });
      input.addEventListener('compositionend', () => changed(false));
      input.addEventListener('paste', (event) => {
        const text = event.clipboardData ? event.clipboardData.getData('text/plain') : '';
        if (this.pasteLines(row, text)) event.preventDefault();
      });
    }

    commentKey(row) {
      return `${row.node.id}:${row.comment.key}:${row.slot != null ? row.slot : ''}`;
    }

    renderComment(parent, row) {
      const { target, key } = row.comment;
      const id = this.commentKey(row);
      if (target[key] == null && !this.openComments.has(id)) return;
      parent.createSpan({ cls: 'pb-word pb-comment-mark', text: '//' });
      const input = parent.createEl('input', {
        cls: 'pb-input pb-comment-input',
        attr: { type: 'text', placeholder: 'trailing comment', spellcheck: 'false' },
      });
      input.value = target[key] || '';
      input.dataset.focus = `comment:${id}`;
      input.addEventListener('input', () => {
        this.beginTyping(input.dataset.focus);
        target[key] = input.value;
        this.schedulePreview();
      });
    }

    toggleComment(row) {
      row.comment = row.comment || this.commentAccess(row);
      if (!row.comment) return; // comment lines have no trailing comment
      const { target, key } = row.comment;
      const id = this.commentKey(row);
      const showing = target[key] != null || this.openComments.has(id);
      if (showing && !String(target[key] || '').trim()) {
        this.openComments.delete(id);
        this.mutate(() => {
          delete target[key];
        });
        return;
      }
      this.openComments.add(id);
      this.pendingFocus = `comment:${id}`;
      this.renderTree();
    }

    /** Comment storage for a row described by node/slot/kind. */
    commentAccess({ node, slot, kind }) {
      if (node.type === 'if') {
        if (kind === 'else') return { target: node, key: 'elseComment' };
        if (Number.isInteger(slot) && slot > 0) return { target: node.branches[slot], key: 'comment' };
        return { target: node, key: 'comment' };
      }
      if (kind === 'until') return { target: node, key: 'untilComment' };
      const spec = ROWS[node.type];
      return spec && spec.noComment ? null : { target: node, key: 'comment' };
    }

    renderActions(element, row) {
      const box = element.createDiv('pb-actions');
      const button = (icon, label, handler) => {
        const control = box.createEl('button', { cls: 'clickable-icon', attr: { type: 'button', 'aria-label': label } });
        setIcon(control, icon);
        control.addEventListener('click', (event) => {
          event.stopPropagation();
          handler(event, control);
        });
      };
      if (row.kind !== 'until') {
        const inside = PS.isContainer(row.node);
        button('plus', inside ? 'Add statement inside (Enter)' : 'Add statement after (Enter)', () => (
          inside ? this.addInside(row.node, row.slot) : this.addAfter(row.node)
        ));
      }
      button('more-horizontal', 'More actions', (event, control) => {
        this.select(row.node.id, row.slot);
        this.showMenu(this.rowMenu(row), event, control);
      });
      if (row.kind !== 'until') {
        button('x', row.kind === 'branch' ? 'Remove branch' : row.kind === 'else' ? 'Remove else' : 'Delete', () => this.removeRow(row));
      }
    }

    rowMenu(row) {
      const { node, slot, kind } = row;
      const menu = new Menu();
      const item = (title, icon, run, hint) => menu.addItem((entry) => {
        entry.setTitle(hint ? `${title}  ${hint}` : title).setIcon(icon).onClick(run);
      });

      if (PS.isContainer(node) && kind !== 'until') item('Add statement inside', 'corner-down-right', () => this.addInside(node, slot), '↵');
      item('Add statement after', 'plus', () => this.addAfter(node), PS.isContainer(node) ? `${SHIFT}↵` : '↵');
      if (node.type === 'if') {
        menu.addSeparator();
        item('Add else-if branch', 'git-branch-plus', () => this.mutate(() => {
          const at = Number.isInteger(slot) ? slot + 1 : node.branches.length;
          node.branches.splice(at, 0, { cond: '', body: [] });
          this.pendingFocus = `${node.id}:${at}:cond`;
        }));
        if (!node.elseBody) item('Add else branch', 'git-branch', () => this.addElse(node));
        if (kind === 'branch') item('Remove this branch', 'minus', () => this.removeRow(row));
        if (kind === 'else') item('Remove else', 'minus', () => this.removeRow(row));
      }
      menu.addSeparator();
      item('Move up', 'arrow-up', () => this.move(node, -1), `${ALT}↑`);
      item('Move down', 'arrow-down', () => this.move(node, 1), `${ALT}↓`);
      item('Indent', 'indent', () => this.indent(node), 'Tab');
      item('Outdent', 'outdent', () => this.outdent(node), `${SHIFT}Tab`);
      menu.addSeparator();
      if (this.commentAccess(row)) item('Trailing comment', 'message-square', () => this.toggleComment(row), `${MOD}/`);
      item('Duplicate', 'copy', () => this.duplicate(node), `${MOD}${SHIFT}D`);
      item(kind === 'branch' ? 'Remove this branch' : kind === 'else' ? 'Remove else' : 'Delete', 'trash-2', () => this.removeRow(row), `${MOD}${SHIFT}K`);
      return menu;
    }

    /* ---- drag and drop ---- */

    bindDrag(handle, element, row) {
      handle.addEventListener('dragstart', (event) => {
        this.dragId = row.node.id;
        if (event.dataTransfer) {
          event.dataTransfer.effectAllowed = 'move';
          try { event.dataTransfer.setData('text/plain', row.node.id); } catch (error) { /* ignore */ }
        }
        element.addClass('pb-dragging');
      });
      handle.addEventListener('dragend', () => {
        this.dragId = null;
        element.removeClass('pb-dragging');
        this.clearDropStyles();
      });
      element.addEventListener('dragover', (event) => this.handleDragOver(event, row, element));
      element.addEventListener('dragleave', (event) => {
        if (!element.contains(event.relatedTarget)) element.removeClass('pb-drop-before', 'pb-drop-after', 'pb-drop-inside');
      });
      element.addEventListener('drop', (event) => this.handleDrop(event, row));
    }

    clearDropStyles(keepTarget = false) {
      if (!keepTarget) this.dropTarget = null;
      this.listEl.querySelectorAll('.pb-row').forEach((element) => {
        element.removeClass('pb-drop-before', 'pb-drop-after', 'pb-drop-inside');
      });
    }

    handleDragOver(event, row, element) {
      if (!this.dragId || this.dragId === row.node.id) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      const rect = element.getBoundingClientRect();
      const ratio = (event.clientY - rect.top) / Math.max(1, rect.height);
      let mode = ratio < 0.5 ? 'before' : 'after';
      // Branch/else/until rows only accept drops into their own segment.
      if (row.kind !== 'node') mode = row.kind === 'until' ? 'after' : 'inside';
      else if (PS.isContainer(row.node) && ratio > 0.3 && ratio < 0.7) mode = 'inside';
      this.dropTarget = { id: row.node.id, mode, slot: row.slot };
      this.clearDropStyles(true);
      element.addClass(`pb-drop-${mode}`);
    }

    handleDrop(event, row) {
      event.preventDefault();
      const target = this.dropTarget;
      const movedId = this.dragId;
      this.clearDropStyles();
      this.dragId = null;
      if (!movedId || !target || target.id !== row.node.id) return;
      const slot = target.slot === 'until' ? undefined : target.slot;
      this.mutate(() => {
        if (!PS.reorder(this.model.nodes, movedId, row.node.id, target.mode, slot)) return false;
        this.selected = { id: movedId };
        return true;
      });
    }

    /* ---- structural operations ---- */

    /** Put a new node at the selection: inside a selected container, else after it. */
    insertNode(node) {
      const info = this.selected ? this.index.get(this.selected.id) : null;
      this.mutate(() => {
        if (info && PS.isContainer(info.node) && this.selected.slot !== 'until') {
          this.collapsed.delete(info.node.id);
          PS.slotBody(info.node, this.selected.slot).push(node);
        } else if (info) {
          info.array.splice(info.index + 1, 0, node);
        } else {
          this.model.nodes.push(node);
        }
        this.focusNew(node);
      });
    }

    /** Focus a node's first field after the next render (`caret`: a position or 'end'). */
    focusNew(node, caret) {
      this.selected = { id: node.id };
      const first = {
        if: '0:cond', while: ':cond', for: ':init', repeat: 'until:until', function: ':name', call: ':name',
      }[node.type] || ':text';
      this.pendingFocus = `${node.id}:${first}`;
      this.pendingCaret = caret == null ? null : caret;
    }

    addInside(node, slot) {
      const child = newNode('state');
      this.mutate(() => {
        this.collapsed.delete(node.id);
        PS.slotBody(node, slot).push(child);
        this.focusNew(child);
      });
    }

    addAfter(node) {
      const info = this.index.get(node.id);
      if (!info) return;
      const sibling = newNode('state');
      this.mutate(() => {
        info.array.splice(info.index + 1, 0, sibling);
        this.focusNew(sibling);
      });
    }

    addElse(node) {
      this.mutate(() => {
        node.elseBody = [newNode('state')];
        this.focusNew(node.elseBody[0]);
      });
    }

    duplicate(node) {
      const info = this.index.get(node.id);
      if (!info) return;
      this.mutate(() => {
        const copy = cloneNode(node);
        info.array.splice(info.index + 1, 0, copy);
        this.selected = { id: copy.id };
      });
    }

    move(node, direction) {
      const info = this.index.get(node.id);
      if (!info) return;
      const target = info.index + direction;
      if (target < 0 || target >= info.array.length) return;
      this.keepFocus();
      this.mutate(() => {
        const [moved] = info.array.splice(info.index, 1);
        info.array.splice(target, 0, moved);
      });
    }

    indent(node) {
      const info = this.index.get(node.id);
      const previous = info && info.index > 0 ? info.array[info.index - 1] : null;
      if (!previous || !PS.isContainer(previous)) return;
      this.keepFocus();
      this.mutate(() => {
        info.array.splice(info.index, 1);
        this.collapsed.delete(previous.id);
        PS.bodyOf(previous).push(node);
      });
    }

    /**
     * Move a line out of its block, right after the block. The lines below it in
     * the same body come along (as when dedenting a run of lines in an editor), so
     * the text keeps its order: while { A; X; B } → while { A }; X; B.
     */
    outdent(node) {
      const info = this.index.get(node.id);
      const owner = info && info.parent ? this.index.get(info.parent.id) : null;
      if (!owner) return;
      this.keepFocus();
      this.mutate(() => {
        const moved = info.array.splice(info.index);
        owner.array.splice(owner.index + 1, 0, ...moved);
      });
    }

    /** Delete a node, or the if segment (else-if / else) a row heads. */
    removeRow(row) {
      const { node, slot, kind } = row;
      if (kind === 'branch') {
        this.mutate(() => { node.branches.splice(slot, 1); });
        return;
      }
      if (kind === 'else') {
        this.mutate(() => { node.elseBody = null; });
        return;
      }
      const info = this.index.get(node.id);
      if (!info) return;
      // Keep the keyboard flowing: focus the row that takes this one's place.
      const neighbour = info.array[info.index + 1] || info.array[info.index - 1] || info.parent;
      this.mutate(() => {
        info.array.splice(info.index, 1);
        if (this.selected && this.selected.id === node.id) this.selected = null;
        if (neighbour) {
          const input = this.listEl.querySelector(`.pb-row[data-id="${neighbour.id}"] input.pb-input`);
          if (input) this.pendingFocus = input.dataset.focus;
        }
      });
    }

    /** After a move or indent: the same field, the caret where it was. */
    keepFocus() {
      const active = activeDoc().activeElement;
      if (active && active.dataset && active.dataset.focus) {
        this.pendingFocus = active.dataset.focus;
        if (typeof active.selectionStart === 'number') this.pendingCaret = active.selectionStart;
      }
    }

    /* ---- preview and saving ---- */

    schedulePreview() {
      clearTimeout(this.previewTimer);
      this.previewTimer = setTimeout(() => this.renderPreview(), 120);
    }

    async renderPreview() {
      const token = ++this.previewToken;
      const latex = PS.serializeLatex(this.model);
      this.latexEl.setText(latex);
      const component = new Component();
      component.load();
      const holder = createDiv();
      try {
        // Same path as a saved block: LaTeX → AST → DOM.
        const block = PS.renderBlock(PS.parseLatex(latex), this.settings);
        holder.appendChild(block);
        await PS.typesetMath(this.app, block, this.sourcePath, component);
      } catch (error) {
        holder.replaceChildren();
        holder.createDiv({ cls: 'pb-error', text: `Render failed: ${error.message}` });
      }
      // A newer render started meanwhile: drop this one.
      if (token !== this.previewToken) {
        component.unload();
        return;
      }
      this.previewEl.replaceChildren(...holder.childNodes);
      if (this.previewComponent) this.previewComponent.unload();
      this.previewComponent = component;
    }

    validate() {
      let problem = null;
      PS.walk(this.model.nodes, (node) => {
        if (problem) return;
        if (node.type === 'function' && !String(node.name || '').trim()) problem = { node, message: 'Procedure name is required' };
        if (node.type === 'call' && !String(node.name || '').trim()) problem = { node, message: 'Call needs a procedure name' };
      });
      return problem;
    }

    async save() {
      const problem = this.validate();
      if (problem) {
        new Notice(problem.message);
        this.collapsed.clear();
        this.selected = { id: problem.node.id };
        this.pendingFocus = `${problem.node.id}::name`;
        this.renderTree();
        return;
      }
      if (!this.isDirty()) {
        this.closeNow();
        return;
      }
      try {
        await this.onSave(PS.serializeLatex(this.model));
      } catch (error) {
        new Notice(`Save failed: ${error.message}`);
        return;
      }
      this.closeNow();
    }
  }

  /** Which field an input edits: `text`, `cond`, `init` … or `comment`. */
  function fieldKeyOf(input) {
    const focus = (input && input.dataset && input.dataset.focus) || '';
    return focus.startsWith('comment:') ? 'comment' : focus.split(':').pop();
  }

  /** Keyword lines that only mean something once Enter ends them. */
  const BARE_KEYWORD = /^\s*(?:\}\s*)?(?:else(?:\s*if)?|elseif|elif|elsif|repeat|return|break|continue|end(?:\s+\w+)?|endif|endwhile|endfor|fi|od|done|\})\s*[:{;]?\s*$/i;

  function parseSlot(value) {
    if (value == null || value === '') return undefined;
    return /^\d+$/.test(value) ? Number(value) : value;
  }

  PS.BuilderModal = BuilderModal;
  PS.builderHint = hintFor;
  PS.ConfirmModal = ConfirmModal;
})(PS);
