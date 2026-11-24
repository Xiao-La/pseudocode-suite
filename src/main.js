/*
 * Pseudocode Suite — plugin entry.
 */

const DEFAULT_SETTINGS = {
  lineNumbers: true,
  indentSize: '1.2em',
  commentDelimiter: '//',
  builderTips: true,
};

const CSS_LENGTH = /^\d*\.?\d+(?:em|rem|px|ch|pt)$/;

/* ---------------- fences ---------------- */

const FENCE_OPEN = /^((?:[ \t]*>)*[ \t]*)(`{3,}|~{3,})[ \t]*pseudo[ \t]*$/;

/**
 * Every ```pseudo fence in `lines`: { start, end, prefix, source }, with
 * start/end the fence lines. `prefix` is the blockquote/indent prefix the
 * content lines carry (fences inside callouts or lists).
 */
function scanFences(lines) {
  const fences = [];
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].match(FENCE_OPEN);
    if (!open) continue;
    const prefix = open[1];
    const depth = (prefix.match(/>/g) || []).length;
    const marker = open[2];
    const close = new RegExp(`^(?:[ \\t]*>){${depth}}[ \\t]*${marker[0] === '`' ? '`' : '~'}{${marker.length},}[ \\t]*$`);
    const strip = depth
      ? new RegExp(`^(?:[ \\t]*>){${depth}} ?`)
      : new RegExp(`^[ \\t]{0,${prefix.length}}`);
    let end = i + 1;
    while (end < lines.length && !close.test(lines[end])) end++;
    if (end >= lines.length) break; // unterminated
    fences.push({
      start: i,
      end,
      prefix: depth ? prefix.replace(/[ \t]*$/, ' ') : prefix,
      source: lines.slice(i + 1, end).map((line) => line.replace(strip, '')).join('\n'),
    });
    i = end;
  }
  return fences;
}

const sameSource = (a, b) => String(a || '').replace(/\s+/g, ' ').trim() === String(b || '').replace(/\s+/g, ' ').trim();

/** The fence holding `source`, preferring the one at (or nearest) `hint`. */
function locateFence(lines, source, hint) {
  const matches = scanFences(lines).filter((fence) => sameSource(fence.source, source));
  if (!matches.length) return null;
  if (!Number.isInteger(hint)) return matches[0];
  return matches.reduce((best, fence) => (Math.abs(fence.start - hint) < Math.abs(best.start - hint) ? fence : best));
}

/** Any fenced code block (not only ```pseudo) around `line`: { start, end, prefix, language, source }. */
function codeFenceAt(lines, line) {
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].match(/^((?:[ \t]*>)*[ \t]*)(`{3,}|~{3,})[ \t]*([^\s`]*)[^`]*$/);
    if (!open) continue;
    const prefix = open[1];
    const depth = (prefix.match(/>/g) || []).length;
    const marker = open[2];
    const close = new RegExp(`^(?:[ \\t]*>){${depth}}[ \\t]*${marker[0] === '`' ? '`' : '~'}{${marker.length},}[ \\t]*$`);
    const strip = depth ? new RegExp(`^(?:[ \\t]*>){${depth}} ?`) : new RegExp(`^[ \\t]{0,${prefix.length}}`);
    let end = i + 1;
    while (end < lines.length && !close.test(lines[end])) end++;
    if (end >= lines.length) return null;
    if (i <= line && line <= end) {
      return {
        start: i,
        end,
        prefix: depth ? prefix.replace(/[ \t]*$/, ' ') : prefix,
        language: open[3].toLowerCase(),
        source: lines.slice(i + 1, end).map((text) => text.replace(strip, '')).join('\n'),
      };
    }
    i = end;
  }
  return null;
}

/** Replacement lines for a fence's content, re-applying its prefix. */
function prefixed(latex, prefix) {
  return latex.split('\n').map((line) => (line || !prefix.trim() ? prefix + line : prefix.replace(/[ \t]+$/, '')));
}

/* ---------------- settings ---------------- */

class SettingsTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    const { settings } = this.plugin;

    const intro = containerEl.createDiv('ps-settings-intro');
    intro.createEl('p', { text: 'Write pseudocode in a ```pseudo code block, or build one without writing LaTeX:' });
    const steps = intro.createEl('ul');
    [
      'Run “Insert pseudocode block” from the command palette (or the ribbon) to open the builder.',
      'In the builder, type a line such as “if x > 0” or “for i = 1 to n” and it becomes a block; “else” joins the if above. Paste several lines to import existing pseudocode.',
      'To change a block later, click its Edit button, or run “Edit pseudocode block under cursor”.',
    ].forEach((text) => steps.createEl('li', { text }));
    intro.createEl('p', { text: 'The builder lists all typing rules and shortcuts under “Typing tips and shortcuts”.' });

    new Setting(containerEl)
      .setName('Show line numbers')
      .setDesc('Number each statement; procedure headers stay unnumbered and every procedure restarts at 1.')
      .addToggle((toggle) => toggle
        .setValue(settings.lineNumbers)
        .onChange((value) => this.plugin.updateSettings({ lineNumbers: value })));

    new Setting(containerEl)
      .setName('Indent width')
      .setDesc('Indent per nesting level, e.g. 1.2em or 16px.')
      .addText((text) => {
        text.setPlaceholder(DEFAULT_SETTINGS.indentSize).setValue(settings.indentSize);
        text.onChange((value) => {
          const clean = value.trim();
          const valid = !clean || CSS_LENGTH.test(clean);
          text.inputEl.toggleClass('ps-invalid', !valid);
          if (valid) this.plugin.updateSettings({ indentSize: clean || DEFAULT_SETTINGS.indentSize }, true);
        });
      });

    new Setting(containerEl)
      .setName('Comment prefix')
      .setDesc('Shown before trailing comments.')
      .addText((text) => text
        .setPlaceholder(DEFAULT_SETTINGS.commentDelimiter)
        .setValue(settings.commentDelimiter)
        .onChange((value) => this.plugin.updateSettings({ commentDelimiter: value || DEFAULT_SETTINGS.commentDelimiter }, true)));

    new Setting(containerEl)
      .setName('Show typing tips in the builder')
      .setDesc('Open the tips panel when the builder starts. Closing the panel in the builder turns this off.')
      .addToggle((toggle) => toggle
        .setValue(settings.builderTips !== false)
        .onChange((value) => this.plugin.saveSettingsOnly({ builderTips: value })));
  }
}

/* ---------------- plugin ---------------- */

class PseudocodeSuitePlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.blocks = new Set();
    // The fonts are embedded in styles.css (see build.py), which Obsidian loads itself.

    try {
      this.registerMarkdownCodeBlockProcessor('pseudo', (source, el, ctx) => this.renderCodeBlock(source, el, ctx));
    } catch (error) {
      // Only one plugin can render a code block language.
      new Notice('Pseudocode Suite: another plugin already renders ```pseudo blocks (for example "Pseudocode"). Turn it off and reload to use this one.', 0);
    }
    this.addSettingTab(new SettingsTab(this.app, this));

    this.addRibbonIcon('square-pen', 'Insert pseudocode block', () => this.openInsert(null));
    this.addCommand({
      id: 'insert-pseudocode-block',
      name: 'Insert pseudocode block',
      editorCallback: (editor) => this.openInsert(editor),
    });
    this.addCommand({
      id: 'edit-pseudocode-block',
      name: 'Edit pseudocode block under cursor',
      editorCheckCallback: (checking, editor, view) => {
        const fence = this.fenceAtCursor(editor);
        if (checking) return !!fence;
        if (fence) this.openEditorFence(editor, fence, view);
        return true;
      },
    });
    this.addCommand({
      id: 'convert-to-pseudocode',
      name: 'Convert selection or code block to pseudocode',
      editorCheckCallback: (checking, editor, view) => {
        const source = this.convertibleAt(editor);
        if (checking) return !!source;
        if (source) this.openConvert(editor, source, view);
        return true;
      },
    });
    this.addCommand({
      id: 'copy-pseudocode-latex',
      name: 'Copy pseudocode block as LaTeX',
      editorCheckCallback: (checking, editor) => {
        const fence = this.fenceAtCursor(editor);
        if (checking) return !!fence;
        if (fence) this.copyLatex(fence.source);
        return true;
      },
    });
    this.registerEvent(this.app.workspace.on('editor-menu', (menu, editor, view) => {
      const fence = this.fenceAtCursor(editor);
      if (fence) {
        menu.addItem((item) => item
          .setTitle('Edit pseudocode block')
          .setIcon('square-pen')
          .onClick(() => this.openEditorFence(editor, fence, view)));
        menu.addItem((item) => item
          .setTitle('Copy pseudocode as LaTeX')
          .setIcon('copy')
          .onClick(() => this.copyLatex(fence.source)));
        return;
      }
      const source = this.convertibleAt(editor);
      if (source) {
        menu.addItem((item) => item
          .setTitle(source.fence ? 'Convert code block to pseudocode' : 'Convert selection to pseudocode')
          .setIcon('square-pen')
          .onClick(() => this.openConvert(editor, source, view)));
      }
    }));
  }

  /* ---------------- settings ---------------- */

  async loadSettings() {
    const data = (await this.loadData()) || {};
    const legacy = data.jsSettings || {};
    const defined = (object) => Object.fromEntries(Object.entries(object).filter(([, value]) => value != null && value !== ''));
    this.settings = Object.assign({}, DEFAULT_SETTINGS, defined({
      lineNumbers: data.lineNumbers,
      indentSize: data.indentSize,
      commentDelimiter: data.commentDelimiter,
      builderTips: data.builderTips,
    }), defined({
      lineNumbers: legacy.lineNumber,
      indentSize: legacy.indentSize,
      commentDelimiter: legacy.commentDelimiter,
    }));
    if (!CSS_LENGTH.test(this.settings.indentSize)) this.settings.indentSize = DEFAULT_SETTINGS.indentSize;
    if (data.jsSettings) await this.saveData(this.settings);
  }

  /** Save, then repaint every rendered block (debounced while typing). */
  async updateSettings(patch, debounce = false) {
    Object.assign(this.settings, patch);
    await this.saveData(this.settings);
    window.clearTimeout(this.refreshTimer);
    if (debounce) this.refreshTimer = window.setTimeout(() => this.refreshAll(), 400);
    else this.refreshAll();
  }

  /** Save a setting that does not change how blocks look. */
  async saveSettingsOnly(patch) {
    Object.assign(this.settings, patch);
    await this.saveData(this.settings);
  }

  onunload() {
    window.clearTimeout(this.refreshTimer);
  }

  refreshAll() {
    this.blocks.forEach((entry) => this.paintEntry(entry));
  }

  /* ---------------- rendering ---------------- */

  async renderCodeBlock(source, el, ctx) {
    const entry = { source, el, ctx, child: new MarkdownRenderChild(el), component: null, token: 0 };
    ctx.addChild(entry.child);
    this.blocks.add(entry);
    entry.child.register(() => this.blocks.delete(entry));
    await this.paintEntry(entry);
  }

  async paintEntry(entry) {
    const token = ++entry.token;
    if (entry.component) entry.child.removeChild(entry.component);
    const component = new Component();
    entry.component = component;
    entry.child.addChild(component);

    const holder = createDiv();
    try {
      const model = PS.parseLatex(entry.source);
      const block = await PS.paint(this.app, holder, model, this.settings, entry.ctx.sourcePath, component);
      if (!model.caption && !model.nodes.length) {
        block.createDiv({ cls: 'ps-empty', text: 'Empty pseudocode block. Click Edit to build it, or write algorithmicx LaTeX here.' });
      }
      this.addEditButton(block, entry);
    } catch (error) {
      holder.replaceChildren();
      holder.createDiv({ cls: 'ps-error', text: `Pseudocode render failed: ${error && error.message ? error.message : error}` });
    }
    if (token !== entry.token) return; // a newer paint replaced this one
    entry.el.replaceChildren(...holder.childNodes);
  }

  addEditButton(block, entry) {
    const bar = block.createDiv('ps-actions');
    const copy = bar.createEl('button', {
      cls: 'ps-edit-btn ps-copy-btn',
      attr: { type: 'button', 'aria-label': 'Copy as LaTeX (algorithm + algpseudocode)' },
    });
    setIcon(copy.createSpan('ps-edit-icon'), 'copy');
    copy.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.copyLatex(entry.source);
    });
    const button = bar.createEl('button', {
      cls: 'ps-edit-btn',
      attr: { type: 'button', 'aria-label': 'Edit in pseudocode builder' },
    });
    setIcon(button.createSpan('ps-edit-icon'), 'pencil');
    button.createSpan({ text: 'Edit' });
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      // Ask at click time: the note may have changed since rendering.
      const section = entry.ctx.getSectionInfo ? entry.ctx.getSectionInfo(entry.el) : null;
      this.openFileFence(entry.ctx.sourcePath, entry.source, section ? section.lineStart : null);
    });
  }

  copyLatex(source) {
    PS.copyText(PS.exportLatex(PS.parseLatex(source)), 'LaTeX copied (the preamble it needs is in the comment on top)');
  }

  /* ---------------- opening the builder ---------------- */

  openBuilder(model, sourcePath, onSave, options = {}) {
    new PS.BuilderModal(this.app, Object.assign({
      model, settings: this.settings, sourcePath, onSave, saveSettings: (patch) => this.saveSettingsOnly(patch),
    }, options)).open();
  }

  /** Edit a block of a file on disk (reading view, live preview, embeds). */
  async openFileFence(path, source, hint) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      new Notice(`File not found: ${path}`);
      return;
    }
    if (file.extension === 'canvas') {
      await this.openCanvasFence(file, source);
      return;
    }
    const fence = locateFence((await this.app.vault.read(file)).split(/\r?\n/), source, hint);
    if (!fence) {
      new Notice('Could not find this pseudocode block in the note. Reopen the note and try again.');
      return;
    }
    this.openBuilder(PS.parseLatex(fence.source), path, async (latex) => {
      let found = true;
      await this.app.vault.process(file, (content) => {
        const eol = content.includes('\r\n') ? '\r\n' : '\n';
        const lines = content.split(/\r?\n/);
        const current = locateFence(lines, fence.source, fence.start);
        if (!current) {
          found = false;
          return content;
        }
        return lines.slice(0, current.start + 1)
          .concat(prefixed(latex, current.prefix), lines.slice(current.end))
          .join(eol);
      });
      if (!found) throw new Error('the block changed in the meantime');
      new Notice('Pseudocode updated');
    });
  }

  /**
   * A block on a canvas card. Canvas files are JSON: the card's text is found by
   * content and written back with only that string changed. An open canvas is
   * updated through its view when it offers one, so it does not save over the change.
   */
  async openCanvasFence(file, source) {
    const cardWith = (data) => (data.nodes || []).find((node) => node.type === 'text' && typeof node.text === 'string'
      && locateFence(node.text.split(/\r?\n/), source, null));
    let data;
    try {
      data = JSON.parse(await this.app.vault.read(file));
    } catch (error) {
      new Notice(`Could not read the canvas: ${error.message}`);
      return;
    }
    const card = cardWith(data);
    if (!card) {
      new Notice('Could not find this pseudocode block on the canvas. Reopen it and try again.');
      return;
    }
    const fence = locateFence(card.text.split(/\r?\n/), source, null);
    this.openBuilder(PS.parseLatex(fence.source), file.path, async (latex) => {
      const rewrite = (text) => {
        const lines = text.split(/\r?\n/);
        const current = locateFence(lines, fence.source, fence.start);
        if (!current) return null;
        return lines.slice(0, current.start + 1).concat(prefixed(latex, current.prefix), lines.slice(current.end)).join('\n');
      };
      // An open canvas keeps its own copy: change the card there.
      const view = this.app.workspace.getLeavesOfType('canvas').map((leaf) => leaf.view)
        .find((candidate) => candidate && candidate.file === file && candidate.canvas && candidate.canvas.nodes);
      const live = view ? Array.from(view.canvas.nodes.values()).find((node) => node.id === card.id) : null;
      if (live && typeof live.setText === 'function' && typeof live.text === 'string') {
        const next = rewrite(live.text);
        if (next == null) throw new Error('the block changed in the meantime');
        live.setText(next);
        if (typeof view.canvas.requestSave === 'function') view.canvas.requestSave();
        new Notice('Pseudocode updated');
        return;
      }
      let found = true;
      await this.app.vault.process(file, (content) => {
        const parsed = JSON.parse(content);
        const node = (parsed.nodes || []).find((candidate) => candidate.id === card.id);
        const next = node && typeof node.text === 'string' ? rewrite(node.text) : null;
        if (next == null) {
          found = false;
          return content;
        }
        // Replace only the card's text, keeping Obsidian's formatting of the file.
        const before = JSON.stringify(node.text);
        if (content.includes(before)) return content.replace(before, () => JSON.stringify(next));
        node.text = next;
        return JSON.stringify(parsed, null, '\t');
      });
      if (!found) throw new Error('the block changed in the meantime');
      new Notice('Pseudocode updated');
    });
  }

  /** What "convert to pseudocode" would read: the selection, else the code block at the cursor. */
  convertibleAt(editor) {
    if (!editor) return null;
    const selection = editor.getSelection();
    if (selection && selection.trim()) {
      return { text: selection, from: editor.getCursor('from'), to: editor.getCursor('to') };
    }
    const fence = codeFenceAt(editor.getValue().split(/\r?\n/), editor.getCursor().line);
    if (!fence || fence.language === 'pseudo' || !fence.source.trim()) return null;
    return { text: fence.source, fence };
  }

  /** Open the builder on pasted-style text; Save replaces it with a ```pseudo block. */
  openConvert(editor, source, view) {
    const parsed = PS.parsePasted(source.text);
    const model = parsed.model || { caption: parsed.caption || '', nodes: parsed.nodes };
    const path = view && view.file ? view.file.path : this.app.workspace.getActiveFile()?.path || '';
    const original = source.text;
    this.openBuilder(model, path, (latex) => {
      if (source.fence) {
        const lines = editor.getValue().split(/\r?\n/);
        const current = codeFenceAt(lines, source.fence.start);
        if (!current || current.source !== original) throw new Error('the code block changed in the meantime');
        const marker = lines[current.start].match(/`{3,}|~{3,}/)[0];
        const block = [`${current.prefix}${marker}pseudo`, ...prefixed(latex, current.prefix), `${current.prefix}${marker}`];
        editor.replaceRange(block.join('\n'), { line: current.start, ch: 0 }, { line: current.end, ch: lines[current.end].length });
      } else {
        if (editor.getRange(source.from, source.to) !== original) throw new Error('the selection changed in the meantime');
        const before = editor.getLine(source.from.line).slice(0, source.from.ch).trim() ? '\n' : '';
        const after = editor.getLine(source.to.line).slice(source.to.ch).trim() ? '\n' : '';
        editor.replaceRange(`${before}\`\`\`pseudo\n${latex}\n\`\`\`${after}`, source.from, source.to);
      }
      new Notice('Converted to pseudocode');
    }, { dirty: true });
  }

  fenceAtCursor(editor) {
    if (!editor) return null;
    const { line } = editor.getCursor();
    const lines = editor.getValue().split(/\r?\n/);
    return scanFences(lines).find((fence) => fence.start <= line && line <= fence.end) || null;
  }

  openEditorFence(editor, fence, view) {
    const path = view && view.file ? view.file.path : this.app.workspace.getActiveFile()?.path || '';
    this.openBuilder(PS.parseLatex(fence.source), path, (latex) => {
      // The note may have been edited while the builder was open.
      const current = locateFence(editor.getValue().split(/\r?\n/), fence.source, fence.start);
      if (!current) throw new Error('the block changed in the meantime');
      editor.replaceRange(
        `${prefixed(latex, current.prefix).join('\n')}\n`,
        { line: current.start + 1, ch: 0 },
        { line: current.end, ch: 0 },
      );
      new Notice('Pseudocode updated');
    });
  }

  openInsert(editor) {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const target = editor || (view && view.getMode() === 'source' ? view.editor : null);
    const file = view ? view.file : this.app.workspace.getActiveFile();
    this.openBuilder({ caption: '', nodes: [] }, file ? file.path : '', async (latex) => {
      const block = `\`\`\`pseudo\n${latex}\n\`\`\``;
      if (target) {
        // Fences must start and end on their own lines.
        const from = target.getCursor('from');
        const to = target.getCursor('to');
        const before = target.getLine(from.line).slice(0, from.ch).trim() ? '\n' : '';
        const after = target.getLine(to.line).slice(to.ch).trim() ? '\n' : '';
        target.replaceSelection(`${before}${block}\n${after}`);
        return;
      }
      if (!file) throw new Error('open a note before inserting');
      await this.app.vault.process(file, (content) => `${content.replace(/\s*$/, '')}\n\n${block}\n`);
      new Notice('Pseudocode appended to the end of the note');
    });
  }
}

module.exports = PseudocodeSuitePlugin;
