const { loadMain, suite } = require('./harness');

const { scanFences, locateFence, prefixed, CSS_LENGTH, codeFenceAt } = loadMain();
const { ok, eq, done } = suite();

const note = [
  'intro',           // 0
  '```pseudo',       // 1
  '\\State a',       // 2
  '```',             // 3
  'text',            // 4
  '```pseudo',       // 5
  '\\State a',       // 6
  '```',             // 7
  '> [!note]',       // 8
  '> ```pseudo',     // 9
  '> \\State q',     // 10
  '>',               // 11
  '> ```',           // 12
  '````pseudo',      // 13
  '```',             // 14  (shorter fence does not close a ```` block)
  '````',            // 15
  '```js',           // 16
  'x',               // 17
  '```',             // 18
];
const fences = scanFences(note);
eq(fences.map((f) => [f.start, f.end]), [[1, 3], [5, 7], [9, 12], [13, 15]], 'fences found, incl. callout and long fence');
eq(fences[2].source, '\\State q\n', 'callout prefix stripped from content');
eq(fences[2].prefix, '> ', 'callout prefix recorded');

eq(locateFence(note, '\\State a', 5).start, 5, 'identical blocks: the one at the hint');
eq(locateFence(note, '\\State a', 0).start, 1, 'identical blocks: nearest to the hint');
eq(locateFence(note, '\\State a', null).start, 1, 'no hint: first match');
eq(locateFence(note, '\\State zzz', 1), null, 'changed block is not matched');

eq(prefixed('\\State x\n\n\\State y', '> '), ['> \\State x', '>', '> \\State y'], 'prefix re-applied, blank quote lines kept');
eq(prefixed('\\State x', ''), ['\\State x'], 'no prefix');

ok(['1.2em', '16px', '.5rem', '2ch'].every((v) => CSS_LENGTH.test(v)), 'valid indent widths');
ok(!['', '12', 'red', '1.2 em', 'calc(1em)'].some((v) => CSS_LENGTH.test(v)), 'invalid indent widths rejected');

// Any code block under the cursor (for "Convert to pseudocode").
{
  const lines = ['text', '```python', 'def f(x):', '    return x', '```', '', '> ~~~c', '> int x;', '> ~~~', '```'];
  const py = codeFenceAt(lines, 2);
  eq([py.start, py.end, py.language, py.source], [1, 4, 'python', 'def f(x):\n    return x'], 'python block found from inside');
  eq(codeFenceAt(lines, 1).start, 1, 'on the opening line');
  eq(codeFenceAt(lines, 0), null, 'outside any block');
  const quoted = codeFenceAt(lines, 7);
  eq([quoted.language, quoted.source, quoted.prefix], ['c', 'int x;', '> '], 'callout / quote block with ~~~');
  eq(codeFenceAt(lines, 9), null, 'an unclosed fence is not a block');
}

done();
