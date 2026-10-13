import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// The app loads the `/vite` entry points (Vite resolves each package's .wasm
// asset). Those cannot run in Node, so the engine tests drive the `/node`
// entries through the same option-mapping helpers the app uses.
import { format as clangFormat } from '@wasm-fmt/clang-format/node';
import { format as gofmt } from '@wasm-fmt/gofmt/node';
import { format as ruffFormat } from '@wasm-fmt/ruff_fmt/node';

import {
  LANGUAGES,
  clangFormatStyle,
  detectLanguage,
  formatCode,
  ruffFormatConfig,
  type FormatOptions,
  type LanguageId,
} from './formatter.ts';

/**
 * Regression tests for the formatter engine. Most `describe` blocks pin a bug
 * that was fixed; they are written against the public `formatCode` /
 * `detectLanguage` surface so they keep guarding behaviour rather than
 * implementation. The engine blocks additionally assert that each language is
 * backed by the real formatter it claims (clang-format, gofmt, ruff, terser).
 *
 * Run with `pnpm test` from this package, or `node --test` with the glob for
 * test files under `src` (Node strips the TypeScript types natively).
 */

function options(
  language: LanguageId,
  mode: FormatOptions['mode'] = 'format',
  overrides: Partial<FormatOptions> = {},
): FormatOptions {
  return { language, mode, indentWidth: 2, useTabs: false, printWidth: 80, ...overrides };
}

const format = (source: string, language: LanguageId, overrides?: Partial<FormatOptions>) =>
  formatCode(source, options(language, 'format', overrides));

const minify = (source: string, language: LanguageId) =>
  formatCode(source, options(language, 'minify'));

describe('JSON formatting preserves number literals', () => {
  it('keeps integers beyond Number.MAX_SAFE_INTEGER exact', async () => {
    const source = '{"id":12345678901234567890,"ok":true}';
    const output = await format(source, 'json');

    assert.match(output, /12345678901234567890/);
    assert.doesNotMatch(output, /12345678901234567000/);
    assert.equal(
      output,
      ['{', '  "id": 12345678901234567890,', '  "ok": true', '}'].join('\n'),
    );
  });

  it('keeps long decimals and exponents exact', async () => {
    const source = '{"n":0.1234567890123456789012,"e":1e400,"neg":-9007199254740993}';
    const output = await format(source, 'json');

    assert.match(output, /0\.1234567890123456789012/);
    assert.match(output, /1e400/);
    assert.match(output, /-9007199254740993/);
  });

  it('expands one-line documents and keeps nested structure', async () => {
    const output = await format('{"a":[1,2],"b":{},"c":{"d":[]}}', 'json');

    assert.equal(
      output,
      [
        '{',
        '  "a": [',
        '    1,',
        '    2',
        '  ],',
        '  "b": {},',
        '  "c": {',
        '    "d": []',
        '  }',
        '}',
      ].join('\n'),
    );
  });

  it('honours the requested indent width and tabs', async () => {
    const two = await format('{"a":{"b":1}}', 'json', { indentWidth: 4 });
    assert.equal(two, ['{', '    "a": {', '        "b": 1', '    }', '}'].join('\n'));

    const tabs = await format('{"a":1}', 'json', { useTabs: true });
    assert.equal(tabs, ['{', '\t"a": 1', '}'].join('\n'));
  });

  it('minifies without rounding numbers', async () => {
    assert.equal(
      await minify('{ "id": 12345678901234567890, "ok": true }', 'json'),
      '{"id":12345678901234567890,"ok":true}',
    );
  });
});

describe('CSS minify respects string literals', () => {
  it('keeps whitespace inside a declaration value', async () => {
    assert.equal(await minify('.a { content: "  "; }', 'css'), '.a{content:"  "}');
  });

  it('collapses ordinary whitespace and drops comments', async () => {
    assert.equal(await minify('.b { /* note */ color : red ; }', 'css'), '.b{color:red}');
  });

  it('leaves braces and semicolons inside strings alone', async () => {
    assert.equal(await minify('.c{content:"a{b};c"}', 'css'), '.c{content:"a{b};c"}');
  });

  it('still minifies at-rules and nested rules', async () => {
    assert.equal(
      await minify('@media (max-width: 600px) { .d { display: none; } }', 'css'),
      '@media (max-width:600px){.d{display:none}}',
    );
  });

  it('applies to scss and less too', async () => {
    assert.equal(await minify('.a { content: " x "; }', 'scss'), '.a{content:" x "}');
    assert.equal(await minify('.a { content: " x "; }', 'less'), '.a{content:" x "}');
  });
});

describe('markup minify keeps significant whitespace', () => {
  it('keeps the space between inline elements', async () => {
    assert.equal(
      await minify('<p>Hello <b>world</b> <i>!</i></p>', 'html'),
      '<p>Hello <b>world</b> <i>!</i></p>',
    );
  });

  it('keeps inline spacing that spans a newline', async () => {
    const output = await minify('<p>\n  Hello <b>world</b>\n  <i>!</i>\n</p>', 'html');
    assert.match(output, /<b>world<\/b> <i>!<\/i>/);
  });

  it('removes indentation between block elements', async () => {
    const source = '<ul>\n  <li><a href="#">one</a></li>\n  <li>two</li>\n</ul>';
    assert.equal(
      await minify(source, 'html'),
      '<ul><li><a href="#">one</a></li><li>two</li></ul>',
    );
  });

  it('copies pre/textarea/script/style contents verbatim', async () => {
    assert.equal(
      await minify('<div>\n  <pre>  keep\n   this  </pre>\n</div>', 'html'),
      '<div><pre>  keep\n   this  </pre></div>',
    );
    assert.equal(
      await minify('<script>if (a < b) { c(); }</script>', 'html'),
      '<script>if (a < b) { c(); }</script>',
    );
  });

  it('collapses whitespace inside tags but not inside attribute values', async () => {
    assert.equal(
      await minify('<input\n  type="text"\n  value="a   b"  >', 'html'),
      '<input type="text" value="a   b">',
    );
  });

  it('minifies XML with the same rules', async () => {
    assert.equal(
      await minify('<note>\n  <to>Tove</to>\n  <from>Jani</from>\n</note>', 'xml'),
      '<note><to>Tove</to><from>Jani</from></note>',
    );
  });

  it('joins words that were split across lines instead of gluing them', async () => {
    assert.equal(await minify('<p>Hello\nworld</p>', 'html'), '<p>Hello world</p>');
  });
});

describe('JS minify handles flagged regex literals', () => {
  it('minifies a regex whose pattern contains a quote', async () => {
    assert.equal(await minify('/["]/g; const n = 1;', 'javascript'), '/["]/g;const n=1;');
    assert.equal(await minify("/[']/g; const n = 1;", 'javascript'), "/[']/g;const n=1;");
    assert.equal(await minify('/["\']/gi; const n = 1;', 'javascript'), '/["\']/gi;const n=1;');
  });

  it('minifies a flagged regex used in an expression', async () => {
    assert.equal(
      await minify('/d+/g.test(s); const n = 1;', 'javascript'),
      '/d+/g.test(s);const n=1;',
    );
  });

  it('keeps the rest of the source after a flagged regex', async () => {
    const output = await minify('/a/g; const first = 1; const second = 2;', 'javascript');
    assert.equal(output, '/a/g;const first=1;const second=2;');
  });

  it('still minifies unflagged regexes and division', async () => {
    assert.equal(await minify('const r = /a\\/b/.test(x);', 'javascript'), 'const r=/a\\/b/.test(x);');
    assert.equal(await minify('const r = a / b / c;', 'javascript'), 'const r=a/b/c;');
  });
});

describe('structural formatting separates braces from continuation keywords', () => {
  const block = 'if (a) { b(); } else { c(); }';

  it('emits a single space before else/catch/finally/while', async () => {
    const output = await format(block, 'c');

    assert.ok(output.includes('} else {'), `expected "} else {" in:\n${output}`);
    assert.doesNotMatch(output, /\}\s{2,}else/);
  });

  it('handles else on its own source line', async () => {
    const output = await format('if (a) {\n  b();\n}\nelse {\n  c();\n}', 'java');

    assert.ok(output.includes('} else {'), `expected "} else {" in:\n${output}`);
    assert.doesNotMatch(output, /\}\s{2,}else/);
  });

  it('handles try/catch/finally and do/while', async () => {
    const tryCatch = await format('try { a(); } catch (e) { b(); } finally { c(); }', 'csharp');
    assert.ok(tryCatch.includes('} catch ('), tryCatch);
    assert.ok(tryCatch.includes('} finally {'), tryCatch);
    assert.doesNotMatch(tryCatch, /\}\s{2,}(catch|finally)/);

    const doWhile = await format('do { a(); } while (x);', 'go');
    assert.ok(doWhile.includes('} while ('), doWhile);
    assert.doesNotMatch(doWhile, /\}\s{2,}while/);
  });
});

describe('language auto-detection', () => {
  it('detects JSX in React code', () => {
    assert.equal(detectLanguage('export function App(){return <div className="x">hi</div>}'), 'jsx');
    assert.equal(detectLanguage('const App = () => (<div>{name}</div>);'), 'jsx');
    assert.equal(detectLanguage('const el = <div className="x" />;'), 'jsx');
  });

  it('detects TSX when the JSX code is typed', () => {
    assert.equal(detectLanguage('const App = ({ name }: Props) => <div>{name}</div>;'), 'tsx');
    assert.equal(
      detectLanguage('const App = (props: { name: string }) => <div>{props.name}</div>;'),
      'tsx',
    );
  });

  it('does not mistake plain JavaScript for CSS', () => {
    assert.equal(detectLanguage('function App(){ return 1; }'), 'javascript');
    assert.equal(detectLanguage('const add = (a, b) => a + b;'), 'javascript');
  });

  it('still detects CSS', () => {
    assert.equal(detectLanguage('body { margin: 0; padding: 0; }'), 'css');
    assert.equal(detectLanguage('.a{color:red}'), 'css');
    assert.equal(detectLanguage(':root{--fg:#fff}'), 'css');
    assert.equal(detectLanguage('@media (max-width: 600px) { .a { color: red; } }'), 'css');
  });

  it('leaves the other detections intact', () => {
    assert.equal(detectLanguage('<html><body><p>hi</p></body></html>'), 'html');
    assert.equal(detectLanguage('<?xml version="1.0"?><note><to>Tove</to></note>'), 'xml');
    assert.equal(detectLanguage('#include <stdio.h>\nint main() { return 0; }'), 'c');
    assert.equal(detectLanguage('{"a":1}'), 'json');
    assert.equal(detectLanguage('select id from users'), 'sql');
  });
});

describe('JavaScript minify runs through terser', () => {
  // These pin terser's non-lossy contract (compress and mangle are off): the
  // output is a real parse-and-print, but the user's code is never removed or
  // renamed.

  it('drops redundant statement separators', async () => {
    assert.equal(await minify('a();;;b();', 'javascript'), 'a();b();');
  });

  it('drops redundant parentheses and trailing semicolons', async () => {
    assert.equal(await minify('let x = (1);', 'javascript'), 'let x=1;');
    assert.equal(await minify('if (a) { b(); }', 'javascript'), 'if(a){b()}');
  });

  it('respects automatic semicolon insertion', async () => {
    // The hand-rolled token pass produced `x=y++z`, which is a different (and
    // invalid) program; a real parser inserts the semicolon.
    assert.equal(await minify('x = y\n++z', 'javascript'), 'x=y;++z;');
  });

  it('never deletes or renames the user\u2019s code', async () => {
    assert.equal(await minify('const n = 1; const m = 2;', 'javascript'), 'const n=1;const m=2;');
    // A standalone regex statement is dead code to a compressor — it must survive.
    assert.equal(await minify("/[\"']/g; const n = 1;", 'javascript'), "/[\"']/g;const n=1;");
  });

  it('strips comments but keeps /*! ... */ banners', async () => {
    assert.equal(
      await minify('/* drop */ const a = 1; // drop\nconst b = 2;', 'javascript'),
      'const a=1;const b=2;',
    );
    assert.equal(
      await minify('/*! keep */ function a(){ return 1; }', 'javascript'),
      '/*! keep */function a(){return 1}',
    );
  });

  it('handles ES module syntax', async () => {
    assert.equal(
      await minify('export const a = 1;\nimport x from "y";', 'javascript'),
      'export const a=1;import x from"y";',
    );
  });

  it('falls back to the token pass for TypeScript and JSX', async () => {
    // Terser's parser understands neither, so these keep the built-in minifier.
    assert.equal(await minify('const n: number = 1;', 'typescript'), 'const n:number=1;');
    assert.equal(await minify("/[\"']/g; const n = 1;", 'jsx'), "/[\"']/g;const n=1;");
    assert.equal(await minify('const el = <div a="1" />;', 'jsx'), 'const el=<div a="1"/>;');
  });
});

describe('clang-format backs the C family', () => {
  it('maps the UI controls onto clang-format style options', () => {
    assert.deepEqual(JSON.parse(clangFormatStyle(options('c'))), {
      BasedOnStyle: 'LLVM',
      IndentWidth: 2,
      TabWidth: 2,
      UseTab: 'Never',
      ColumnLimit: 80,
    });
    assert.deepEqual(
      JSON.parse(clangFormatStyle(options('c', 'format', { indentWidth: 4, useTabs: true, printWidth: 100 }))),
      { BasedOnStyle: 'LLVM', IndentWidth: 4, TabWidth: 4, UseTab: 'ForIndentation', ColumnLimit: 100 },
    );
  });

  it('formats C end to end with those options', () => {
    const source = 'int main(){int x=1;if(x){return x;}else{return 0;}}';

    assert.equal(
      clangFormat(source, 'main.c', clangFormatStyle(options('c'))),
      [
        'int main() {',
        '  int x = 1;',
        '  if (x) {',
        '    return x;',
        '  } else {',
        '    return 0;',
        '  }',
        '}',
      ].join('\n'),
    );
  });

  it('honours indent width and tabs', () => {
    const source = 'int main(){int x=1;return x;}';
    const style = (o: Partial<FormatOptions>) => clangFormatStyle(options('c', 'format', o));

    assert.equal(clangFormat(source, 'main.c', style({})), 'int main() {\n  int x = 1;\n  return x;\n}');
    assert.equal(clangFormat(source, 'main.c', style({ indentWidth: 4 })), 'int main() {\n    int x = 1;\n    return x;\n}');
    assert.equal(clangFormat(source, 'main.c', style({ useTabs: true })), 'int main() {\n\tint x = 1;\n\treturn x;\n}');
  });

  it('picks the dialect from the filename the registry supplies', () => {
    // clang-format infers the language from the filename, so each language in
    // the registry must carry the right one.
    assert.match(clangFormat('class A{void f(){int x=1;}}', 'main.java', clangFormatStyle(options('java'))), /^class A \{/);
    assert.match(clangFormat('class A{public:int x;};', 'main.cpp', clangFormatStyle(options('cpp'))), /^class A \{/);
    assert.match(clangFormat('public class A{void F(){}}', 'main.cs', clangFormatStyle(options('csharp'))), /^public class A \{/);
    assert.match(clangFormat('message M{string name=1;}', 'main.proto', clangFormatStyle(options('protobuf'))), /^message M \{/);
    assert.match(clangFormat('@interface A:NSObject\n@end', 'main.m', clangFormatStyle(options('objectivec'))), /^@interface A : NSObject/);
  });
});

describe('gofmt backs Go and ruff backs Python', () => {
  it('reformats Go canonically', () => {
    const source = 'package main\nimport "fmt"\nfunc main(){fmt.Println("hi")\n}\n';

    assert.equal(
      gofmt(source),
      'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("hi")\n}\n',
    );
  });

  it('maps the UI controls onto ruff config', () => {
    assert.deepEqual(ruffFormatConfig(options('python')), {
      indent_style: 'space',
      indent_width: 2,
      line_width: 80,
    });
    assert.deepEqual(ruffFormatConfig(options('python', 'format', { useTabs: true, indentWidth: 4 })), {
      indent_style: 'tab',
      indent_width: 4,
      line_width: 80,
    });
  });

  it('formats Python end to end with those options', () => {
    const source = "x = { 'a':37,'b':42 }\ndef f ( a,b ):\n  return a+b\n";

    assert.equal(
      ruffFormat(source, 'main.py', ruffFormatConfig(options('python'))),
      'x = {"a": 37, "b": 42}\n\n\ndef f(a, b):\n  return a + b\n',
    );
  });

  it('honours the tab preference', () => {
    assert.equal(
      ruffFormat('def f(a):\n  return a\n', 'main.py', ruffFormatConfig(options('python', 'format', { useTabs: true }))),
      'def f(a):\n\treturn a\n',
    );
  });
});

describe('language registry is backed by real formatters', () => {
  const wasmBacked: Array<[LanguageId, string]> = [
    ['c', 'clang-format'],
    ['cpp', 'clang-format'],
    ['java', 'clang-format'],
    ['csharp', 'clang-format'],
    ['objectivec', 'clang-format'],
    ['protobuf', 'clang-format'],
    ['go', 'gofmt'],
    ['python', 'ruff_fmt'],
  ];

  it('routes each language to its WASM formatter package and dialect', () => {
    for (const [id, formatter] of wasmBacked) {
      assert.equal(LANGUAGES[id].engine, 'wasm', `${id} should use a WASM engine`);
      assert.equal(LANGUAGES[id].wasm?.formatter, formatter, `${id} formatter package`);
      assert.ok(LANGUAGES[id].wasm?.filename, `${id} needs a dialect filename`);
    }
  });

  it('keeps the built-in pass only where no formatter is published', () => {
    // No browser-capable WASM formatter exists for these, so they are honest
    // about using the heuristic pass.
    for (const id of ['rust', 'swift', 'kotlin', 'php'] as LanguageId[]) {
      assert.equal(LANGUAGES[id].engine, 'structural', `${id} should stay structural`);
    }
  });

  it('still offers minify for WASM-backed languages', () => {
    for (const [id] of wasmBacked) assert.equal(LANGUAGES[id].canMinify, true, `${id} minify`);
  });

  it('degrades to the built-in pass when a WASM engine cannot load', async () => {
    // In Node the `/vite` entries cannot resolve, which is exactly the offline
    // case: formatting must still produce output instead of throwing.
    assert.match(await format('int main(){int x=1;return x;}', 'c'), /int main\(\)/);
    assert.match(await format('def f(  a,b ):\n  return a+b\n', 'python'), /def f\(/);
    assert.match(await format('package main\nfunc main(){println("x")}\n', 'go'), /func main\(\)/);
  });
});
