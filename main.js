/*
 * Pseudocode Suite — generated bundle. Edit files in src/ and run build.py.
 */

const {
  Plugin,
  Modal,
  Menu,
  Notice,
  MarkdownRenderer,
  MarkdownRenderChild,
  Component,
  MarkdownView,
  TFile,
  PluginSettingTab,
  Setting,
  setIcon,
  Platform,
  renderMath,
  finishRenderMath,
  loadMathJax,
} = require('obsidian');

/*
 * Pseudocode Suite — core model.
 * Parses the pseudocode LaTeX dialect used by the old pseudocode-in-obs blocks
 * into a small AST, and serializes that AST back to the same dialect.
 */

const PS = {};

/* ------------------------------------------------------------------ */
/* AST helpers                                                         */
/* ------------------------------------------------------------------ */

let uid = 0;
PS.nextId = () => `n${++uid}`;

PS.node = function node(type, fields) {
  return Object.assign({ id: PS.nextId(), type }, fields || {});
};

PS.CONTAINERS = new Set(['if', 'while', 'for', 'repeat', 'function']);
PS.isContainer = (node) => PS.CONTAINERS.has(node.type);

/** Every statement list directly owned by `node` (if: branches, then else). */
PS.childLists = function childLists(node) {
  if (node.type === 'if') {
    const lists = node.branches.map((branch) => branch.body);
    if (Array.isArray(node.elseBody)) lists.push(node.elseBody);
    return lists;
  }
  return Array.isArray(node.body) ? [node.body] : [];
};

/** Depth-first walk; visit(node, array, index, parent). */
PS.walk = function walk(nodes, visit, parent = null) {
  nodes.forEach((node, index) => {
    visit(node, nodes, index, parent);
    PS.childLists(node).forEach((list) => walk(list, visit, node));
  });
};

/**
 * The statement list of a container that new children go into. For an if,
 * `slot` is a branch index or 'else'; without a slot it is the last segment
 * (else when present), which is what sits visually right above the next row.
 */
PS.slotBody = function slotBody(node, slot) {
  if (node.type === 'if') {
    if (slot === 'else' && node.elseBody) return node.elseBody;
    if (Number.isInteger(slot) && node.branches[slot]) return node.branches[slot].body;
    return node.elseBody || node.branches[node.branches.length - 1].body;
  }
  return node.body || [];
};
PS.bodyOf = (node) => PS.slotBody(node);

/**
 * Move a node within the tree. `mode` is 'before' | 'after' | 'inside'
 * (`slot` picks the if segment for 'inside'). Refuses to move a node into
 * its own subtree.
 */
PS.reorder = function reorder(nodes, dragId, targetId, mode, slot) {
  if (!dragId || !targetId || dragId === targetId) return false;
  const locate = (id) => {
    let found = null;
    PS.walk(nodes, (node, array, index) => {
      if (node.id === id) found = { node, array, index };
    });
    return found;
  };
  const drag = locate(dragId);
  const target = locate(targetId);
  if (!drag || !target) return false;
  if (mode === 'inside' && !PS.isContainer(target.node)) return false;
  let inside = false;
  PS.walk([drag.node], (node) => { if (node.id === targetId) inside = true; });
  if (inside) return false;

  drag.array.splice(drag.index, 1);
  if (mode === 'inside') {
    PS.slotBody(target.node, slot).push(drag.node);
  } else {
    const next = locate(targetId);
    next.array.splice(next.index + (mode === 'after' ? 1 : 0), 0, drag.node);
  }
  return true;
};

/* ------------------------------------------------------------------ */
/* Operators                                                           */
/* ------------------------------------------------------------------ */

/** LaTeX / alternative spellings → the canonical ASCII form the builder shows. */
const OPERATOR_ALIASES = [
  [/\\neq\b/g, '!='],
  [/\\ne\b/g, '!='],
  [/\\leq?\b/g, '<='],
  [/\\geq?\b/g, '>='],
  [/\\gets\b/g, '='],
  [/:=/g, '='],
  [/<-|←/g, '='],
  [/<>/g, '!='],
  [/&&/g, 'and'],
  [/\|\|/g, 'or'],
  [/\\(?:And|AND)\b/g, 'and'],
  [/\\(?:Or|OR)\b/g, 'or'],
  [/\\(?:Not|NOT)\b/g, 'not'],
  // CLRS subarray ranges A[1 . . n] (clrscode \twodots) are typed as `..`.
  [/\s*\\twodots\b\s*/g, '..'],
];

/** Canonical ASCII operators → TeX. */
const SYMBOL_TEX = [
  [/<=/g, '\\le '],
  [/>=/g, '\\ge '],
  [/!=/g, '\\ne '],
  [/->/g, '\\to '],
  [/(\s*)\.\.(?!\.)\s*/g, (match, space, offset, text) => (/[.\\]/.test(text[offset + space.length - 1] || '') ? match : ' \\twodots ')],
];
const WORD_TEX = [
  // Inside math (a field written with backslashes): roman words, as in CLRS.
  [/\b(and|or|not)\b/g, (match, word, offset, text) => (/[\\{]/.test(text[offset - 1] || '') ? match : `\\text{ ${word} }`)],
];

const applyAll = (text, table) => table.reduce((value, [pattern, replacement]) => value.replace(pattern, replacement), text);

/** Normalize operators typed in the builder (or read from LaTeX) to ASCII. */
PS.normalizeOperators = function normalizeOperators(text) {
  return applyAll(String(text == null ? '' : text), OPERATOR_ALIASES);
};

/** ASCII operators and logic words → TeX (inside math). */
PS.texOperators = function texOperators(text, words = true) {
  const value = applyAll(String(text), SYMBOL_TEX);
  return words ? applyAll(value, WORD_TEX) : value;
};

// Font commands keep their argument as written; mask them while rewriting.
const FONT_GROUP = /\\(?:text|textbf|textit|texttt|textrm|textsf|textup|textsc|mathrm|mathit|mathbf|mathsf|mathtt|operatorname|Call)\{[^{}]*\}/g;

PS.maskFontGroups = function maskFontGroups(tex, transform) {
  const kept = [];
  const masked = String(tex).replace(FONT_GROUP, (group) => `\u0000${kept.push(group) - 1}\u0001`);
  return transform(masked).replace(/\u0000(\d+)\u0001/g, (all, index) => kept[Number(index)]);
};

/* ------------------------------------------------------------------ */
/* LaTeX helpers                                                       */
/* ------------------------------------------------------------------ */

/** Read a balanced `{...}` group starting at text[start] (which must be "{"). */
function readGroup(text, start) {
  if (text[start] !== '{') return null;
  let depth = 0;
  let value = '';
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') {
      depth += 1;
      if (depth === 1) continue;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return { value, end: i + 1 };
    }
    value += ch;
  }
  return { value, end: text.length }; // unbalanced: consume the rest
}

function firstGroup(text) {
  const start = text.indexOf('{');
  if (start < 0) return null;
  return readGroup(text, start);
}

/** Split a trailing `\Comment{...}` off a line. */
function splitComment(text) {
  const match = String(text).match(/^(.*?)\s*\\Comment\{([\s\S]*)\}\s*$/);
  if (!match) return { body: String(text), comment: null };
  return { body: match[1], comment: match[2] };
}

const countDollars = (value) => (value.match(/\$/g) || []).length;

function isSingleMath(text) {
  const value = String(text == null ? '' : text).trim();
  return value.startsWith('$') && value.endsWith('$') && countDollars(value) === 2;
}

const subscript = (all, letter, digits) => (digits.length === 1 ? `${letter}_${digits}` : `${letter}_{${digits}}`);
// Not before "(": an explicit \mathrm{Parent}(i) is a function name the
// author chose to set upright, not a procedure call (see PS.splitCalls).
const UNWRAP_FONT = /\\(?:text(?:bf|it|rm|sf|up)?|mathrm|mathit|mathbf)\{([^{}]*)\}(?!\()/g;

/**
 * Normalize a LaTeX fragment into something better for the visual editor:
 * drop `$` delimiters, turn \gets into "=", unwrap \mathrm/\text/\textbf, etc.
 * (\texttt marks code identifiers and is kept.)
 */
function fromMath(text) {
  let value = String(text == null ? '' : text).trim();
  const single = isSingleMath(value);
  if (single) value = value.slice(1, -1).trim();
  value = PS.normalizeOperators(value)
    .replace(/\\To\b/g, 'to')
    .replace(/\\DownTo\b/g, 'downto');
  // Innermost first; repeat so nested \mathrm{..\text{..}..} unwraps. In mixed text
  // (`\textbf{not} $S.\mathrm{empty}()$`) only inside the math runs: outside them the
  // font is the author's (bold keywords) and must survive a save.
  const unwrap = (text) => {
    // An explicit italic all-caps name (\mathit{KB}) is a variable, not the constant KB.
    const kept = [];
    let chunk = text.replace(/\\mathit\{[A-Z][A-Z0-9]+\}/g, (group) => `\u0002${kept.push(group) - 1}\u0003`);
    for (let previous = null; previous !== chunk;) {
      previous = chunk;
      chunk = chunk.replace(UNWRAP_FONT, '$1');
    }
    return chunk
      .replace(/\\textsc\{([a-z]+)\}/g, (all, word) => word.toUpperCase())
      .replace(/\u0002(\d+)\u0003/g, (all, index) => kept[Number(index)]);
  };
  value = value.includes('$')
    ? value.split(/(\$[^$]*\$)/).map((chunk, index) => (index % 2 ? unwrap(chunk) : chunk)).join('')
    // Prose without any math (`\Return \textbf{true}`) keeps its fonts as written.
    : single ? unwrap(value) : value;
  value = value
    .replace(/([A-Za-z])_\{(\d+)\}/g, subscript)
    .replace(/\\textbackslash\b/g, '\\')
    .replace(/\\_/g, '_')
    .replace(/\\[,;: ]/g, ' ');
  // `\State \text{}` is the empty placeholder of a comment-only line.
  return value.replace(/\\text\{\}/g, '').replace(/[ \t]+/g, ' ').trim();
}

PS.readGroup = readGroup;
PS.firstGroup = firstGroup;
PS.splitComment = splitComment;
PS.fromMath = fromMath;
PS.isSingleMath = isSingleMath;

/* ------------------------------------------------------------------ */
/* Procedure calls inside expressions                                  */
/* ------------------------------------------------------------------ */

/*
 * In builder fields a capitalized name directly followed by "(" is a
 * procedure call, typeset like \Call (small caps): `return Merge-Sort(A, p, r)`,
 * `x = Extract-Min(Q)`. Single letters stay math (T(n), O(n)); so does any
 * field containing a backslash, which is the escape hatch (\mathrm{Pr}(A)).
 *
 * The words and / or / not are written as words, never as ∧ ∨ ¬. CLRS sets them in
 * roman between the math (clrscode: `\While $i > 0$ and $A[i] > \id{key}$`), so
 * they are saved as plain text between math runs; only `error` is bold.
 */
// No regex lookbehind anywhere: iOS before 16.4 cannot parse it. Matches that a
// lookbehind would reject are skipped by checking the character before them.
const precededBy = (text, index, pattern) => index > 0 && pattern.test(text[index - 1]);
const CALL_AT = /([A-Z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*)\(/g;
const isCallName = (name) => /^[A-Z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*$/.test(name) && (name.match(/[A-Za-z]/g) || []).length >= 2;
const LOGIC_WORD = /(and|or|not)(?![A-Za-z0-9_])/g;
// `\textbf{and}` is how older notes wrote them; read, and saved back as plain words.
const LOGIC_TEX = /^\\textbf\{(and|or|not|error)\}/;
const LOGIC_PLAIN = /^(and|or|not)(?![A-Za-z0-9_])/;
// Quoted strings stay text, with typographic quotes: error “heap underflow”.
const STRING = /(“[^”]*”|"[^"]*")/;

/** Split text into text and keyword parts. */
function splitLogic(value) {
  const parts = [];
  let last = 0;
  LOGIC_WORD.lastIndex = 0;
  for (let match; (match = LOGIC_WORD.exec(value));) {
    if (precededBy(value, match.index, /[A-Za-z0-9_.]/)) {
      LOGIC_WORD.lastIndex = match.index + 1;
      continue;
    }
    if (match.index > last) parts.push({ type: 'text', value: value.slice(last, match.index) });
    parts.push({ type: 'keyword', value: match[1] });
    last = match.index + match[0].length;
  }
  if (last < value.length) parts.push({ type: 'text', value: value.slice(last) });
  return parts;
}

/** Split plain text into text, call and keyword parts, or null if it has none of the latter. */
function splitCalls(text) {
  const value = String(text == null ? '' : text);
  if (value.includes('\\') || value.includes('$')) return null;
  const parts = [];
  let last = 0;
  const pushText = (chunk) => {
    chunk.split(STRING).forEach((piece, index) => {
      if (!piece) return;
      if (index % 2) parts.push({ type: 'string', value: piece.slice(1, -1) });
      else parts.push(...splitLogic(piece));
    });
  };
  const lead = value.match(/^\s*error(?=\s|$)/);
  if (lead) {
    parts.push({ type: 'keyword', value: 'error' });
    last = lead[0].length;
  }
  CALL_AT.lastIndex = last;
  for (let match; (match = CALL_AT.exec(value));) {
    if (precededBy(value, match.index, /[A-Za-z0-9_.']/)) {
      CALL_AT.lastIndex = match.index + 1;
      continue;
    }
    if (!isCallName(match[1])) continue;
    const open = match.index + match[0].length - 1;
    let depth = 0;
    let close = -1;
    for (let i = open; i < value.length && close < 0; i++) {
      if (value[i] === '(') depth += 1;
      else if (value[i] === ')' && --depth === 0) close = i;
    }
    if (close < 0) continue;
    pushText(value.slice(last, match.index));
    parts.push({ type: 'call', name: match[1], args: value.slice(open + 1, close) });
    last = close + 1;
    CALL_AT.lastIndex = last;
  }
  pushText(value.slice(last));
  return parts.some((part) => part.type !== 'text') ? parts : null;
}

/**
 * Plain text with calls or logic words → inline LaTeX: math runs as `$...$`
 * (through `mathFn`), calls as \Call{Name}{args}, and / or / not as plain words,
 * error as \textbf{error}.
 * Null when there is neither.
 */
function inlineWithCalls(text, mathFn) {
  const parts = splitCalls(text);
  if (!parts) return null;
  const math = (segment) => {
    const [, before, body, after] = segment.match(/^(\s*)([\s\S]*?)(\s*)$/);
    if (!body) return segment ? ' ' : '';
    return `${before ? ' ' : ''}$${mathFn(body)}$${after ? ' ' : ''}`;
  };
  return parts.map((part) => {
    if (part.type === 'call') return `\\Call{${part.name}}{${inlineWithCalls(part.args, mathFn) || math(part.args).trim()}}`;
    if (part.type === 'keyword') return part.value === 'error' ? '\\textbf{error}' : part.value;
    if (part.type === 'string') return `“${part.value}”`;
    return math(part.value);
  }).join('').trim();
}

/**
 * The reverse, for the builder: `$x =$ \Call{Left}{$i$}` → `x = Left(i)`,
 * `$i > 0$ and $A[i] > \mathit{key}$` → `i > 0 and A[i] > key`.
 * Only for text made of nothing but math runs, calls and keywords; null otherwise.
 */
function callsToPlain(raw) {
  const text = String(raw == null ? '' : raw).trim();
  let out = '';
  let found = 0;
  let constants = 0;
  let i = 0;
  while (i < text.length) {
    if (text[i] === '“') {
      const end = text.indexOf('”', i + 1);
      if (end < 0) return null;
      out += text.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    const constant = text.slice(i).match(/^\\textsc\{([a-z]+)\}/);
    if (constant) {
      out += constant[1].toUpperCase();
      constants += 1;
      i += constant[0].length;
      continue;
    }
    if (/\s/.test(text[i])) {
      while (i < text.length && /\s/.test(text[i])) i++;
      out += ' ';
      continue;
    }
    if (text[i] === '$') {
      const end = text.indexOf('$', i + 1);
      if (end < 0) return null;
      out += fromMath(text.slice(i, end + 1));
      i = end + 1;
      continue;
    }
    // Bare punctuation between calls (`\Call{A}{$i$}, \Call{B}{$j$}`); words would change font.
    if (/[,;:()[\]+\-*/=<>]/.test(text[i])) {
      out += text[i++];
      continue;
    }
    const keyword = text.slice(i).match(LOGIC_TEX) || text.slice(i).match(LOGIC_PLAIN);
    if (keyword) {
      out += ` ${keyword[1]} `;
      found += 1;
      i += keyword[0].length;
      continue;
    }
    const call = text.slice(i).match(/^\\Call\{([^{}]*)\}/);
    if (!call || !isCallName(call[1])) return null;
    const args = readGroup(text, i + call[0].length);
    if (!args) return null;
    const inner = !args.value.trim() ? ''
      : callsToPlain(args.value) ?? (isSingleMath(args.value) ? fromMath(args.value) : null);
    if (inner == null) return null;
    out += `${call[1]}(${inner})`;
    found += 1;
    i = args.end;
  }
  const plain = out.replace(/\s+/g, ' ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').trim();
  // Anything still carrying LaTeX would not survive the trip back.
  if (/[\\$]/.test(plain)) return null;
  if (found) return inlineWithCalls(plain, (s) => s) ? plain : null;
  return constants ? plain : null;
}

PS.splitCalls = splitCalls;
PS.inlineWithCalls = inlineWithCalls;
PS.callsToPlain = callsToPlain;

/* ------------------------------------------------------------------ */
/* Parser                                                              */
/* ------------------------------------------------------------------ */

// Lines whose own `{...}` groups must not swallow a trailing \Comment.
const COMMENTABLE = new Set([
  'Function', 'Procedure', 'If', 'Elif', 'ElsIf', 'ElseIf', 'Else', 'While', 'For', 'ForAll', 'Repeat', 'Until',
  'Call', 'Break', 'Continue',
]);

// Fields that may be calls, constants or math joined by logic words.
const LOGIC_SOURCE = /\\Call\b|\\textbf\{(?:and|or|not|error)\}|\\textsc\{|(?:^|\$)\s*(?:and|or|not)\s+\$/;

/** `{ field: value, fieldMath: wasSingleMath }` for a math-carrying field. */
function mathField(name, raw) {
  // Older notes set the logic words bold; CLRS has them roman, as plain words.
  const source = (raw == null ? '' : raw).replace(/\\textbf\{(and|or|not)\}/g, '$1');
  const plain = LOGIC_SOURCE.test(source) ? callsToPlain(source) : null;
  if (plain != null) return { [name]: plain, [`${name}Math`]: true };
  return { [name]: fromMath(source), [`${name}Math`]: isSingleMath(source) };
}

/** A condition field: a single `=` there is a test, read (and saved) as `==`. */
function conditionField(name, raw) {
  const out = mathField(name, raw);
  const value = out[name];
  out[name] = out[`${name}Math`]
    ? PS.asComparison(value)
    : value.replace(/\$([^$]*)\$/g, (all, inner) => `$${PS.asComparison(inner)}$`);
  return out;
}

/** Join physical lines: an odd number of `$` continues on the next line. */
function logicalLines(source) {
  const lines = [];
  let pending = '';
  for (const piece of String(source == null ? '' : source).split(/\r?\n/)) {
    pending = pending ? `${pending} ${piece.trim()}` : piece;
    if (countDollars(pending) % 2 === 0) {
      lines.push(pending);
      pending = '';
    }
  }
  if (pending) lines.push(pending);
  return lines;
}

PS.parseLatex = function parseLatex(source) {
  const model = { caption: '', nodes: [] };
  const stack = [{ target: model.nodes, node: null }];
  const top = () => stack[stack.length - 1];
  const push = (node) => top().target.push(node);
  const open = (node, target) => {
    push(node);
    stack.push({ target, node });
  };
  const pop = () => {
    if (stack.length > 1) stack.pop();
  };

  for (const rawLine of logicalLines(source)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^\\(?:[Bb]egin|[Ee]nd)\{algorithm(?:ic)?\}/.test(line)) continue;
    if (/^\\label\{/.test(line)) continue;

    const match = line.match(/^\\([A-Za-z]+)([\s\S]*)$/);
    if (!match) {
      const { body, comment } = splitComment(line);
      push(withComment(PS.node('raw', { text: body.trim() }), comment));
      continue;
    }
    const name = match[1];
    let rest = (match[2] || '').trim();
    let lineComment = null;
    if (COMMENTABLE.has(name)) {
      const split = splitComment(rest);
      rest = split.body.trim();
      lineComment = split.comment;
    }
    const group = firstGroup(rest);

    switch (name) {
      case 'caption':
        model.caption = group ? group.value : rest;
        break;

      case 'Function':
      case 'Procedure': {
        const args = group ? readGroup(rest, group.end) : null;
        const node = PS.node('function', Object.assign(
          { kind: name, name: group ? group.value : '' },
          mathField('args', args ? args.value : ''),
          { body: [] },
        ));
        open(withComment(node, lineComment), node.body);
        break;
      }

      case 'If': {
        const branch = Object.assign(conditionField('cond', group ? group.value : ''), { body: [] });
        const node = PS.node('if', { branches: [branch], elseBody: null });
        open(withComment(node, lineComment), branch.body);
        break;
      }
      case 'Elif':
      case 'ElsIf':
      case 'ElseIf': {
        const { node } = top();
        if (!node || node.type !== 'if') break;
        const branch = withComment(Object.assign(conditionField('cond', group ? group.value : ''), { body: [] }), lineComment);
        node.branches.push(branch);
        stack[stack.length - 1] = { target: branch.body, node };
        break;
      }
      case 'Else': {
        const { node } = top();
        if (!node || node.type !== 'if') break;
        node.elseBody = [];
        if (lineComment !== null) node.elseComment = lineComment;
        stack[stack.length - 1] = { target: node.elseBody, node };
        break;
      }

      case 'While': {
        const node = PS.node('while', Object.assign(conditionField('cond', group ? group.value : ''), { body: [] }));
        open(withComment(node, lineComment), node.body);
        break;
      }

      case 'ForAll': {
        const clean = fromMath(group ? group.value : '').replace(/\$/g, '').trim();
        const node = PS.node('for', { all: true, init: clean, initMath: false, bound: '', body: [] });
        open(withComment(node, lineComment), node.body);
        break;
      }
      case 'For': {
        const content = group ? group.value : '';
        const parts = content.split(/\s*(?:\\textbf\{(?:to|downto)\}|\\To\b|\\DownTo\b|\bto\b|\bdownto\b)\s*/i);
        const bound = parts.length > 1 ? parts.slice(1).join('') : '';
        const node = PS.node('for', Object.assign(
          mathField('init', parts[0] || ''),
          parts.length > 1 ? mathField('bound', bound) : { bound: '', boundMath: false },
          { downto: /\bDownTo\b/i.test(content), body: [] },
        ));
        open(withComment(node, lineComment), node.body);
        break;
      }

      case 'Repeat': {
        const node = PS.node('repeat', { body: [], until: '' });
        open(withComment(node, lineComment), node.body);
        break;
      }
      case 'Until': {
        const { node } = top();
        if (!node || node.type !== 'repeat') break;
        Object.assign(node, conditionField('until', group ? group.value : ''));
        if (lineComment !== null) node.untilComment = lineComment;
        pop();
        break;
      }

      case 'EndFunction':
      case 'EndProcedure':
      case 'EndIf':
      case 'EndWhile':
      case 'EndFor':
        pop();
        break;

      case 'State': {
        const { body, comment } = splitComment(rest);
        // \State \Return / \Break / \Continue / \Print are common shorthand.
        const keyword = body.match(/^\\(Return|Break|Continue|Print)\b\s*([\s\S]*)$/);
        const call = body.match(/^\\Call\{([^{}]*)\}\{([\s\S]*)\}$/);
        let node;
        if (keyword) {
          const kind = keyword[1].toLowerCase();
          node = kind === 'break' || kind === 'continue'
            ? PS.node(kind)
            : PS.node(kind, mathField('text', keyword[2]));
        } else if (call) {
          node = PS.node('call', Object.assign({ name: call[1] }, mathField('args', call[2])));
        } else {
          node = PS.node('state', mathField('text', body));
        }
        push(withComment(node, comment));
        break;
      }

      case 'Call': {
        const args = group ? readGroup(rest, group.end) : null;
        push(withComment(PS.node('call', Object.assign(
          { name: group ? group.value : '' },
          mathField('args', args ? args.value : ''),
        )), lineComment));
        break;
      }

      case 'Require':
      case 'Ensure':
      case 'Input':
      case 'Output':
      case 'Return':
      case 'Print': {
        const { body, comment } = splitComment(rest);
        const inner = body.startsWith('{') ? firstGroup(body) : null;
        const type = name === 'Input' ? 'require'
          : name === 'Output' ? 'ensure'
            : name.toLowerCase();
        push(withComment(PS.node(type, mathField('text', inner ? inner.value : body)), comment));
        break;
      }

      case 'Break':
      case 'Continue':
        push(withComment(PS.node(name.toLowerCase()), lineComment));
        break;

      case 'Comment': {
        // A standalone \Comment line belongs to the previous statement (LaTeX
        // joins the lines); only a comment that opens a body stands alone.
        const text = group ? group.value : rest;
        const array = top().target;
        const previous = array[array.length - 1];
        if (previous && !previous.comment) previous.comment = text;
        else array.push(PS.node('comment', { text }));
        break;
      }

      case 'Statex':
        // \Statex is a blank spacing line in algorithmicx; render nothing.
        break;

      default: {
        const { body, comment } = splitComment(line);
        push(withComment(PS.node('raw', { text: body.trim() }), comment));
      }
    }
  }
  return model;
};

function withComment(target, comment) {
  if (comment != null) target.comment = comment;
  return target;
}

/* ------------------------------------------------------------------ */
/* Serializer                                                          */
/* ------------------------------------------------------------------ */

const KEYWORD_WORDS = new Set(['and', 'or', 'not']);

// A word rendered upright in math; spaces next to one are real word gaps.
const WORDISH = String.raw`\\(?:mathrm|text|textbf|textsc)\{[^{}]*\}`;
const SPACE_AFTER_WORD = new RegExp(`(${WORDISH})\\s+(?=[A-Za-z0-9(\\[“‘"']|${WORDISH})`, 'g');
const SPACE_BEFORE_WORD = new RegExp(`([A-Za-z0-9\\])”’"'])\\s+(?=${WORDISH})`, 'g');
// True when `index` sits inside a control word like \alpha.
const inCommand = (text, index) => /\\[A-Za-z]*$/.test(text.slice(0, index));

// Upright math operators, as in CLRS: max(a, b), lg n, x mod y. Only when used as one
// (`max = A[1]` is the variable *max*).
const MATH_FUNCTIONS = new Set(['max', 'min', 'gcd', 'lcm', 'exp', 'sin', 'cos', 'lg', 'log', 'ln']);
const PREFIX_OPERATORS = new Set(['lg', 'log', 'ln']);

/** CLRS constants (NIL, TRUE, FALSE, OVERFLOW) are small caps: `\textsc{nil}`. */
const constantTex = (word) => `\\textsc{${word.toLowerCase()}}`;

/**
 * Builder typesetting rules for a math fragment, following CLRS: multi-letter
 * identifiers italic (*key*, *heap-size*), words of a phrase upright
 * ("exchange A[i] with A[j]"), constants and booleans in small caps, digits
 * after a letter as subscripts, ASCII operators as TeX. Font groups already
 * present are kept.
 */
/** Text before a word ends in a word, variable or closing bracket, then spaces. */
function endsWithPhraseWord(before) {
  const tail = before.match(/(?:[A-Za-z0-9]|[)\]”"']|\u0001)\s+$/);
  if (!tail) return false;
  return !(/[A-Za-z0-9]/.test(tail[0][0]) && inCommand(before, tail.index));
}

function normalizeExpr(expr) {
  const out = PS.maskFontGroups(expr, (masked) => {
    const words = masked
      .replace(/([A-Za-z])_\{(\d+)\}/g, subscript)
      .replace(/([A-Za-z])_?(\d+)/g, subscript)
      .replace(/([A-Za-z])-([A-Za-z])/g, '$1\\text{-}$2')
      .replace(/\b[A-Za-z]{2,}\b/g, (word, offset, text) => {
        if (text[offset - 1] === '\\') return word;
        const before = text.slice(0, offset);
        const after = text.slice(offset + word.length);
        if (/^[A-Z]{2,}$/.test(word) || /^(true|false)$/i.test(word)) return constantTex(word);
        if (KEYWORD_WORDS.has(word)) return word;
        if (word === 'mod') return '\\bmod';
        if (MATH_FUNCTIONS.has(word)
          && (/^\s*\(/.test(after) || (PREFIX_OPERATORS.has(word) && /^\s+[A-Za-z0-9\\]/.test(after)))) {
          return `\\${word}`;
        }
        // A word spaced off from a neighbouring word or variable is part of a phrase.
        const phrase = /^\s+(?:[A-Za-z0-9(“"']|\u0000)/.test(after)
          || endsWithPhraseWord(before);
        return phrase ? `\\mathrm{${word}}` : `\\mathit{${word}}`;
      });
    return PS.texOperators(words);
  });
  // Math mode drops spaces: "exchange A[i] with A[j]" needs explicit gaps.
  return out
    .replace(SPACE_AFTER_WORD, '$1\\ ')
    .replace(SPACE_BEFORE_WORD, (match, last, offset, text) => (inCommand(text, offset) ? match : `${last}\\ `))
    .replace(/\s+/g, ' ')
    .trim();
}

/** Turn a plain builder expression into a LaTeX math fragment (with $...$). */
function toMath(raw) {
  let expr = String(raw == null ? '' : raw).trim();
  if (isSingleMath(expr)) expr = expr.slice(1, -1).trim();
  if (!expr) return '';
  // CJK prose must stay outside math mode.
  if (/[一-鿿]/.test(expr)) return expr;
  if (expr.includes('\\')) return `$${normalizeExpr(expr)}$`;
  return inlineWithCalls(expr, normalizeExpr) || `$${normalizeExpr(expr)}$`;
}

/**
 * Serialize one field. `isMath === false` marks text that was prose in the
 * source (`\State Initialize the array`): it stays prose instead of being
 * turned into math. Text already carrying `$...$` keeps its structure.
 */
function mathOrRaw(text, isMath) {
  const value = String(text == null ? '' : text);
  if (!value) return '';
  if (!value.includes('$')) {
    if (isMath !== false) return toMath(value);
    return value.includes('\\') ? PS.texOperators(value, false).replace(/[ \t]{2,}/g, ' ') : value;
  }
  return value
    .replace(/\$([^$]+)\$/g, (all, inner) =>
      `$${normalizeExpr(inner)}$`)
    .replace(/[ \t]{2,}/g, ' ');
}

PS.toMath = toMath;
PS.normalizeExpr = normalizeExpr;
PS.mathOrRaw = mathOrRaw;

const commentSuffix = (comment) => (comment ? ` \\Comment{${comment}}` : '');
const field = (node, key) => mathOrRaw(node[key], node[`${key}Math`]);

// CLRS: `=` assigns, `==` tests. A single `=` in a condition is written as `==`.
const asComparison = (tex) => tex.replace(/=(?!=)/g, (match, offset, text) => (precededBy(text, offset, /[<>=!:\\]/) ? match : '=='));
PS.asComparison = asComparison;
const condition = (node, key) => field(node, key).replace(/\$([^$]*)\$/g, (all, inner) => `$${asComparison(inner)}$`);

/** `v in S` → `$v \\in S$`; a head written with text commands stays as written. */
function forAllHead(init) {
  if (!init || /\\text(?:tt|rm|sf|up)?\{|\$/.test(init)) return init;
  const parts = init.split(/\s+(?:in|\\in)\s+/);
  if (parts.length === 2) return `$${normalizeExpr(parts[0])} \\in ${normalizeExpr(parts[1])}$`;
  return toMath(init);
}

function emitNodes(nodes, depth, out) {
  const pad = '  '.repeat(depth);
  const line = (text, comment) => out.push(`${pad}${text}${commentSuffix(comment)}`);
  const body = (list) => emitNodes(list, depth + 1, out);

  for (const node of nodes) {
    switch (node.type) {
      case 'state':
      {
        // A comment-only line is `\State \Comment{...}`; `\text{}` only keeps an empty one alive.
        const text = field(node, 'text');
        line(text ? `\\State ${text}` : node.comment ? '\\State' : '\\State \\text{}', node.comment);
      }
        break;
      case 'call':
        line(`\\State \\Call{${node.name || ''}}{${field(node, 'args')}}`, node.comment);
        break;
      case 'require':
      case 'ensure':
        line(`\\${node.type === 'require' ? 'Require' : 'Ensure'} ${field(node, 'text')}`, node.comment);
        break;
      case 'return':
        line(`\\Return${node.text ? ` ${field(node, 'text')}` : ''}`, node.comment);
        break;
      case 'print':
        line(`\\Print ${field(node, 'text')}`, node.comment);
        break;
      case 'break':
        line('\\Break', node.comment);
        break;
      case 'continue':
        line('\\Continue', node.comment);
        break;
      case 'comment':
        line(`\\Comment{${node.text || ''}}`);
        break;
      case 'if':
        node.branches.forEach((branch, index) => {
          line(`${index === 0 ? '\\If' : '\\Elif'}{${condition(branch, 'cond')}}`, index === 0 ? node.comment : branch.comment);
          body(branch.body);
        });
        if (node.elseBody) {
          line('\\Else', node.elseComment);
          body(node.elseBody);
        }
        line('\\EndIf');
        break;
      case 'while':
        line(`\\While{${condition(node, 'cond')}}`, node.comment);
        body(node.body);
        line('\\EndWhile');
        break;
      case 'for': {
        const head = node.all
          ? forAllHead(node.init || '')
          : node.bound
            ? `${field(node, 'init')} ${node.downto ? '\\DownTo' : '\\To'} ${field(node, 'bound')}`
            : field(node, 'init');
        line(`\\${node.all ? 'ForAll' : 'For'}{${head}}`, node.comment);
        body(node.body);
        line('\\EndFor');
        break;
      }
      case 'repeat':
        line('\\Repeat', node.comment);
        body(node.body);
        line(`\\Until{${condition(node, 'until')}}`, node.untilComment);
        break;
      case 'function': {
        const kind = node.kind === 'Procedure' ? 'Procedure' : 'Function';
        line(`\\${kind}{${node.name || ''}}{${field(node, 'args')}}`, node.comment);
        body(node.body);
        line(`\\End${kind}`);
        break;
      }
      default:
        line(node.text || '', node.comment);
    }
  }
}

PS.serializeLatex = function serializeLatex(model) {
  const out = ['\\begin{algorithm}'];
  if (model.caption) out.push(`\\caption{${model.caption}}`);
  out.push('\\begin{algorithmic}');
  emitNodes(model.nodes, 1, out);
  out.push('\\end{algorithmic}');
  out.push('\\end{algorithm}');
  return out.join('\n');
};

/* ------------------------------------------------------------------ */
/* Typed lines: builder shortcuts and plain-text paste                 */
/* ------------------------------------------------------------------ */

/*
 * A line of pseudocode as people type it (`if i > 0 and A[i] > key`,
 * `for j = 2 to n do`, `else:`, `} else {`, `def foo(a):`) → what it stands
 * for: `{ kind, fields, cut }`, where `cut` is how many leading characters the
 * keyword took. Null for an ordinary statement.
 *
 * `final` is for a finished line (Enter, paste). While typing (`final` false) a
 * keyword only counts once a space follows it (`if ` but not `iffy`), and
 * `else` waits until it cannot be the start of `else if`.
 */
const hasCjkText = (value) => /[一-鿿]/.test(String(value || ''));
const UNICODE_OPERATORS = [[/≠/g, '!='], [/≤/g, '<='], [/≥/g, '>='], [/−/g, '-'], [/[‥]/g, '..']];

/** Strip what other pseudocode dialects put around a condition: then / do / : / { / (...). */
function cleanCondition(raw) {
  let value = String(raw || '').trim()
    .replace(/\s*\{\s*$/, '')
    .replace(/\s*:\s*$/, '')
    .replace(/\s+(?:then|do)\s*$/i, '')
    .trim();
  // One pair of parentheses around the whole condition (C style).
  if (/^\(.*\)$/.test(value)) {
    let depth = 0;
    let wraps = true;
    for (let i = 0; i < value.length; i++) {
      if (value[i] === '(') depth++;
      else if (value[i] === ')' && --depth === 0 && i < value.length - 1) wraps = false;
    }
    if (wraps) value = value.slice(1, -1).trim();
  }
  return value;
}
PS.cleanCondition = cleanCondition;

/** `i = 1 to n` → init / bound / downto; `v in S` (or ∈) → a for-each head. */
function splitForHead(rest) {
  const head = cleanCondition(rest);
  const each = head.match(/^(?:each|all)\s+(.*)$/i);
  if (each) return { kind: 'forall', fields: { init: each[1].replace(/\s*∈\s*/, ' in ') } };
  if (/^[^\s=]+\s+(?:in|∈)\s/.test(head)) return { kind: 'forall', fields: { init: head.replace(/\s*∈\s*/, ' in ') } };
  const range = head.match(/^(.*?)\s+(to|downto|down\s+to)(?:\s+(.*))?$/i);
  if (range) return { kind: 'for', fields: { init: range[1], bound: range[3] || '', downto: !/^to$/i.test(range[2]), split: true } };
  return { kind: 'for', fields: { init: head, bound: '', downto: false } };
}
PS.splitForHead = splitForHead;

/** `Max-Heapify(A, i)` → name and args; a bare name keeps empty args. */
function splitSignature(rest) {
  const value = String(rest || '').trim().replace(/\s*[:{]\s*$/, '');
  const match = value.match(/^([^(]*)\((.*?)\)?$/);
  return match ? { name: match[1].trim(), args: match[2].trim() } : { name: value, args: '' };
}
PS.splitSignature = splitSignature;

const END_LINE = /^(?:end(?:\s*(?:if|while|for|foreach|procedure|function|algorithm|repeat|loop))?|endif|endwhile|endfor|fi|od|done|\})\s*;?$/i;

PS.typedLine = function typedLine(raw, options = {}) {
  const final = !!options.final;
  const text = String(raw == null ? '' : raw);
  const value = text.replace(/^\s+/, '');
  const lead = text.length - value.length;
  const make = (kind, fields, rest) => ({ kind, fields: fields || {}, cut: text.length - String(rest == null ? '' : rest).length });
  let m;

  // Comment line: `// note`, `▷ note` (CLRS 2e), `# note`.
  if ((m = value.match(/^(?:\/\/|▷|#(?=\s|$))\s?(.*)$/))) return make('comment', { text: m[1] }, m[1]);
  if (final && END_LINE.test(value)) return make('end', {}, '');

  // `} else {`, `} else if (x) {`: a closing brace in front of else is noise.
  const body = value.replace(/^\}\s*(?=else\b)/i, '');
  const shift = lead + value.length - body.length;
  const keyword = (pattern) => body.match(pattern);
  const restAt = (match, group) => {
    const rest = match[group];
    return rest == null ? null : rest;
  };

  if ((m = keyword(/^(?:else\s*if|elseif|elif|elsif)(?:\s+([\s\S]*))?$/i))) {
    const rest = restAt(m, 1);
    if (rest == null && !final) return null;
    return { kind: 'elseif', fields: { cond: final ? cleanCondition(rest || '') : (rest || '') }, cut: shift + body.length - (rest || '').length };
  }
  if ((m = keyword(/^else\s*:?\s*\{?(?:\s+([\s\S]*))?$/i)) || (final && (m = keyword(/^else\s*[:{]?\s*$/i)))) {
    const rest = restAt(m, 1) || '';
    // While typing, `else`, `else i` and `else if` may still become `else if`.
    if (!final && (rest === '' || /^(?:i|if)$/i.test(rest))) return null;
    return { kind: 'else', fields: { rest: final ? rest.trim() : rest }, cut: shift + body.length - rest.length };
  }

  const simple = [
    ['if', /^if(?:\s+([\s\S]*))?$/i],
    ['while', /^while(?:\s+([\s\S]*))?$/i],
    ['until', /^until(?:\s+([\s\S]*))?$/i],
  ];
  for (const [kind, pattern] of simple) {
    if ((m = value.match(pattern))) {
      const rest = restAt(m, 1);
      if (rest == null && !final) return null;
      return make(kind, { cond: final ? cleanCondition(rest || '') : (rest || '') }, rest);
    }
  }

  if ((m = value.match(/^(?:for\s*each|foreach|for\s+all)(?:\s+([\s\S]*))?$/i))) {
    const rest = restAt(m, 1);
    if (rest == null && !final) return null;
    return make('forall', { init: cleanCondition(rest || '').replace(/\s*∈\s*/, ' in ') }, rest);
  }
  if ((m = value.match(/^for(?:\s+([\s\S]*))?$/i))) {
    const rest = restAt(m, 1);
    if (rest == null && !final) return null;
    const head = splitForHead(rest || '');
    // While typing, `for i = 1 t` is not split yet (it may become `total`): only a whole
    // ` to ` / ` downto ` followed by a space splits the head.
    if (!final && head.kind === 'for' && !/\s(?:to|downto)\s/i.test(rest || '')) {
      return make('for', { init: rest || '', bound: '', downto: false }, rest);
    }
    return make(head.kind, head.fields, rest);
  }

  if ((m = value.match(/^repeat(?:\s*[:{])?(?:(\s+)([\s\S]*))?$/i))) {
    if (m[1] == null && !final) return null;
    const rest = m[2] || '';
    return make('repeat', { rest: final ? rest.trim() : rest }, rest);
  }
  if ((m = value.match(/^(return|print)(?:\s+([\s\S]*))?$/i))) {
    const rest = restAt(m, 2);
    if (rest == null && !final) return null;
    if (m[1].toLowerCase() === 'print' && rest == null) return null;
    return make(m[1].toLowerCase(), { text: final ? (rest || '').trim().replace(/;$/, '') : (rest || '') }, rest);
  }
  if ((m = value.match(/^(break|continue)(\s*;?\s*)$/i))) {
    if (!final && !m[2]) return null;
    return make(m[1].toLowerCase(), {}, '');
  }
  if ((m = value.match(/^(procedure|function|algorithm|def)(?:\s+([\s\S]*))?$/i))) {
    const rest = restAt(m, 2);
    if (rest == null && !final) return null;
    const kind = /^function$/i.test(m[1]) ? 'Function' : 'Procedure';
    return make('function', Object.assign({ kind }, splitSignature(rest || '')), rest);
  }
  if ((m = value.match(/^(require|ensure|input|output)s?(?:\s*:\s*|\s+)([\s\S]*)$/i))) {
    const kind = /^(require|input)/i.test(m[1]) ? 'require' : 'ensure';
    return make(kind, { text: m[2] }, m[2]);
  }
  return null;
};

/** A new node for a typed line (not else / else if / until / end, which attach to others). */
PS.nodeFromTyped = function nodeFromTyped(typed) {
  const f = typed.fields;
  const math = (key, value) => ({ [key]: PS.normalizeOperators(value || ''), [`${key}Math`]: !hasCjkText(value) });
  switch (typed.kind) {
    case 'if': return PS.node('if', { branches: [Object.assign({ body: [] }, math('cond', f.cond))], elseBody: null });
    case 'while': return PS.node('while', Object.assign({ body: [] }, math('cond', f.cond)));
    case 'for': return PS.node('for', Object.assign({ downto: !!f.downto, body: [] }, math('init', f.init), math('bound', f.bound)));
    case 'forall': return PS.node('for', Object.assign({ all: true, bound: '', downto: false, body: [] }, math('init', f.init)));
    case 'repeat': return PS.node('repeat', { body: [], until: '' });
    case 'return':
    case 'print':
    case 'require':
    case 'ensure': return PS.node(typed.kind, math('text', f.text));
    case 'break':
    case 'continue': return PS.node(typed.kind);
    // A typed `// note` line is its own (numbered) line, `\State \Comment{note}`.
    case 'comment': return PS.node('state', { text: '', textMath: true, comment: f.text || '' });
    case 'function': return PS.node('function', Object.assign({ kind: f.kind || 'Procedure', name: f.name || '', body: [] }, math('args', f.args)));
    default: return null;
  }
};

/** A plain statement node. */
PS.statementNode = (text) => PS.node('state', { text: PS.normalizeOperators(text || ''), textMath: !hasCjkText(text) });

/* ---- pasted plain text → nodes ---- */

const CALL_SHAPED = /^([A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*)\s*\((.*)\)\s*:?\s*$/;

/** `MAX-HEAPIFY` (as copied from CLRS) → `Max-Heapify`; acronyms (BFS, DFS-Visit, RB-Insert) stay. */
const ACRONYMS = new Set(['BFS', 'DFS', 'RB', 'BST', 'LCS', 'LCA', 'MST', 'SCC', 'KMP', 'FFT', 'GCD', 'CRT', 'OS', 'LU', 'LUP']);
const titleName = (name) => name.split('-').map((part) => (
  /^[A-Z][A-Z0-9]+$/.test(part) && !ACRONYMS.has(part) && /[A-Z]{2}/.test(part) ? part[0] + part.slice(1).toLowerCase() : part
)).join('-');

/** `x = y // note` → text and comment (also ▷ and ` # `), outside quotes. */
function splitTrailingComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) { if (ch === quote || (quote === '“' && ch === '”')) quote = null; continue; }
    if (ch === '"' || ch === '“') { quote = ch; continue; }
    const rest = line.slice(i);
    if (i > 0 && /\s/.test(line[i - 1]) && /^(?:\/\/|▷|#(?=\s))/.test(rest)) {
      return { text: line.slice(0, i).trimEnd(), comment: rest.replace(/^(?:\/\/|▷|#)\s?/, '') };
    }
  }
  return { text: line, comment: null };
}

/**
 * Plain pseudocode → nodes. Structure comes from indentation (Python, CLRS
 * copied with its layout) or, when the text has closing lines (`end if`,
 * `}`), from those. Line numbers (`1 for ...`, `2. x = 1`) are dropped.
 */
PS.parsePlain = function parsePlain(source) {
  const raw = String(source == null ? '' : source).replace(/\r\n?/g, '\n').split('\n')
    .map((line) => line.replace(/\t/g, '    ').replace(/\s+$/, ''))
    .filter((line) => line.trim());
  const numberedCount = raw.filter((line) => /^\s*\d+[.:)]?\s/.test(line)).length;
  const dropNumbers = numberedCount >= 2 && numberedCount >= raw.length / 2;
  const items = raw.map((line) => {
    const number = dropNumbers ? line.match(/^\s*\d+[.:)]?\s+/) : null;
    const start = number ? number[0].length : line.match(/^\s*/)[0].length;
    let text = applyAll(line.slice(start), UNICODE_OPERATORS);
    const split = splitTrailingComment(text);
    text = split.text.replace(/\s*;\s*$/, '');
    // Procedure names copied in capitals: INSERTION-SORT(A) → Insertion-Sort(A).
    text = text.replace(/\b([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*)(?=\s*\()/g, (name) => ((name.match(/[A-Z]/g) || []).length >= 4 ? titleName(name) : name));
    return { indent: start, text, comment: split.comment, numbered: !!number };
  });
  const explicit = items.some((item) => END_LINE.test(item.text.trim()) || /^\}\s*else\b/i.test(item.text.trim()));

  const nodes = [];
  // Open blocks: the list new lines go into, the node owning it, and its indent.
  const stack = [{ list: nodes, owner: null, indent: -1 }];
  const top = () => stack[stack.length - 1];
  const lastIn = (list) => list[list.length - 1];
  const withComment = (node, comment) => { if (comment != null) node.comment = comment; return node; };

  items.forEach((item, index) => {
    const text = item.text.trim();
    if (!explicit) while (stack.length > 1 && top().indent >= item.indent) stack.pop();
    const typed = PS.typedLine(text, { final: true });
    const next = items[index + 1];

    // Procedure header: keyword, or a call-shaped line that heads a body
    // (unnumbered among numbered lines, ends with ':', or has indented lines below).
    const shaped = !typed && text.match(CALL_SHAPED);
    const header = (typed && typed.kind === 'function') ? typed.fields
      : shaped && stack.length === 1 && ((dropNumbers && !item.numbered) || /:\s*$/.test(text)
        || (!explicit && next && next.indent > item.indent && !dropNumbers))
        ? { kind: 'Procedure', name: titleName(shaped[1]), args: shaped[2] } : null;
    if (header) {
      while (stack.length > 1) stack.pop();
      const node = withComment(PS.nodeFromTyped({ kind: 'function', fields: header }), item.comment);
      nodes.push(node);
      // Its body: everything below, even when copied without indentation.
      const indent = next ? Math.min(item.indent, next.indent - 1) : item.indent;
      stack.push({ list: node.body, owner: node, indent });
      return;
    }

    if (typed && (typed.kind === 'else' || typed.kind === 'elseif')) {
      let ifNode = null;
      if (explicit) {
        if (top().owner && top().owner.type === 'if') { ifNode = top().owner; stack.pop(); }
      } else if (lastIn(top().list) && lastIn(top().list).type === 'if') {
        ifNode = lastIn(top().list);
      }
      if (ifNode && !ifNode.elseBody) {
        let list;
        if (typed.kind === 'else') {
          ifNode.elseBody = [];
          if (item.comment != null) ifNode.elseComment = item.comment;
          list = ifNode.elseBody;
          if (typed.fields.rest) list.push(PS.statementNode(typed.fields.rest));
        } else {
          const branch = { cond: PS.normalizeOperators(typed.fields.cond), condMath: !hasCjkText(typed.fields.cond), body: [] };
          if (item.comment != null) branch.comment = item.comment;
          ifNode.branches.push(branch);
          list = branch.body;
        }
        stack.push({ list, owner: ifNode, indent: item.indent });
        return;
      }
    }
    if (typed && typed.kind === 'until') {
      const repeat = explicit ? top().owner : lastIn(top().list);
      if (repeat && repeat.type === 'repeat') {
        repeat.until = PS.normalizeOperators(typed.fields.cond);
        repeat.untilMath = !hasCjkText(typed.fields.cond);
        if (item.comment != null) repeat.untilComment = item.comment;
        if (explicit && top().owner === repeat) stack.pop();
        return;
      }
    }
    if (typed && typed.kind === 'end') {
      if (explicit && stack.length > 1) stack.pop();
      return;
    }

    const node = typed ? PS.nodeFromTyped(typed) : null;
    if (!node) {
      top().list.push(withComment(PS.statementNode(text), item.comment));
      return;
    }
    if (node.type === 'if') {
      if (item.comment != null) node.comment = item.comment;
    } else if (typed.kind !== 'comment') withComment(node, item.comment);
    top().list.push(node);
    if (node.type === 'repeat' && typed.fields.rest) node.body.push(PS.statementNode(typed.fields.rest));
    if (PS.isContainer(node)) {
      stack.push({ list: node.type === 'if' ? node.branches[0].body : node.body, owner: node, indent: item.indent });
    }
  });
  return nodes;
};

/** Clipboard text → `{ nodes, caption }`: LaTeX (algorithmic) or plain pseudocode. */
PS.parsePasted = function parsePasted(text) {
  const source = String(text == null ? '' : text);
  if (/\\(?:State|If|ElsIf|Elif|ElseIf|While|For|ForAll|Repeat|Procedure|Function|Return|begin\{algorithmic\})\b/.test(source)) {
    const model = PS.parseLatex(source);
    return { nodes: model.nodes, caption: model.caption || '', latex: true };
  }
  return { nodes: PS.parsePlain(source), caption: '', latex: false };
};

/*
 * Pseudocode Suite — flat renderer.
 * Turns the AST into the CLRS-looking DOM directly; no post-processing pass.
 */

((PS) => {

  const FONT_COMMANDS = {
    textbf: 'strong',
    textit: 'em',
    texttt: 'code',
    textrm: 'span',
    textsf: 'span',
    textup: 'span',
    textsc: 'span',
    textnormal: 'span',
    mathrm: 'span',
    mathit: 'em',
    mathbf: 'strong',
  };

  const SYMBOLS = {
    gets: '=',
    le: '≤',
    ge: '≥',
    ne: '≠',
    ldots: '…',
    cdots: '⋯',
    times: '×',
    pm: '±',
    infty: '∞',
    to: '→',
    DownTo: '↓',
    And: '∧',
    Or: '∨',
    Not: '¬',
    lfloor: '⌊',
    rfloor: '⌋',
    lceil: '⌈',
    rceil: '⌉',
    quad: ' ',
    qquad: ' ',
  };

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  // In a condition a single `=` is a comparison and shows as `==`.
  const asComparison = (tex) => PS.asComparison(tex);

  /** A field value → inline source for parseInline (math wrapped in $...$). */
  const expr = (value, isMath, comparison) => {
    const text = String(value == null ? '' : value);
    if (!text) return '';
    if (isMath && !text.includes('$')) {
      // Constants and booleans are text, not a product of variables.
      if (/^[A-Z]{2,}[A-Z0-9_-]*$/.test(text) || /^(true|false)$/i.test(text)) return `\\textsc{${text.toLowerCase()}}`;
      const math = (segment) => {
        const tex = PS.normalizeExpr(segment);
        return comparison ? asComparison(tex) : tex;
      };
      const plain = PS.normalizeOperators(text);
      // Merge-Sort(A, p, r) inside an expression renders like \Call.
      return PS.inlineWithCalls(plain, math) || `$${math(plain)}$`;
    }
    // Conditions mixing text and math ($a = b$ and $c$): `=` still means `==`.
    if (comparison) return text.replace(/\$([^$]*)\$/g, (all, inner) => `$${asComparison(inner)}$`);
    return text;
  };

  /*
   * CLRS sets constants (NIL, TRUE, FALSE) in small caps. MathJax has no \textsc,
   * so they leave the formula and render like procedure names. An operator left
   * at the cut gets an empty group so TeX still spaces it as an operator.
   */
  const CONSTANT_TEX = /\\textsc\{([A-Za-z]+)\}|\\(?:text|textrm|textup|textsf|mathrm|mathsf)\{([A-Z][A-Z0-9]+)\}/g;
  const EDGE_OP = String.raw`(?:[=<>+\-*,;:]|\\(?:ne|neq|le|leq|ge|geq|to|in|notin|gets|subset|subseteq|supset|supseteq|approx|equiv|sim|mapsto|pm|mp|cdot|times|div|land|lor|wedge|vee|cup|cap|setminus|circ|oplus|otimes)(?![A-Za-z]))`;
  const ENDS_WITH_OP = new RegExp(`${EDGE_OP}\\s*$`);
  // CLRS's narrow test-for-equality sign (clrscode3e \isequal); styled by .ps-eq.
  const IS_EQUAL = String.raw`\mathrel{\class{ps-eq}{=}\mkern1.8mu\class{ps-eq}{=}}`;
  // CLRS assignment (clrscode \gets): `=` with 1pt more room on each side. Code only;
  // in comments `=` is equality.
  const GETS = String.raw`\mathrel{\mkern1.8mu{=}\mkern1.8mu}`;
  const STARTS_WITH_OP = new RegExp(`^\\s*${EDGE_OP}`);

  function splitConstants(tex, prose) {
    const tokens = [];
    let last = 0;
    let previousConstant = false;
    const pushMath = (piece, nextConstant) => {
      let value = piece.trim();
      if (!value) return;
      if (previousConstant && STARTS_WITH_OP.test(value)) value = `{}${value}`;
      if (nextConstant && ENDS_WITH_OP.test(value)) value = `${value}{}`;
      // (No lookbehind: iOS before 16.4 cannot parse it.)
      if (!prose) value = value.replace(/=(?![=}])/g, (match, offset, text) => (/[=<>!:{]/.test(text[offset - 1] || '') ? match : GETS));
      tokens.push({ type: 'math', value: value.replace(/==(?!=)/g, (match, offset, text) => (/[=<>!]/.test(text[offset - 1] || '') ? match : IS_EQUAL)) });
    };
    CONSTANT_TEX.lastIndex = 0;
    for (let match; (match = CONSTANT_TEX.exec(tex));) {
      pushMath(tex.slice(last, match.index), true);
      // \textsc{...} as written (\textsc{Evaluate} keeps its capital); legacy \text{NIL} → nil.
      tokens.push({ type: 'constant', value: match[1] || match[2].toLowerCase() });
      previousConstant = true;
      last = match.index + match[0].length;
    }
    pushMath(tex.slice(last), false);
    return tokens;
  }

  function skipSpace(text, index) {
    let i = index;
    while (i < text.length && /\s/.test(text[i])) i++;
    return i;
  }

  /** `$...$` from the source → TeX for MathJax. */
  function normalizeMath(source, prose) {
    const tex = PS.maskFontGroups(source, (masked) => PS.texOperators(PS.normalizeOperators(masked))
      .replace(/\\To\b/g, '\\to')
      .replace(/\\DownTo\b/g, '\\downarrow'))
      .replace(/\\textbf\{([^{}]*)\}/g, '\\mathbf{$1}')
      .replace(/\\textit\{([^{}]*)\}/g, '\\mathit{$1}');
    // Comments are prose: `$ab$` there is a product, not an identifier.
    // MathJax spaces a bare `.` as punctuation (`x. key`); in TeX and CLRS the attribute
    // dot is ordinary, so it goes in a group: `x{.}\mathit{key}`. Decimals are left alone.
    return (prose ? tex : PS.normalizeExpr(tex))
      .replace(/([A-Za-z0-9}\])])\.(?=\s*(?:[A-Za-z]|\\(?:math|text)))/g, '$1{.}')
      // clrscode's \twodots: the range dots of A[1 . . n].
      .replace(/\\twodots\b\s*/g, '\\mathinner{\\ldotp\\ldotp}')
      .trim();
  }

  /**
   * Split a line into tokens that can be rendered: plain text, math, styled
   * text, calls and keyword/function markers.
   */
  function parseInline(source, prose) {
    const text = String(source == null ? '' : source);
    const tokens = [];
    let buffer = '';
    const flush = () => {
      if (!buffer) return;
      tokens.push({ type: 'text', value: buffer });
      buffer = '';
    };
    const group = (at) => PS.readGroup(text, skipSpace(text, at));

    let i = 0;
    while (i < text.length) {
      const ch = text[i];

      if (ch === '$') {
        let j = i + 1;
        while (j < text.length && text[j] !== '$') j += text[j] === '\\' ? 2 : 1;
        if (j < text.length) {
          flush();
          tokens.push(...splitConstants(normalizeMath(text.slice(i + 1, j), prose), prose));
          i = j + 1;
          continue;
        }
      }

      if (ch === '\\') {
        const command = text.slice(i).match(/^\\([A-Za-z]+)/);
        if (!command) {
          // Escaped character (\{, \_, \$, ...): show it literally.
          if (i + 1 < text.length) {
            buffer += text[i + 1];
            i += 2;
            continue;
          }
        } else {
          const name = command[1];
          const after = i + command[0].length;

          // Custom markers produced by the row builder.
          if (name === 'kw' || name === 'fn') {
            const value = group(after);
            if (value) {
              flush();
              tokens.push({ type: name === 'kw' ? 'keyword' : 'function', value: value.value });
              i = value.end;
              continue;
            }
          }

          if (name === 'Call') {
            const nameGroup = group(after);
            const argsGroup = nameGroup ? group(nameGroup.end) : null;
            if (nameGroup && argsGroup) {
              flush();
              tokens.push({ type: 'call', name: nameGroup.value, args: argsGroup.value });
              i = argsGroup.end;
              continue;
            }
          }

          if (name === 'textsc') {
            const value = group(after);
            if (value) {
              flush();
              tokens.push({ type: 'constant', value: value.value });
              i = value.end;
              continue;
            }
          }

          if (FONT_COMMANDS[name]) {
            const value = group(after);
            if (value) {
              flush();
              tokens.push({ type: 'styled', tag: FONT_COMMANDS[name], value: value.value });
              i = value.end;
              continue;
            }
          }

          // Known symbols render as Unicode; unknown commands stay visible
          // minus the backslash.
          buffer += SYMBOLS[name] != null ? SYMBOLS[name] : name;
          i = after;
          continue;
        }
      }

      buffer += ch;
      i++;
    }

    flush();
    return tokens;
  }

  /*
   * A math run cut off by a call (`\Call{Max}{$i$} $+ T(n)$`) starts or ends with a binary
   * operator, which TeX would demote to unary and set tight. An empty group on that side keeps
   * it binary; the space typed between call and math is then dropped so the gap is TeX's own.
   */
  const BIN_OP = String.raw`(?:[+\-*]|\\(?:pm|mp|cdot|times|div|land|lor|wedge|vee|cup|cap|setminus|circ|oplus|otimes)(?![A-Za-z]))`;
  const LEADING_BIN = new RegExp(`^\\s*${BIN_OP}`);
  const TRAILING_BIN = new RegExp(`${BIN_OP}\\s*$`);
  const isCallToken = (token) => token && (token.type === 'call' || token.type === 'function' || token.type === 'constant');
  const isBlank = (token) => token && token.type === 'text' && !token.value.trim();

  function bridgeOperators(tokens) {
    const out = tokens.slice();
    for (let i = 0; i < out.length; i++) {
      const token = out[i];
      if (token.type !== 'math') continue;
      let value = token.value;
      const before = isBlank(out[i - 1]) ? i - 2 : i - 1;
      if (isCallToken(out[before]) && LEADING_BIN.test(value)) {
        value = `{}${value}`;
        if (before === i - 2) { out.splice(i - 1, 1); i -= 1; }
      }
      const after = isBlank(out[i + 1]) ? i + 2 : i + 1;
      if (isCallToken(out[after]) && TRAILING_BIN.test(value)) {
        value = `${value}{}`;
        if (after === i + 2) out.splice(i + 1, 1);
      }
      if (value !== token.value) out[i] = { ...token, value };
    }
    return out;
  }

  function renderInline(container, source, prose) {
    for (const token of bridgeOperators(parseInline(source, prose))) {
      switch (token.type) {
        case 'text':
          container.appendChild(document.createTextNode(token.value));
          break;
        case 'keyword':
          container.appendChild(el('span', 'ps-kw', token.value));
          break;
        case 'function':
          container.appendChild(el('span', 'ps-fn', token.value));
          break;
        case 'styled': {
          const wrapper = el(token.tag, token.tag === 'span' ? 'ps-styled' : null);
          renderInline(wrapper, token.value, prose);
          container.appendChild(wrapper);
          break;
        }
        case 'call':
          container.appendChild(el('span', 'ps-fn', token.name));
          container.appendChild(document.createTextNode('('));
          renderInline(container, token.args, prose);
          container.appendChild(document.createTextNode(')'));
          break;
        case 'constant':
          container.appendChild(el('span', 'ps-const', token.value));
          break;
        case 'math': {
          const wrapper = el('span', 'ps-math', token.value);
          wrapper.dataset.tex = token.value;
          container.appendChild(wrapper);
          break;
        }
        default:
          break;
      }
    }
  }

  /* ---------------- row building ---------------- */

  /** Inline source of a simple (non-container) statement, or null. */
  function simpleText(node) {
    switch (node.type) {
      case 'state': return expr(node.text, node.textMath);
      case 'call': return `\\Call{${node.name || ''}}{${expr(node.args, node.argsMath)}}`;
      case 'return': return `\\kw{return}${node.text ? ` ${expr(node.text, node.textMath)}` : ''}`;
      case 'print': return `\\kw{print} ${expr(node.text, node.textMath)}`;
      case 'break':
      case 'continue': return `\\kw{${node.type}}`;
      case 'raw': return expr(node.text, node.textMath);
      default: return null;
    }
  }

  const MERGEABLE = new Set(['state', 'call', 'return', 'print', 'break', 'continue']);

  function buildRows(nodes, depth, counter, rows) {
    const row = (text, comment, numbered = true, extra = {}) => rows.push(Object.assign({
      number: numbered ? ++counter.value : null,
      depth,
      text,
      comment: comment || null,
    }, extra));
    const body = (list) => buildRows(list || [], depth + 1, counter, rows);

    for (const node of nodes) {
      switch (node.type) {
        case 'function': {
          row(`\\fn{${node.name || ''}}(${expr(node.args, node.argsMath)})`, node.comment, false, { kind: 'function' });
          // Each procedure numbers its own lines from 1.
          const saved = counter.value;
          counter.value = 0;
          body(node.body);
          counter.value = saved;
          break;
        }

        case 'if': {
          node.branches.forEach((branch, index) => {
            const comment = index === 0 ? node.comment || branch.comment : branch.comment;
            row(`\\kw{${index === 0 ? 'if' : 'elseif'}} ${expr(branch.cond, branch.condMath, true)}`, comment);
            body(branch.body);
          });
          if (node.elseBody) {
            // CLRS: a plain first statement goes on the else line ("else x = x.right"),
            // the rest of the branch below it.
            const [first, ...rest] = node.elseBody;
            if (first && MERGEABLE.has(first.type) && !(first.comment && node.elseComment)) {
              row(`\\kw{else} ${simpleText(first)}`, node.elseComment || first.comment);
              body(rest);
            } else {
              row('\\kw{else}', node.elseComment);
              body(node.elseBody);
            }
          }
          break;
        }

        case 'while':
          row(`\\kw{while} ${expr(node.cond, node.condMath, true)}`, node.comment);
          body(node.body);
          break;

        case 'for': {
          let head;
          if (node.all) {
            // CLRS: "**for** each v ∈ G.V" (only "for" is bold). A head already written with text commands
            // (\texttt{child} of \texttt{u}) is prose; math mode would swallow its spaces.
            const parts = String(node.init || '').split(/\s+(?:in|\\in)\s+/);
            if (parts.length === 2) {
              const left = expr(parts[0], true);
              const right = expr(parts[1], true);
              const single = (value) => /^\$[^$]*\$$/.test(value);
              head = single(left) && single(right)
                ? `\\kw{for} each $${left.slice(1, -1)} \\in ${right.slice(1, -1)}$`
                : `\\kw{for} each ${left} $\\in$ ${right}`;
            } else {
              head = `\\kw{for} each ${expr(node.init, !/\\text(?:tt|rm|sf|up)?\{/.test(node.init || ''))}`;
            }
          } else {
            head = node.bound
              ? `\\kw{for} ${expr(node.init, node.initMath)} \\kw{${node.downto ? 'downto' : 'to'}} ${expr(node.bound, node.boundMath)}`
              : `\\kw{for} ${expr(node.init, node.initMath)}`;
          }
          row(head, node.comment);
          body(node.body);
          break;
        }

        case 'repeat':
          row('\\kw{repeat}', node.comment);
          body(node.body);
          row(`\\kw{until} ${expr(node.until, node.untilMath, true)}`, node.untilComment);
          break;

        case 'state':
          // CLRS numbers comment lines too.
          if (!node.text && node.comment) row('', node.comment, true, { note: true });
          else row(simpleText(node), node.comment);
          break;

        case 'require':
        case 'ensure':
          row(`\\kw{${node.type === 'require' ? 'Require' : 'Ensure'}:} ${expr(node.text, node.textMath)}`, node.comment, false);
          break;

        case 'comment': {
          const last = rows[rows.length - 1];
          if (last && !last.comment) last.comment = node.text || '';
          else row('', node.text || '', true, { note: true });
          break;
        }

        default:
          row(simpleText(node) || '', node.comment);
      }
    }
  }

  /* ---------------- public renderer ---------------- */

  /*
   * Math typesetting. Obsidian's renderMath() is synchronous; the slow part is
   * finishRenderMath() (~100 ms while MathJax refreshes its stylesheet), and a
   * block stays hidden until it is done. Rendered formulas are cached by TeX,
   * so re-renders (editing, mode switches, settings, the builder preview)
   * clone them instead and never wait.
   */
  const MATH_CACHE_LIMIT = 4000;
  const mathCache = new Map();
  let mathJaxReady = null;

  function cachedMath(tex) {
    const hit = mathCache.get(tex);
    if (!hit) return null;
    mathCache.delete(tex); // keep recently used entries last
    mathCache.set(tex, hit);
    return hit.cloneNode(true);
  }

  function rememberMath(tex, node) {
    mathCache.set(tex, node.cloneNode(true));
    if (mathCache.size > MATH_CACHE_LIMIT) mathCache.delete(mathCache.keys().next().value);
  }

  /** Same markup Obsidian puts around inline math in a note. */
  function mathElement(tex) {
    const wrapper = document.createElement('span');
    wrapper.className = 'math math-inline is-loaded';
    wrapper.appendChild(renderMath(tex, false));
    return wrapper;
  }

  /** Fallback: let a Markdown render do it. */
  async function typesetViaMarkdown(app, span, tex, sourcePath, component) {
    const holder = document.createElement('div');
    try {
      await MarkdownRenderer.render(app, `$${tex}$`, holder, sourcePath, component);
      const math = holder.querySelector('.math');
      if (!math) throw new Error('no math output');
      span.replaceChildren(math);
      rememberMath(tex, math);
    } catch (error) {
      span.classList.add('ps-math-error');
      span.textContent = `$${tex}$`;
    }
  }

  /** Typeset every `.ps-math` span under root. */
  PS.typesetMath = async function typesetMath(app, root, sourcePath, component) {
    const missing = [];
    root.querySelectorAll('.ps-math[data-tex]').forEach((span) => {
      const tex = span.dataset.tex;
      delete span.dataset.tex;
      const hit = cachedMath(tex);
      if (hit) span.replaceChildren(hit);
      else missing.push({ span, tex });
    });
    if (!missing.length) return;

    let failed = missing;
    if (typeof renderMath === 'function') {
      try {
        if (!mathJaxReady) mathJaxReady = typeof loadMathJax === 'function' ? loadMathJax() : Promise.resolve();
        await mathJaxReady;
        failed = missing.filter(({ span, tex }) => {
          try {
            span.replaceChildren(mathElement(tex));
            return false;
          } catch (error) {
            return true;
          }
        });
        await finishRenderMath();
        missing.forEach((item) => {
          if (!failed.includes(item)) rememberMath(item.tex, item.span.firstChild);
        });
      } catch (error) {
        mathJaxReady = null;
        failed = missing.filter(({ span }) => !span.querySelector('mjx-container'));
      }
    }
    await Promise.all(failed.map(({ span, tex }) => typesetViaMarkdown(app, span, tex, sourcePath, component)));
  };

  PS.buildRows = function buildRowsForModel(model) {
    const rows = [];
    buildRows(model.nodes || [], 0, { value: 0 }, rows);
    return rows;
  };

  /** AST → DOM. Math is left as `.ps-math` placeholders for PS.typesetMath. */
  PS.renderBlock = function renderBlock(model, options) {
    const settings = Object.assign({ lineNumbers: true, indentSize: '1.2em', commentDelimiter: '//' }, options || {});
    const block = el('div', 'ps-block');
    block.setCssProps({ '--ps-indent': settings.indentSize || '1.2em' });

    if (model.caption) {
      const title = el('div', 'ps-title');
      title.appendChild(el('span', 'ps-title-label', 'Algorithm'));
      const text = el('span', 'ps-title-text');
      renderInline(text, model.caption);
      title.appendChild(text);
      block.appendChild(title);
    }

    const grid = el('div', 'ps-grid');
    let commented = false;
    for (const row of PS.buildRows(model)) {
      const rowEl = el('div', 'ps-row');
      if (row.kind) rowEl.classList.add(`ps-row-${row.kind}`);
      rowEl.setCssProps({ '--ps-depth': String(row.depth) });
      rowEl.appendChild(el('span', 'ps-num', settings.lineNumbers && row.number != null ? String(row.number) : ''));
      // A comment-only line has no code cell: its comment starts at the code
      // column, at the line's indent, and runs to the right edge (CLRS).
      // A procedure header without a comment spans the comment column too, so a long
      // parameter list does not squeeze the comments of the lines below it.
      const span = row.kind === 'function' && !row.comment;
      if (!row.note) {
        const codeEl = el('span', span ? 'ps-code ps-span' : 'ps-code');
        renderInline(codeEl, row.text);
        rowEl.appendChild(codeEl);
      }
      if (span) {
        grid.appendChild(rowEl);
        continue;
      }
      const commentEl = el('span', row.note ? 'ps-comment ps-note' : 'ps-comment');
      if (row.comment) {
        commented = true;
        // clrscode \CommentSymbol: bold, tightly kerned slashes.
        commentEl.appendChild(el('span', 'ps-comment-mark', settings.commentDelimiter || '//'));
        commentEl.appendChild(document.createTextNode(' '));
        renderInline(commentEl, row.comment, true);
      }
      rowEl.appendChild(commentEl);
      grid.appendChild(rowEl);
    }

    if (commented) block.addClass('ps-commented');
    block.appendChild(grid);
    return block;
  };

  /** Render and typeset into `container`, revealing it once math is done. */
  PS.paint = async function paint(app, container, model, options, sourcePath, component) {
    const block = PS.renderBlock(model, options);
    block.addClass('ps-pending'); // hidden until the math is typeset
    container.appendChild(block);
    try {
      await PS.typesetMath(app, block, sourcePath, component);
    } finally {
      block.removeClass('ps-pending');
    }
    return block;
  };

  PS.renderInline = renderInline;
  PS.parseInline = parseInline;
  PS.bridgeOperators = bridgeOperators;
})(PS);

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
    this.registerEvent(this.app.workspace.on('editor-menu', (menu, editor, view) => {
      const fence = this.fenceAtCursor(editor);
      if (!fence) return;
      menu.addItem((item) => item
        .setTitle('Edit pseudocode block')
        .setIcon('square-pen')
        .onClick(() => this.openEditorFence(editor, fence, view)));
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
    const button = block.createEl('button', {
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

  /* ---------------- opening the builder ---------------- */

  openBuilder(model, sourcePath, onSave) {
    new PS.BuilderModal(this.app, {
      model, settings: this.settings, sourcePath, onSave, saveSettings: (patch) => this.saveSettingsOnly(patch),
    }).open();
  }

  /** Edit a block of a file on disk (reading view, live preview, embeds). */
  async openFileFence(path, source, hint) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      new Notice(`File not found: ${path}`);
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

