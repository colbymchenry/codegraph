/**
 * The scan that finds what of a C or C++ file is not code: comments, raw
 * strings, and the strings and character literals that may hold what would
 * start either. Declarations are read off the lines around it, so a slip here
 * moves edges. These are the answers of the scan as it read character strings,
 * before it read char codes.
 */
import { describe, expect, it } from 'vitest';
import { cppLiteralsBlanked, cppNonCodeLines } from '../src/resolution/cpp-raw-strings';
import type { ResolutionContext } from '../src/resolution/types';

const nonCode = (text: string): Array<[number, Array<[number, number]>]> =>
  [...cppNonCodeLines('f.cc', { readFile: () => text } as unknown as ResolutionContext)].sort((a, b) => a[0] - b[0]);

describe('cppNonCodeLines', () => {
  it("a file with neither", () => {
    expect(nonCode("int a = 1;\nint b = 2;\n")).toEqual([]);
  });
  it("a block comment across lines", () => {
    expect(nonCode("int a; /* one\n two\n three */ int b;\n")).toEqual([[1,[[7,13]]],[2,[[0,4]]],[3,[[0,9]]]]);
  });
  it("a block comment in a CRLF file", () => {
    expect(nonCode("int a; /* one\r\n two */ int b;\r\n")).toEqual([[1,[[7,13]]],[2,[[0,7]]]]);
  });
  it("an unterminated block comment", () => {
    expect(nonCode("int a;\n/* one\n two")).toEqual([[2,[[0,6]]],[3,[[0,4]]]]);
  });
  it("a raw string with a delimiter", () => {
    expect(nonCode("auto s = R\"cc(\n  int x = $v$;\n)cc\";\nint y;\n")).toEqual([[1,[[10,14]]],[2,[[0,14]]],[3,[[0,4]]]]);
  });
  it("the prefixes of a raw string", () => {
    expect(nonCode("a(u8R\"(x)\"); b(uR\"(y)\"); c(UR\"(z)\"); d(LR\"(w)\");\n")).toEqual([[1,[[5,10],[17,22],[29,34],[41,46]]]]);
  });
  it("a name ending in R before a quote", () => {
    expect(nonCode("FOOR\"(x)\"; int y; /* c */\n")).toEqual([[1,[[18,25]]]]);
  });
  it("a delimiter too long for a raw string", () => {
    expect(nonCode("R\"12345678901234567(x)12345678901234567\" /* c */\n")).toEqual([[1,[[41,48]]]]);
  });
  it("a delimiter with a space", () => {
    expect(nonCode("R\"a b(x)a b\" /* c */\n")).toEqual([[1,[[13,20]]]]);
  });
  it("an unterminated raw string", () => {
    expect(nonCode("int a;\nR\"(one\ntwo")).toEqual([[2,[[1,6]]],[3,[[0,3]]]]);
  });
  it("a quote in a character literal", () => {
    expect(nonCode("char q = '\"'; /* c */ char r = '\\''; /* d */\n")).toEqual([[1,[[14,21],[37,44]]]]);
  });
  it("a digit separator", () => {
    expect(nonCode("int n = 1'000'000; /* c */ char q = '/';\n")).toEqual([[1,[[19,26]]]]);
  });
  it("comment marks in a string", () => {
    expect(nonCode("const char* s = \"/* no */ // no\"; /* yes */\n")).toEqual([[1,[[34,43]]]]);
  });
  it("an escaped quote in a string", () => {
    expect(nonCode("const char* s = \"a\\\"/*b\"; /* yes */\n")).toEqual([[1,[[26,35]]]]);
  });
  it("a string left open at the line end", () => {
    expect(nonCode("const char* s = \"open /* no\nint x; /* yes */\n")).toEqual([[2,[[7,16]]]]);
  });
  it("raw string marks in a line comment", () => {
    expect(nonCode("// R\"( and /* are nothing here\nint x; /* yes */\n")).toEqual([[2,[[7,16]]]]);
  });
  it("a raw string inside a block comment", () => {
    expect(nonCode("/* R\"( */ int x; /* )\" */\n")).toEqual([[1,[[0,9],[17,25]]]]);
  });
  it("a comment and a raw string on one line", () => {
    expect(nonCode("f(R\"(a)\", /* b */ R\"x(c)x\"); // d\n")).toEqual([[1,[[3,8],[10,17],[19,26]]]]);
  });
});

describe('cppLiteralsBlanked', () => {
  it("nothing to blank", () => {
    expect(cppLiteralsBlanked("int a = 1;", 1, new Map())).toBe("int a = 1;");
  });
  it("a string", () => {
    expect(cppLiteralsBlanked("f(\"abc\", 1);", 1, new Map())).toBe("f(\"   \", 1);");
  });
  it("an escaped quote", () => {
    expect(cppLiteralsBlanked("f(\"a\\\"b\", 1);", 1, new Map())).toBe("f(\"    \", 1);");
  });
  it("a character literal", () => {
    expect(cppLiteralsBlanked("c = 'x'; d = '\\'';", 1, new Map())).toBe("c = ' '; d = '  ';");
  });
  it("a digit separator", () => {
    expect(cppLiteralsBlanked("n = 1'000; f(\"x\");", 1, new Map())).toBe("n = 1'000; f(\" \");");
  });
  it("a line comment ends the scan", () => {
    expect(cppLiteralsBlanked("f(\"a\"); // \"b\"", 1, new Map())).toBe("f(\" \"); // \"b\"");
  });
  it("a block comment on the line", () => {
    expect(cppLiteralsBlanked("f(\"a\"); /* \"b\" */ g(\"c\");", 1, new Map())).toBe("f(\" \"); /* \"b\" */ g(\" \");");
  });
  it("an open block comment ends the scan", () => {
    expect(cppLiteralsBlanked("f(\"a\"); /* \"b\"", 1, new Map())).toBe("f(\" \"); /* \"b\"");
  });
  it("a raw range", () => {
    expect(cppLiteralsBlanked("f(\"a\", R\"(b\"c)\", \"d\");", 1, new Map([[1, [[8,16]]]]))).toBe("f(\" \", R         \" \");");
  });
  it("a raw range over the whole line", () => {
    expect(cppLiteralsBlanked("\"a\" b 'c", 1, new Map([[1, [[0,9]]]]))).toBe("        ");
  });
  it("two raw ranges", () => {
    expect(cppLiteralsBlanked("x\"y\" z\"w\"", 1, new Map([[1, [[1,4],[6,9]]]]))).toBe("x    z   ");
  });
  it("a raw range past the end of the line", () => {
    expect(cppLiteralsBlanked("abc", 1, new Map([[1, [[1,99]]]]))).toBe("a  ");
  });
});
