// Builder keyboard: Tab / Shift+Tab indent and outdent (through the real key handler).
const { loadBuilder, suite } = require('./harness');

const PS = loadBuilder();
const { ok, eq, done } = suite();

function open(source) {
  const modal = new PS.BuilderModal({}, { model: PS.parseLatex(source) });
  // No DOM here: rebuild the index instead of rendering, skip focus and preview.
  modal.renderTree = () => modal.buildIndex();
  modal.schedulePreview = () => {};
  modal.keepFocus = () => {};
  modal.captionInput = { focus() {} };
  modal.listEl = { querySelectorAll: () => [] };
  modal.buildIndex();
  return modal;
}

/** Press a key in a field of the row for `node`; returns whether the default was prevented. */
function press(modal, node, key, extra = {}, field = {}) {
  let prevented = false;
  const slot = field.slot == null ? '' : String(field.slot);
  const rowEl = { dataset: { id: node.id, slot, kind: field.kind || 'node' } };
  const value = field.value != null ? field.value : (node.text || '');
  modal.handleKey(Object.assign({
    key,
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    isComposing: false,
    target: {
      tagName: 'INPUT',
      closest: () => rowEl,
      value,
      selectionStart: field.caret != null ? field.caret : value.length,
      selectionEnd: field.caret != null ? field.caret : value.length,
      dataset: { focus: `${node.id}:${slot}:${field.key || 'text'}` },
      classList: { contains: () => false },
    },
    preventDefault() { prevented = true; },
    stopPropagation() {},
  }, extra));
  return prevented;
}

/** Type `value` into a statement's text field (as the input listener does). */
function type(modal, node, value, { composing = false, key = 'text', target = node, row: rowExtra = {} } = {}) {
  const previous = target[key] || '';
  const row = Object.assign({ node, kind: 'node', comment: { target: node, key: 'comment' } }, rowExtra);
  modal.beginTyping(`${node.id}::${key}`);
  return modal.fieldInput(row, target, { key, math: key !== 'name' }, value, previous, composing);
}

const latex = (modal) => PS.serializeLatex(modal.model).split('\n').slice(2, -2).map((line) => line.trimEnd());
const find = (modal, text) => {
  let found = null;
  PS.walk(modal.model.nodes, (node) => { if (!found && node.text === text) found = node; });
  return found;
};

const LOOP = `\\While{$i > 0$}
\\State $a = 1$
\\EndWhile
\\State $b = 2$
\\State $c = 3$`;

{
  const m = open(LOOP);
  ok(press(m, find(m, 'b = 2'), 'Tab'), 'Tab is swallowed in a row');
  eq(latex(m), ['  \\While{$i > 0$}', '    \\State $a = 1$', '    \\State $b = 2$', '  \\EndWhile', '  \\State $c = 3$'],
    'Tab moves the line into the block above');
  press(m, find(m, 'b = 2'), 'Tab', { shiftKey: true });
  eq(latex(m), ['  \\While{$i > 0$}', '    \\State $a = 1$', '  \\EndWhile', '  \\State $b = 2$', '  \\State $c = 3$'],
    'Shift+Tab moves it back out');
  m.undo();
  eq(latex(m)[2], '    \\State $b = 2$', 'one undo step per press');
}

{
  const m = open(LOOP);
  ok(press(m, find(m, 'c = 3'), 'Tab'), 'Tab with no block above is still swallowed');
  eq(m.undoStack.length, 0, 'and changes nothing (no empty undo step)');
  press(m, find(m, 'a = 1'), 'Tab', { shiftKey: true });
  eq(latex(m)[0], '  \\While{$i > 0$}', 'a top-level line cannot be outdented further');
}

{
  // Shift+Tab in the middle of a block takes the lines below it along, keeping the order.
  const m = open(`\\For{$i = 1$ \\To $n$}
\\State $a = 1$
\\State $b = 2$
\\State $c = 3$
\\EndFor`);
  press(m, find(m, 'b = 2'), 'Tab', { shiftKey: true });
  eq(latex(m), ['  \\For{$i = 1$ \\To $n$}', '    \\State $a = 1$', '  \\EndFor', '  \\State $b = 2$', '  \\State $c = 3$'],
    'outdent from the middle keeps the order');
}

{
  // Into an if: the last segment (else when there is one).
  const m = open(`\\If{$x$}
\\State $a = 1$
\\Else
\\State $b = 2$
\\EndIf
\\State $c = 3$`);
  press(m, find(m, 'c = 3'), 'Tab');
  eq(m.model.nodes[0].elseBody.map((n) => n.text), ['b = 2', 'c = 3'], 'Tab after an if joins its else branch');
}

{
  const m = open(LOOP);
  ok(!press(m, find(m, 'b = 2'), 'Tab', { metaKey: true }), 'Cmd+Tab is left to the system');
  ok(!press(m, find(m, 'b = 2'), 'Tab', { isComposing: true }), 'Tab while composing (IME) is left alone');
  ok(press(m, find(m, 'b = 2'), ']', { metaKey: true }) && latex(m)[2] === '    \\State $b = 2$', 'Cmd+] still indents');
}

// ---- typing shortcuts ----
const EMPTY = '\\State \\text{}';
const tree = (modal) => {
  const out = [];
  const walk = (nodes, depth) => nodes.forEach((n) => {
    const pad = '  '.repeat(depth);
    if (n.type === 'if') {
      n.branches.forEach((b, i) => { out.push(`${pad}${i ? 'elseif' : 'if'} ${b.cond}`); walk(b.body, depth + 1); });
      if (n.elseBody) { out.push(`${pad}else`); walk(n.elseBody, depth + 1); }
    } else if (n.type === 'repeat') {
      out.push(`${pad}repeat`); walk(n.body, depth + 1); out.push(`${pad}until ${n.until}`);
    } else {
      const head = n.type === 'for' ? (n.all ? `for each ${n.init}` : `for ${n.init}${n.bound ? ` ${n.downto ? 'downto' : 'to'} ${n.bound}` : ''}`)
        : n.type === 'function' ? `procedure ${n.name}(${n.args})`
          : n.type === 'state' ? (n.text || '·') + (n.comment != null ? ` // ${n.comment}` : '')
            : `${n.type} ${n.cond || n.text || ''}`.trim();
      out.push(pad + head);
      if (n.body) walk(n.body, depth + 1);
    }
  });
  walk(modal.model.nodes, 0);
  return out;
};
const lastState = (modal) => {
  let found = null;
  PS.walk(modal.model.nodes, (n) => { if (n.type === 'state') found = n; });
  return found;
};

{
  // A whole if / else written by typing and Enter alone.
  const m = open(EMPTY);
  let line = m.model.nodes[0];
  ok(!type(m, line, 'i'), 'no shortcut yet');
  ok(type(m, line, 'if '), '"if " makes an if');
  const ifNode = m.model.nodes[0];
  eq([ifNode.type, m.pendingFocus, m.pendingCaret], ['if', `${ifNode.id}:0:cond`, 'end'], 'focus moves to the condition');
  type(m, ifNode, 'x > 0 then', { target: ifNode.branches[0], key: 'cond', row: { slot: 0 } });
  press(m, ifNode, 'Enter', {}, { key: 'cond', slot: 0, value: 'x > 0 then' });
  eq(ifNode.branches[0].cond, 'x > 0', 'Enter drops a trailing "then"');
  line = ifNode.branches[0].body[0];
  ok(line && line.type === 'state', 'Enter in the head opens the first line inside');
  type(m, line, 'y = 1');
  press(m, line, 'Enter');
  line = ifNode.branches[0].body[1];
  type(m, line, 'else');
  ok(!ifNode.elseBody, '"else" alone waits (it may become "else if")');
  press(m, line, 'Enter', {}, { value: 'else' });
  ok(ifNode.elseBody && ifNode.branches[0].body.length === 1, 'Enter on "else" makes the else branch');
  line = ifNode.elseBody[0];
  eq(m.pendingFocus, `${line.id}::text`, 'and focuses its first line');
  type(m, line, 'y = 2');
  press(m, line, 'Enter');
  line = ifNode.elseBody[1];
  press(m, line, 'Enter', {}, { value: '' });
  eq(tree(m), ['if x > 0', '  y = 1', 'else', '  y = 2', '·'], 'Enter on an empty last line leaves the block');
  type(m, m.model.nodes[1], 'return ');
  eq(m.model.nodes[1].type, 'return', '"return " makes a return line');
}

{
  const m = open(`\\If{$a$}
\\State $x = 1$
\\State $y = 2$
\\State $z = 3$
\\EndIf`);
  const ifNode = m.model.nodes[0];
  type(m, ifNode.branches[0].body[1], 'else if ');
  eq(tree(m), ['if a', '  x = 1', 'elseif ', '  z = 3'], '"else if " inside the branch: the lines below move into the new branch');
  eq(m.pendingFocus, `${ifNode.id}:1:cond`, 'focus on the new condition');
  type(m, ifNode.branches[1].body[0], 'else w');
  eq(tree(m), ['if a', '  x = 1', 'elseif ', 'else', '  w'], '"else w": else with its first statement');
}

{
  const m = open(`\\If{$a$}
\\State $x = 1$
\\EndIf
\\State $y = 2$
\\State $z = 3$`);
  type(m, m.model.nodes[1], 'else y = 2');
  eq(tree(m), ['if a', '  x = 1', 'else', '  y = 2', 'z = 3'], 'else typed under an if (same level): lines below stay put');
  const lone = open('\\State $q = 1$\n\\State $r$');
  type(lone, lone.model.nodes[1], 'else r');
  eq(lone.model.nodes[1].type, 'state', 'else with no if above stays text');
}

{
  const m = open(EMPTY);
  type(m, m.model.nodes[0], 'for ');
  const loop = m.model.nodes[0];
  type(m, loop, 'i = 1 to ', { key: 'init' });
  eq([loop.init, loop.bound, m.pendingFocus], ['i = 1', '', `${loop.id}::bound`], '" to " splits the for head');
  const m2 = open(EMPTY);
  type(m2, m2.model.nodes[0], 'for j = n downto 1');
  eq([m2.model.nodes[0].init, m2.model.nodes[0].bound, m2.model.nodes[0].downto], ['j = n', '1', true], 'a whole for line at once (paste)');
  const m3 = open(EMPTY);
  type(m3, m3.model.nodes[0], 'for ');
  type(m3, m3.model.nodes[0], 'v in ', { key: 'init' });
  ok(m3.model.nodes[0].all && m3.model.nodes[0].init === 'v in', '"v in " makes a for-each');
  const m4 = open(EMPTY);
  type(m4, m4.model.nodes[0], 'for each ');
  ok(m4.model.nodes[0].all, '"for each " makes a for-each');
}

{
  const m = open(EMPTY);
  type(m, m.model.nodes[0], 'repeat ');
  const loop = m.model.nodes[0];
  ok(loop.type === 'repeat' && loop.body.length === 1, '"repeat " makes a repeat with a first line');
  type(m, loop.body[0], 'x = x + 1');
  press(m, loop.body[0], 'Enter');
  type(m, loop.body[1], 'until x > 3');
  eq([loop.until, loop.body.length, m.pendingFocus], ['x > 3', 1, `${loop.id}:until:until`], '"until …" closes the repeat');
}

{
  const m = open(EMPTY);
  type(m, m.model.nodes[0], 'x = y // swap');
  eq([m.model.nodes[0].text, m.model.nodes[0].comment], ['x = y', 'swap'], '" // " moves the rest into the trailing comment');
  const c = open(EMPTY);
  type(c, c.model.nodes[0], '// note');
  eq([c.model.nodes[0].type, c.model.nodes[0].text, c.model.nodes[0].comment], ['state', '', 'note'], 'a line starting with // is a comment line');
  ok(/\\State \\Comment\{note\}/.test(PS.serializeLatex(c.model)), 'comment line serializes as \\State \\Comment (its own numbered line)', PS.serializeLatex(c.model));
  const pasted = open(EMPTY);
  pasted.pasteLines({ node: pasted.model.nodes[0], kind: 'node' }, 'x = 1\n// why\ny = 2');
  const pastedRows = PS.buildRows(PS.parseLatex(PS.serializeLatex(pasted.model)));
  eq(pastedRows.map((r) => [r.number, r.comment || '']), [[1, ''], [2, 'why'], [3, '']], 'pasted // line stays its own numbered line after a round trip');
}

{
  const m = open(EMPTY);
  type(m, m.model.nodes[0], 'procedure ');
  const fn = m.model.nodes[0];
  type(m, fn, 'Max-Heapify(', { key: 'name' });
  eq([fn.name, m.pendingFocus], ['Max-Heapify', `${fn.id}::args`], '"(" after the name moves on to the arguments');
  const m2 = open(EMPTY);
  type(m2, m2.model.nodes[0], 'procedure Merge(A, p, q, r)');
  eq([m2.model.nodes[0].name, m2.model.nodes[0].args], ['Merge', 'A, p, q, r'], 'whole header at once');
}

{
  // Only when typed: editing an older line that starts with a keyword changes nothing.
  const m = open('\\State for each vertex $u$, color it white');
  const line = m.model.nodes[0];
  type(m, line, `${line.text}!`);
  eq(m.model.nodes[0].type, 'state', 'existing keyword text is left alone');
  // IME: nothing during composition; checked when it ends.
  const ime = open(EMPTY);
  ok(!type(ime, ime.model.nodes[0], 'if ', { composing: true }), 'not while composing');
  ok(ime.fieldInput({ node: ime.model.nodes[0], kind: 'node', comment: null }, ime.model.nodes[0], { key: 'text', math: true }, 'if ', '', false), 'on composition end');
}

{
  // Undo takes back just the shortcut (like autocorrect).
  const m = open(EMPTY);
  type(m, m.model.nodes[0], 'while ');
  m.undo();
  eq([m.model.nodes[0].type, m.model.nodes[0].text], ['state', 'while '], 'undo restores the typed text');
}

{
  // Backspace at the start: empty line goes; a head becomes plain text again.
  const m = open('\\State $a = 1$\n\\State \\text{}');
  ok(press(m, m.model.nodes[1], 'Backspace', {}, { value: '', caret: 0 }), 'Backspace on an empty line is handled');
  eq(tree(m), ['a = 1'], 'and removes it');
  const w = open('\\While{$i > 0$}\n\\State $i = i - 1$\n\\EndWhile');
  press(w, w.model.nodes[0], 'Backspace', {}, { key: 'cond', value: 'i > 0', caret: 0 });
  eq(tree(w), ['i > 0', 'i = i - 1'], 'Backspace at the start of a head: plain line, body follows');
  const mid = open('\\State $a = 1$');
  ok(!press(mid, mid.model.nodes[0], 'Backspace', {}, { value: 'a = 1', caret: 3 }), 'mid-text Backspace is ordinary');
}

{
  // Paste several lines.
  const m = open(EMPTY);
  ok(m.pasteLines({ node: m.model.nodes[0], kind: 'node' }, 'if x\n    y = 1\nelse\n    y = 2\nreturn y'), 'multi-line paste handled');
  eq(tree(m), ['if x', '  y = 1', 'else', '  y = 2', 'return y'], 'pasted lines replace the empty line, nested by indentation');
  const one = open(EMPTY);
  ok(!one.pasteLines({ node: one.model.nodes[0], kind: 'node' }, 'x = 1'), 'a single line pastes as text');
  const tex = open('\\State $a$');
  tex.pasteLines({ node: tex.model.nodes[0], kind: 'node' }, '\\If{$b$}\n\\State $c$\n\\EndIf');
  eq(tree(tex), ['a', 'if b', '  c'], 'LaTeX paste goes after a non-empty line');
}

// Footer hints follow the focused field.
{
  const hint = PS.builderHint;
  const state = PS.node('state', { text: '' });
  ok(/leaves the block/.test(hint(state, 'node', 'text', '', true)), 'empty nested line: Enter leaves the block');
  ok(/paste/.test(hint(state, 'node', 'text', '  ', false)), 'empty top-level line: typing and paste');
  ok(/comment/.test(hint(state, 'node', 'text', 'x = 1', false)), 'filled line: comment shortcut');
  ok(/downto/.test(hint(PS.node('for', { init: '', bound: '' }), 'node', 'init', 'i = 1', false)), 'for start: to / downto');
  ok(/inside the loop/.test(hint(PS.node('for', { init: '', bound: '' }), 'node', 'bound', 'n', false)), 'for end: Enter goes inside');
  ok(/else/.test(hint(PS.node('if', { branches: [{ cond: '', body: [] }] }), 'node', 'cond', 'x', false)), 'if: how to add else');
  ok(/\(/.test(hint(PS.node('function', { name: '' }), 'node', 'name', 'F', false)), 'procedure name: ( jumps on');
  ok(/first line/.test(hint(null, null, 'caption', '', false)), 'title hint');
}

done();
