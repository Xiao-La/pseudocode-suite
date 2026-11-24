const { loadPS, collectBlocks, suite } = require('./harness');

const PS = loadPS();
const { ok, eq, done } = suite();

// ---- toMath ----
eq(PS.toMath('S1.top = 0'), '$S_1.\\mathit{top} = 0$', 'subscript + roman');
eq(PS.toMath('i == 0'), '$i == 0$', 'equality');
eq(PS.toMath('l <= A.heap-size and A[l] > A[largest]'), '$l \\le A.\\mathit{heap}\\text{-}\\mathit{size}$ and $A[l] > A[\\mathit{largest}]$', 'operators + hyphen');
eq(PS.toMath('OVERFLOW'), '$\\textsc{overflow}$', 'constant');
eq(PS.toMath('true'), '$\\textsc{true}$', 'boolean');
eq(PS.toMath(''), '', 'empty');

// ---- parse/serialize round trip on every pseudo block in the vaults ----
// The model must survive exactly, *Math flags included: a flag flip turns
// prose into math (or back) and changes the rendering.
const strip = (model) => JSON.parse(JSON.stringify(model, (key, value) => (key === 'id' ? undefined : value)));
const blocks = collectBlocks();
for (const block of blocks) {
  const name = `${block.file.split('/').pop()}#${blocks.indexOf(block)}`;
  let model;
  try { model = PS.parseLatex(block.source); } catch (error) { ok(false, `parse threw ${name}`, error.message); continue; }
  const latex = PS.serializeLatex(model);
  const model2 = PS.parseLatex(latex);
  eq(strip(model2), strip(model), `roundtrip ${name}`);
  eq(PS.buildRows(model2), PS.buildRows(model), `rows unchanged after save ${name}`);
  ok(PS.serializeLatex(model2) === latex, `serializer is idempotent ${name}`);
}
console.log(`checked ${blocks.length} blocks`);

// ---- edge cases ----
ok(PS.parseLatex('').nodes.length === 0, 'empty block');
eq(PS.parseLatex('\\caption{X}').caption, 'X', 'caption only');
const unknown = PS.parseLatex('\\Frobnicate{abc}');
ok(unknown.nodes[0].type === 'raw', 'unknown command kept as raw');
eq(unknown.nodes[0].text, '\\Frobnicate{abc}', 'raw text preserved');
const nested = PS.parseLatex('\\If{a}\n\\While{b}\n\\State c\n\\EndWhile\n\\EndIf');
ok(nested.nodes[0].type === 'if' && nested.nodes[0].branches[0].body[0].type === 'while', 'nested blocks');
const forall = PS.parseLatex('\\ForAll{\\texttt{x} in S}\\State y\\EndFor');
ok(forall.nodes[0].all === true, 'forall flag');
const commentOnly = PS.parseLatex('\\State \\Comment{hello}');
ok(commentOnly.nodes[0].type === 'state' && commentOnly.nodes[0].text === '' && commentOnly.nodes[0].comment === 'hello', 'comment-only state');
const callState = PS.parseLatex('\\State \\Call{Swap}{$A, i$}');
ok(callState.nodes[0].type === 'call' && callState.nodes[0].name === 'Swap', 'call statement');
const retState = PS.parseLatex('\\State \\Return $x$');
ok(retState.nodes[0].type === 'return' && retState.nodes[0].text === 'x', 'state-return shorthand');
const forDown = PS.parseLatex('\\For{$i = n$ \\DownTo $1$}\\State x\\EndFor');
ok(forDown.nodes[0].downto === true && forDown.nodes[0].bound === '1', 'downto for');

// multi-line \State (as written by hand in notes)
const multiline = PS.parseLatex('\\State $m \\gets \\left\\lfloor\n  (a+b)/2 \\right\\rfloor$');
ok(multiline.nodes.length === 1 && multiline.nodes[0].type === 'state', 'multi-line state joined');

// comments survive on control lines
const commented = PS.parseLatex('\\While{$x > 0$}\n\\State y\n\\EndWhile');
commented.nodes[0].comment = 'loop';
const regenerated = PS.serializeLatex(commented);
ok(regenerated.includes('\\While{$x > 0$} \\Comment{loop}'), 'control-line comment serialized');

// reorder (drag & drop)
const mk = (type, props) => PS.node(type, Object.assign({ text: '' }, props || {}));
const nodeA = mk('state', { text: 'a' });
const nodeB = mk('state', { text: 'b' });
const nodeC = mk('state', { text: 'c' });
const loop = PS.node('while', { cond: 'x', body: [nodeC] });
const roots = [nodeA, nodeB, loop];
ok(PS.reorder(roots, loop.id, nodeA.id, 'before') === true, 'reorder before');
ok(roots[0] === loop && roots[1] === nodeA && roots[2] === nodeB, 'reorder before order');
ok(PS.reorder(roots, nodeB.id, loop.id, 'inside') === true, 'reorder inside');
ok(PS.bodyOf(loop).some((node) => node.id === nodeB.id), 'reorder inside body');
ok(PS.reorder(roots, loop.id, nodeB.id, 'inside') === false, 'reorder refuses own descendant');
ok(PS.reorder(roots, nodeA.id, nodeA.id, 'after') === false, 'reorder refuses self');
ok(PS.reorder(roots, nodeA.id, nodeC.id, 'after') === true, 'reorder after nested node');
ok(PS.bodyOf(loop)[1].id === nodeA.id, 'reorder nested position');



// ---- trailing comments survive on every statement kind ----
const commentCases = {
  state: '\\State $x$ \\Comment{c}',
  call: '\\State \\Call{F}{$x$} \\Comment{c}',
  bareCall: '\\Call{F}{$x$} \\Comment{c}',
  return: '\\Return $x$ \\Comment{c}',
  print: '\\Print $x$ \\Comment{c}',
  break: '\\Break \\Comment{c}',
  continue: '\\Continue \\Comment{c}',
  stateBreak: '\\State \\Break \\Comment{c}',
  require: '\\Require $A$ \\Comment{c}',
  raw: '\\Frobnicate{abc} \\Comment{c}',
};
for (const [name, source] of Object.entries(commentCases)) {
  const model = PS.parseLatex(source);
  eq(model.nodes[0].comment, 'c', `comment parsed: ${name}`);
  ok(PS.serializeLatex(model).includes('\\Comment{c}'), `comment serialized: ${name}`);
  eq(PS.buildRows(model)[0].comment, 'c', `comment rendered: ${name}`);
}
const builderMade = { caption: '', nodes: ['break', 'continue', 'raw'].map((type) => PS.node(type, { text: type === 'raw' ? '\\Foo' : undefined, comment: 'k' })) };
eq((PS.serializeLatex(builderMade).match(/\\Comment\{k\}/g) || []).length, 3, 'builder comments on break/continue/raw saved');

const repeat = PS.parseLatex('\\Repeat \\Comment{head}\n\\State x\n\\Until{$x > 0$} \\Comment{tail}');
eq([repeat.nodes[0].comment, repeat.nodes[0].untilComment], ['head', 'tail'], 'repeat and until comments kept apart');
const repeatLatex = PS.serializeLatex(repeat);
eq((repeatLatex.match(/\\Comment\{head\}/g) || []).length, 1, 'repeat comment written once');
ok(repeatLatex.includes('\\Until{$x > 0$} \\Comment{tail}'), 'until comment written');
const repeatRows = PS.buildRows(repeat);
eq([repeatRows[0].comment, repeatRows[2].comment], ['head', 'tail'], 'repeat/until rows carry their comments');

const twoComments = PS.parseLatex('\\State x \\Comment{a}\n\\Comment{b}');
eq(PS.buildRows(twoComments).map((row) => row.comment), ['a', 'b'], 'second standalone comment gets its own row');

// ---- prose stays prose ----
eq(PS.serializeLatex(PS.parseLatex('\\State Initialize the array')).split('\n')[2], '  \\State Initialize the array', 'prose state saved verbatim');
eq(PS.serializeLatex(PS.parseLatex('\\State error “heap underflow”')).split('\n')[2], '  \\State error “heap underflow”', 'quoted prose saved verbatim');
eq(PS.mathOrRaw('x <= y', true), '$x \\le y$', 'math field becomes math');

// ---- word spacing inside math ----
eq(PS.toMath('exchange A[i] with A[j]'), '$\\mathrm{exchange}\\ A[i]\\ \\mathrm{with}\\ A[j]$', 'spaces kept around words');
eq(PS.toMath('Initialize the array'), '$\\mathrm{Initialize}\\ \\mathrm{the}\\ \\mathrm{array}$', 'prose typed in builder keeps spaces');
eq(PS.toMath('x = largest'), '$x = \\mathit{largest}$', 'no extra space around operators');
eq(PS.toMath('a and b'), '$a$ and $b$', 'logic words are roman words between math');
eq(PS.toMath('x = NIL'), '$x = \\textsc{nil}$', 'constant inside expression');

// ---- operators ----
eq(PS.normalizeOperators('a \\leq b \\land c \\gets d'), 'a <= b \\land c = d', 'aliases normalized, explicit \\land kept');
eq(PS.normalizeOperators('a && b || c'), 'a and b or c', '&& and || are the words');
eq(PS.texOperators('a <= b and not c'), 'a \\le  b \\text{ and } \\text{ not } c', 'ascii to tex, words stay roman words');
eq(PS.fromMath('$\\mathrm{\\text{x}}$'), 'x', 'nested font groups unwrapped');

// ---- natural call syntax: Name(args) in math fields ----
eq(PS.toMath('Merge-Sort(A, p, r)'), '\\Call{Merge-Sort}{$A, p, r$}', 'bare call becomes \\Call');
eq(PS.toMath('x = Extract-Min(Q)'), '$x =$ \\Call{Extract-Min}{$Q$}', 'call on right of assignment');
eq(PS.toMath('Max(Left(i), Right(i))'), '\\Call{Max}{\\Call{Left}{$i$}$,$ \\Call{Right}{$i$}}', 'nested calls');
ok(PS.toMath('A[Parent(i)] < A[i]').includes('\\Call{Parent}{$i$}'), 'call inside brackets');
eq(PS.toMath('T(n) = O(n)'), '$T(n) = O(n)$', 'single-letter functions stay math');
eq(PS.toMath('f(x)'), '$f(x)$', 'lowercase stays math');
eq(PS.toMath('S1.top()'), '$S_1.\\mathit{top}()$', 'methods are not calls');
eq(PS.toMath('\\mathrm{Pr}(A)'), '$\\mathrm{Pr}(A)$', 'backslash opts out');
eq(PS.callsToPlain('$x =$ \\Call{Extract-Min}{$Q$}'), 'x = Extract-Min(Q)', 'calls back to plain');
eq(PS.callsToPlain('\\Call{Max}{\\Call{Left}{$i$}, \\Call{Right}{$i$}}'), 'Max(Left(i), Right(i))', 'nested back to plain');
eq(PS.callsToPlain('\\Call{Foo}{\\textbf{x}}'), null, 'unusual call kept raw');
{
  const ret = PS.parseLatex('\\Return \\Call{Max-Heapify}{$A, i$}').nodes[0];
  eq([ret.text, ret.textMath], ['Max-Heapify(A, i)', true], 'return call parsed to plain field');
  eq(PS.serializeLatex({ caption: '', nodes: [ret] }).split('\n')[2], '  \\Return \\Call{Max-Heapify}{$A, i$}', 'return call saved back');
  const rows = PS.buildRows(PS.parseLatex('\\Return \\Call{Max-Heapify}{$A, i$}'));
  eq(rows[0].text, '\\kw{return} \\Call{Max-Heapify}{$A, i$}', 'return call renders as call');
  const cond = PS.parseLatex('\\If{$\\Call{Is-Empty}{$S$}$}\n\\State x\n\\EndIf').nodes[0];
  ok(PS.serializeLatex({ caption: '', nodes: [cond] }).includes('\\Call{Is-Empty}'), 'call in condition survives');
}

// ---- source must spell calls as \Call: bare Name(args) in source is prose ----
{
  const ret = PS.parseLatex('\\Return Tree-Maximum(x.left)').nodes[0];
  eq(ret.textMath, false, 'bare call in source is not guessed');
  eq(PS.serializeLatex({ caption: '', nodes: [ret] }).split('\n')[2], '  \\Return Tree-Maximum(x.left)', 'kept verbatim');
}

// ---- and / or / not: roman words between math, as in CLRS ----
eq(PS.toMath('i > 0 and A[i] > key'), '$i > 0$ and $A[i] > \\mathit{key}$', 'and between math runs');
eq(PS.toMath('not S1.empty()'), 'not $S_1.\\mathit{empty}()$', 'leading not');
eq(PS.toMath(PS.normalizeOperators('x && y || z')), '$x$ and $y$ or $z$', '&& and || become words');
eq(PS.toMath('p \\land q'), '$p \\land q$', 'explicit \\land stays a symbol');
eq(PS.toMath('land and order'), '$\\mathit{land}$ and $\\mathit{order}$', 'only whole words');
eq(PS.toMath('Max-Heapify(A, i) and done'), '\\Call{Max-Heapify}{$A, i$} and $\\mathit{done}$', 'keywords next to calls');
{
  const cond = PS.parseLatex('\\If{$Q.\\mathrm{tail} = 1$ \\textbf{and} $Q.\\mathrm{head} = 1$}\n\\EndIf').nodes[0].branches[0];
  eq([cond.cond, cond.condMath], ['Q.tail == 1 and Q.head == 1', true], 'older \\textbf{and} shown as the word');
  eq(PS.serializeLatex({ caption: '', nodes: [PS.parseLatex('\\If{$a = 1$ \\textbf{and} $b = 1$}\n\\EndIf').nodes[0]] }).split('\n')[2],
    '  \\If{$a == 1$ and $b == 1$}', 'older \\textbf{and} saved as the roman word');
  const notLoop = PS.parseLatex('\\While{\\textbf{not} $S_1.\\mathrm{empty}()$}\n\\EndWhile');
  eq(PS.serializeLatex(notLoop).split('\n')[2], '  \\While{not $S_1.\\mathrm{empty}()$}', 'older bold not saved roman, rest kept');
  ok(!PS.buildRows(notLoop)[0].text.includes('\\textbf'), 'not renders roman');
  const bare = PS.parseLatex('\\While{$i > 0$ and $A[i] > \\mathit{key}$}\n\\EndWhile').nodes[0];
  eq([bare.cond, bare.condMath], ['i > 0 and A[i] > key', true], 'canonical: plain and between math runs');
  const prose = PS.parseLatex('\\State $x$ and $y$ are swapped').nodes[0];
  eq(prose.textMath, false, 'other words keep a line prose');
}


// ---- typed lines (builder shortcuts) and plain-text paste ----
{
  const kind = (text, final) => { const t = PS.typedLine(text, { final }); return t ? t.kind : null; };
  eq(['if ', 'if', 'iffy', 'while ', 'for ', 'for each ', 'repeat ', 'return ', 'return', '// x', 'x = 1'].map((t) => kind(t)),
    ['if', null, null, 'while', 'for', 'forall', 'repeat', 'return', null, 'comment', null], 'keywords count once a space follows');
  eq(['else', 'else ', 'else i', 'else if', 'else if ', 'else x', 'elif y', 'elsif y'].map((t) => kind(t)),
    [null, null, null, null, 'elseif', 'else', 'elseif', 'elseif'], 'else waits until it cannot be else if');
  eq(['else', 'else:', '} else {', 'return', 'break', 'end if', '}', 'endwhile', 'repeat'].map((t) => kind(t, true)),
    ['else', 'else', 'else', 'return', 'break', 'end', 'end', 'end', 'repeat'], 'bare keywords on Enter');
  eq(PS.typedLine('if (x > 0) {', { final: true }).fields.cond, 'x > 0', 'C-style condition cleaned');
  eq(PS.typedLine('while i < n do', { final: true }).fields.cond, 'i < n', '"do" dropped');
  eq(PS.typedLine('for i = 1 to n do', { final: true }).fields, { init: 'i = 1', bound: 'n', downto: false, split: true }, 'for head split');
  eq(PS.typedLine('for v ∈ G.V').fields.init, 'v in G.V', '∈ for-each');
  eq(PS.typedLine('def merge(A, p, r):').fields, { kind: 'Procedure', name: 'merge', args: 'A, p, r' }, 'Python def');
  eq(PS.typedLine('Input: A, n').kind, 'require', 'Input: → require');
}
{
  const flat = (nodes) => nodes.map((n) => (n.type === 'if' ? `if(${n.branches.map((b) => b.cond).join('|')})${n.elseBody ? '+else' : ''}` : n.type));
  const py = PS.parsePlain('def f(A):\n    if x:\n        y = 1\n    elif z:\n        y = 2\n    else:\n        y = 3\n    return y');
  eq([py[0].type, py[0].name, flat(py[0].body)], ['function', 'f', ['if(x|z)+else', 'return']], 'Python indentation');
  const clrs = PS.parsePlain('INSERTION-SORT(A)\n1 for j = 2 to A.length\n2     key = A[j]  // the key\n3     i = j − 1');
  eq([clrs[0].name, clrs[0].body[0].type, clrs[0].body[0].body.length, clrs[0].body[0].body[0].comment, clrs[0].body[0].body[1].text],
    ['Insertion-Sort', 'for', 2, 'the key', 'i = j - 1'], 'CLRS copy: header, numbers dropped, nesting, comment, unicode minus');
  const c = PS.parsePlain('if (a) {\n  b = 1;\n} else {\n  b = 2;\n}\nc = 3;');
  eq([flat(c), c[0].elseBody[0].text, c[1].text], [['if(a)+else', 'state'], 'b = 2', 'c = 3'], 'C braces');
  const ends = PS.parsePlain('while x\nrepeat\ny = 1\nuntil y\nend while\nz = 0');
  eq([flat(ends), ends[0].body[0].type, ends[0].body[0].until], [['while', 'state'], 'repeat', 'y'], 'end-style blocks with repeat/until');
  eq(PS.parsePasted('\\State $x$\n\\State $y$').latex, true, 'LaTeX paste detected');
}

// ---- CLRS typography ----
eq(PS.toMath('A[1..j-1]'), '$A[1 \\twodots j-1]$', 'range dots typed as .. (clrscode \\twodots)');
eq(PS.parseLatex('\\State $C[0 \\twodots k] = 0$').nodes[0].text, 'C[0..k] = 0', 'twodots shown as .. in the builder');
eq(PS.toMath('(a, b, ..., z)'), '$(a, b, ..., z)$', 'three dots are not a range');
eq(PS.toMath('exchange A[i] with A[j]'), '$\\mathrm{exchange}\\ A[i]\\ \\mathrm{with}\\ A[j]$', 'phrase words upright');
eq(PS.toMath('x.key = k'), '$x.\\mathit{key} = k$', 'identifiers italic');
eq(PS.toMath('m = max(a, b) + lg n'), '$m = \\max(a, b) + \\lg n$', 'math operators upright');
eq(PS.toMath('max = A[1]'), '$\\mathit{max} = A[1]$', 'max as a variable stays italic');
eq(PS.toMath('x mod y'), '$x \\bmod y$', 'mod');
eq(PS.toMath('x != NIL'), '$x \\ne \\textsc{nil}$', 'no stray space after \\ne');
eq(PS.toMath('error "heap underflow"'), '\\textbf{error} “heap underflow”', 'error statement');
{
  const err = PS.parseLatex('\\State \\textbf{error} “underflow”').nodes[0];
  eq([err.text, err.textMath], ['error “underflow”', true], 'error read back for the builder');
  eq(PS.serializeLatex({ caption: '', nodes: [err] }).split('\n')[2], '  \\State \\textbf{error} “underflow”', 'error saved back');
  const nil = PS.parseLatex('\\If{$x \\ne \\textsc{nil}$}\n\\EndIf').nodes[0].branches[0];
  eq([nil.cond, nil.condMath], ['x != NIL', true], 'small-caps constant read back as NIL');
  eq(PS.serializeLatex(PS.parseLatex('\\If{$A[m] = x$}\n\\EndIf')).split('\n')[2], '  \\If{$A[m] == x$}', 'condition = saved as ==');
  eq(PS.serializeLatex(PS.parseLatex('\\Return \\textbf{true}')).split('\n')[2], '  \\Return \\textbf{true}', 'fonts in math-free prose kept');
  const loop = PS.parseLatex('\\For{$i \\gets 0$ \\textbf{to} $k$}\n\\EndFor').nodes[0];
  eq([loop.init, loop.bound, loop.downto], ['i = 0', 'k', false], 'for with \\textbf{to}');
}

// ---- tree helpers ----
const tree = PS.parseLatex('\\If{a}\n\\State b\n\\Elif{c}\n\\State d\n\\Else\n\\State e\n\\EndIf');
const ifNode = tree.nodes[0];
eq(PS.childLists(ifNode).length, 3, 'if child lists: branches + else');
ok(PS.slotBody(ifNode, 'else') === ifNode.elseBody, 'else slot');
ok(PS.slotBody(ifNode, 1) === ifNode.branches[1].body, 'branch slot');
ok(PS.bodyOf(ifNode) === ifNode.elseBody, 'tail of an if is its else');
const moved = PS.parseLatex('\\State z\n\\If{a}\n\\State b\n\\Else\n\\State e\n\\EndIf');
ok(PS.reorder(moved.nodes, moved.nodes[0].id, moved.nodes[1].id, 'inside', 0), 'reorder into branch slot');
eq(moved.nodes[0].branches[0].body.map((n) => n.text), ['b', 'z'], 'dropped into the if branch, not else');
let visited = 0;
PS.walk(tree.nodes, () => { visited++; });
eq(visited, 4, 'walk visits every node');

// ---- 2.3: TeX specials in builder fields ----
{
  const saved = (text) => PS.serializeLatex({ caption: '', nodes: [PS.statementNode(text)] }).split('\n')[2].trim();
  const back = (text) => PS.parseLatex(saved(text)).nodes[0].text;
  const stable = (text) => {
    const once = PS.serializeLatex({ caption: '', nodes: [PS.statementNode(text)] });
    return PS.serializeLatex(PS.parseLatex(once)) === once;
  };
  eq(saved('i % 2 == 0'), '\\State $i \\% 2 == 0$', '% escaped (MathJax would read a comment)');
  eq(saved('S = S ∪ {u}'), '\\State $S = S ∪ \\{u\\}$', 'set braces escaped');
  eq(saved('heap_size = 0'), '\\State $\\mathit{heap\\_size} = 0$', 'snake_case is one italic name');
  eq(saved('x_i = 0'), '\\State $x_i = 0$', 'one-letter base keeps its subscript');
  eq(saved('n^{k+1}'), '\\State $n^{k+1}$', 'superscript group kept');
  eq(saved('a & b # c'), '\\State $a \\& b \\# c$', '& and # escaped');
  eq(saved('cost $5'), '\\State $\\mathit{cost} \\$5$', 'a lone $ is a dollar sign');
  ['i % 2 == 0', 'S = S ∪ {u}', 'heap_size = 0', 'cost $5', 'a & b', 'n^{k+1}', 'A.left_child = NIL'].forEach((text) => {
    eq(back(text), text, `field reads back as typed: ${text}`);
    ok(stable(text), `saving twice changes nothing: ${text}`);
  });
  eq(saved('完成 100%'), '\\State 完成 100\\%', 'prose (CJK) escapes % too');
  eq(back('完成 100%'), '完成 100%', 'and reads it back');
}

// ---- 2.3: math shortcuts ----
eq(PS.toMath('floor(n/2) + ceil(m)'), '$\\lfloor n/2 \\rfloor + \\lceil m \\rceil$', 'floor / ceil');
eq(PS.toMath('sqrt(n) + abs(x)'), '$\\sqrt{n} + \\lvert x \\rvert$', 'sqrt / abs');
eq(PS.toMath('floor((lo + hi) / 2)'), '$\\lfloor (\\mathit{lo} + \\mathit{hi}) / 2 \\rfloor$', 'nested parentheses');
eq(PS.toMath('d[v] = inf'), '$d[v] = \\infty$', 'inf');
eq(PS.toMath('x = infinity'), '$x = \\infty$', 'infinity');
eq(PS.toMath('p = None'), '$p = \\textsc{nil}$', 'None is NIL');
eq(PS.toMath('p = null'), '$p = \\textsc{nil}$', 'null is NIL');
eq(PS.toMath('x = n**2'), '$x = n^{2}$', 'power');
eq(PS.toMath(PS.normalizeOperators('!done')), 'not $\\mathit{done}$', '!x is not x');
eq(PS.normalizeOperators('n! + 1 != 2'), 'n! + 1 != 2', 'factorial and != untouched');
eq(PS.parseLatex('\\State $x = \\lfloor n/2 \\rfloor + \\infty$').nodes[0].text, 'x = floor(n/2) + ∞', 'read back in builder spelling');
eq(PS.parseLatex('\\State $x = \\left\\lfloor n/2 \\right\\rfloor$').nodes[0].text, 'x = \\left\\lfloor n/2 \\right\\rfloor', '\\left\\lfloor left alone');
eq(PS.toMath('x = spawn Fib(n - 1)'), '$x =$ \\textbf{spawn} \\Call{Fib}{$n - 1$}', 'spawn is bold');
eq(PS.toMath('sync'), '\\textbf{sync}', 'sync is bold');

// ---- 2.3: parser robustness and new blocks ----
{
  const m = PS.parseLatex('\\If{$a$}\n\\ForEach{$v \\in V$}\n\\State $x$\n\\EndFor\n\\State $y$\n\\EndIf\n\\State $z$');
  eq(m.nodes.length, 2, 'ForEach closes itself, not the if around it');
  eq(m.nodes[0].branches[0].body.map((n) => n.type), ['for', 'state'], 'y stays inside the if');
  ok(m.nodes[0].branches[0].body[0].all, 'ForEach is a for-each');
  const stray = PS.parseLatex('\\If{$a$}\n\\State $x$\n\\EndWhile\n\\State $y$\n\\EndIf');
  eq(stray.nodes[0].branches[0].body.length, 2, 'a stray \\EndWhile does not close the if');
}
{
  const src = [
    '\\begin{algorithm}', '\\begin{algorithmic}[0]', '  \\setcounter{ALG@line}{4}', '  \\Statex \\textbf{Phase 1}',
    '  \\State $x = 1$ \\label{init} % highlight', '  \\If{$x > 0$}', '    \\State go to line \\ref{init}', '  \\Else \\label{els}',
    '    \\State $y$', '  \\EndIf', '  \\Switch{$c$}', '    \\Case{$1$}', '      \\State $a$', '    \\EndCase', '    \\Default',
    '      \\State $b$', '    \\EndCase', '  \\EndSwitch', '  \\Loop', '    \\State \\textbf{sync}', '  \\EndLoop',
    '  \\ParFor{$i = 1$ \\To $n$}', '    \\State $x =$ \\textbf{spawn} \\Call{Fib}{$n - 1$}', '  \\EndFor', '  \\Statex',
    '\\end{algorithmic}', '\\end{algorithm}',
  ].join('\n');
  const m = PS.parseLatex(src);
  eq(PS.serializeLatex(m), src, 'labels, highlight, Statex, options, switch, loop and parallel for survive a save');
  eq([m.numbers, m.start], [false, 5], 'block options read');
  eq(m.nodes.map((n) => n.type), ['statex', 'state', 'if', 'switch', 'loop', 'for', 'statex'], 'node types');
  eq([m.nodes[1].label, m.nodes[1].mark, m.nodes[2].elseLabel], ['init', true, 'els'], 'label / highlight kept on their lines');
  ok(m.nodes[5].parallel, 'ParFor is a parallel for');
  const standalone = PS.parseLatex('\\State $x$\n\\label{a}\n\\State $y$');
  eq(standalone.nodes[0].label, 'a', 'a \\label on its own line names the line above');
  const mid = PS.parseLatex('\\State $x$\n\\setcounter{ALG@line}{9}\n\\State $y$');
  eq(mid.nodes[1], Object.assign({ id: mid.nodes[1].id }, { type: 'counter', value: '10' }), 'a counter in the middle is a line');
}
{
  const m = PS.parseLatex('\\Switch{$x$}\n\\Case{$1$}\n\\State $a$\n\\Case{$2$}\n\\State $b$\n\\Default\n\\State $c$\n\\EndSwitch\n\\State $d$');
  eq(m.nodes.length, 2, 'cases close each other without \\EndCase');
  eq(m.nodes[0].body.map((n) => (n.default ? 'default' : n.value)), ['1', '2', 'default'], 'three cases');
}

// ---- 2.3: export ----
{
  const m = PS.parseLatex('\\If{$a$}\n\\Return $1$\n\\Elif{$b$}\n\\Print $x$\n\\Break\n\\EndIf\n\\For{$i = 1$ \\To $n$}\n\\State $A[1 \\twodots n]$\n\\EndFor\n\\State $x ≤ ∞$');
  const out = PS.exportLatex(m);
  ok(out.includes('%   \\usepackage{algpseudocode}') || out.includes('\\usepackage[noend]{algpseudocode}'), 'preamble listed');
  ok(out.includes('\\begin{algorithmic}[1]'), 'numbered by default');
  ok(out.includes('\\ElsIf{$b$}') && !out.includes('\\Elif'), 'ElsIf');
  ok(out.includes('\\State \\Return $1$'), 'Return inside a State');
  ok(out.includes('\\State \\textbf{print} $x$') && out.includes('\\State \\textbf{break}'), 'print / break spelled out');
  ok(out.includes('\\textbf{to}') && !out.includes('\\To'), 'to spelled out');
  ok(out.includes('\\mathinner{\\ldotp\\ldotp}') && !out.includes('\\twodots'), 'range dots');
  ok(out.includes('\\ensuremath{\\le}') && out.includes('\\infty'), 'unicode symbols as TeX');
  ok(!out.includes('\\algdef'), 'no extra definitions when not needed');
  const sw = PS.exportLatex(PS.parseLatex('\\Switch{$x$}\n\\Default\n\\State $a$\n\\EndSwitch'));
  ok(sw.includes('\\algdef{SE}[SWITCH]') && sw.includes('\\EndDefault'), 'switch definitions and \\EndDefault');
  const hidden = PS.exportLatex({ caption: '', numbers: false, start: 3, nodes: [] });
  ok(hidden.includes('\\begin{algorithmic}\n') && hidden.includes('\\makeatletter\\setcounter{ALG@line}{2}\\makeatother'), 'options exported');
}

// ---- 2.3: typed lines ----
{
  const t = (text, final = true) => PS.typedLine(text, { final });
  eq(PS.splitSignature('f(x) -> int'), { name: 'f', args: 'x' }, 'Python return type dropped');
  eq(PS.splitSignature('f(x) returns int'), { name: 'f', args: 'x' }, 'returns T dropped');
  eq(PS.splitSignature('bsearch(A: list[int], x: int = 0)'), { name: 'bsearch', args: 'A, x' }, 'annotations and defaults dropped');
  eq(PS.splitSignature('sum(int[] A, const vector<int>& v, int *p)'), { name: 'sum', args: 'A, v, p' }, 'C / Java parameter types dropped');
  eq(PS.splitSignature('Max-Heapify(A, i'), { name: 'Max-Heapify', args: 'A, i' }, 'still typing: unclosed args');
  eq(t('int max(int a, int b) {').fields, { kind: 'Function', name: 'max', args: 'a, b' }, 'C function header (pasted)');
  eq(PS.typedLine('int max(int a, int b) {'), null, 'not while typing');
  eq(t('for (int i = 0; i < n; i++)').fields, { init: 'i = 0', bound: 'n - 1', downto: false, split: true }, 'C for');
  eq(t('for (i = n; i >= 1; i--)').fields, { init: 'i = n', bound: '1', downto: true, split: true }, 'C for downwards');
  eq(t('for (i = 0; i < n; i += 2)').fields.init, '(i = 0; i < n; i += 2)'.slice(1, -1), 'other steps left as written');
  eq(t('for i in range(1, n + 1):').fields, { init: 'i = 1', bound: 'n', downto: false, split: true }, 'Python range');
  eq(t('for i in range(n):').fields, { init: 'i = 0', bound: 'n - 1', downto: false, split: true }, 'range(n)');
  eq(t('for k in range(n, 0, -1):').fields, { init: 'k = n', bound: '1', downto: true, split: true }, 'range downwards');
  eq(t('for v in G.V').kind, 'forall', 'for-in is still for each');
  eq(t('parallel for i = 1 to n').fields.parallel, true, 'parallel for');
  eq([t('loop').kind, t('switch (x) {').kind, t('switch (x) {').fields.cond], ['loop', 'switch', 'x'], 'loop / switch');
  eq(t('case 1: y = 2').fields, { value: '1', rest: 'y = 2' }, 'case with a statement');
  eq([t('default:').kind, t('case _:').kind], ['default', 'default'], 'default (and Python case _)');
  eq(PS.typedLine('defaults = 3', { final: true }), null, 'defaults = 3 is a statement');
  eq(PS.typedLine('loops = 0', { final: true }), null, 'loops = 0 is a statement');
  eq(t('do {').kind, 'repeat', 'do { (pasted) is a repeat');
  // Chinese keywords
  eq(t('如果 x > 0 则').fields.cond, 'x > 0', '如果 … 则');
  eq(t('否则如果 x < 0').kind, 'elseif', '否则如果');
  eq([t('否则').kind, PS.typedLine('否则')], ['else', null], '否则 (waits while typing)');
  eq(t('对于 i = 1 到 n').fields, { init: 'i = 1', bound: 'n', downto: false, split: true }, '对于 … 到');
  eq(t('对于 i = n 递减到 1').fields.downto, true, '递减到');
  eq(t('对每个 v ∈ V').kind, 'forall', '对每个');
  eq(t('当 i > 0 时').fields.cond, 'i > 0', '当 … 时');
  eq(PS.typedLine('当前节点 = x', { final: true }), null, '当前 is not while');
  eq([t('重复').kind, t('直到 i > n').kind, t('返回 x').kind, t('跳出').kind, t('继续').kind], ['repeat', 'until', 'return', 'break', 'continue'], 'other Chinese keywords');
  eq(t('过程 Insert(A, x)').fields, { kind: 'Procedure', name: 'Insert', args: 'A, x' }, '过程');
  eq([t('输入：数组 A').kind, t('输出：A 已排序').kind, t('输出 x').kind], ['require', 'ensure', 'print'], '输入 / 输出');
  eq(t('结束如果').kind, 'end', '结束如果');
}

// ---- 2.3: paste ----
{
  const pasted = (text) => PS.serializeLatex({ caption: '', nodes: PS.parsePasted(text).nodes }).split('\n').slice(2, -2).map((line) => line.trim());
  eq(pasted('```python\nif x:\n    y = 1\n```'), ['\\If{$x$}', '\\State $y = 1$', '\\EndIf'], 'code fence dropped');
  eq(pasted('if x > 0 then y = 1\nz = 2'), ['\\If{$x > 0$}', '\\State $y = 1$', '\\EndIf', '\\State $z = 2$'], 'one-line if … then');
  eq(pasted('if x: return y\nz = 2'), ['\\If{$x$}', '\\Return $y$', '\\EndIf', '\\State $z = 2$'], 'Python one-line if');
  eq(pasted('for (int i = 0; i < n; i++) {\n    if (a[i] > m)\n        m = a[i];\n    c++;\n}\nreturn m;'),
    ['\\For{$i = 0$ \\To $n - 1$}', '\\If{$a[i] > m$}', '\\State $m = a[i]$', '\\EndIf', '\\State $c++$', '\\EndFor', '\\Return $m$'],
    'C: an if without braces owns one statement');
  eq(pasted('if (x > 0)\n    y = 1;\nelse\n    y = 2;\nz = 3;'), ['\\If{$x > 0$}', '\\State $y = 1$', '\\Else', '\\State $y = 2$', '\\EndIf', '\\State $z = 3$'], 'C if / else without braces');
  eq(pasted('while (i < n)\n{\n    i++;\n}\nf();'), ['\\While{$i < n$}', '\\State $i++$', '\\EndWhile', '\\State $f()$'], 'Allman braces');
  eq(pasted('do {\n  x--;\n} while (x > 0);'), ['\\Repeat', '\\State $x--$', '\\Until{$x \\le 0$}'], 'do-while: until with the condition negated');
  eq(pasted('switch (x) {\n  case 1: y = 2; break;\n  default: y = 3;\n}'),
    ['\\Switch{$x$}', '\\Case{$1$}', '\\State $y = 2$', '\\EndCase', '\\Default', '\\State $y = 3$', '\\EndCase', '\\EndSwitch'], 'C switch (trailing break dropped)');
  eq(pasted('def f(A: list) -> int:\n    """Sort A."""\n    mid = (lo + hi) // 2\n    for i in range(1, len(A)):\n        pass\n    return None'),
    ['\\Procedure{f}{$A$}', '\\State \\Comment{Sort A.}', '\\State $\\mathit{mid} = \\lfloor (\\mathit{lo} + \\mathit{hi}) / 2 \\rfloor$',
      '\\For{$i = 1$ \\To $\\mathit{len}(A) - 1$}', '\\EndFor', '\\Return $\\textsc{nil}$', '\\EndProcedure'], 'Python: docstring, //, range, pass, None');
  eq(pasted('while x > 0:\n    x -= 1\nelse:\n    print(x)')[3], '\\State \\Comment{if the loop above ended without break:}', 'while … else');
  eq(pasted('if x > 0 then\nbegin\n  y := 1;\n  z := 2\nend\nelse\n  y := 0;'),
    ['\\If{$x > 0$}', '\\State $y = 1$', '\\State $z = 2$', '\\Else', '\\State $y = 0$', '\\EndIf'], 'Pascal begin / end');
  eq(pasted('int sum(int[] A) {\n  int s = 0;\n  return s;\n}'), ['\\Function{sum}{$A$}', '\\State $s = 0$', '\\Return $s$', '\\EndFunction'], 'C function, declaration type dropped');
  eq(pasted('如果 x > 0\n    返回 x\n否则\n    返回 -x'), ['\\If{$x > 0$}', '\\Return $x$', '\\Else', '\\Return $-x$', '\\EndIf'], 'Chinese pseudocode');
  eq(pasted('match c:\n    case 1:\n        a()\n    case _:\n        b()'),
    ['\\Switch{$c$}', '\\Case{$1$}', '\\State $a()$', '\\EndCase', '\\Default', '\\State $b()$', '\\EndCase', '\\EndSwitch'], 'Python match');
}

done();
