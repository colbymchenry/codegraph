#include "tree_sitter/alloc.h"
#include "tree_sitter/array.h"
#include "tree_sitter/parser.h"

#include <string.h>

// #define DEBUG

#ifdef DEBUG
#define LOG(...) fprintf(stderr, __VA_ARGS__)
#else
#define LOG(...)
#endif

// Order must mirror the externals array in grammar.js exactly: tree-sitter
// couples the two by index.
enum TokenType {
  AUTOMATIC_SEMICOLON,
  INDENT,
  OUTDENT,
  COMMA_OUTDENT,
  SIMPLE_STRING_START,
  SIMPLE_STRING_MIDDLE,
  SIMPLE_MULTILINE_STRING_START,
  INTERPOLATED_STRING_MIDDLE,
  INTERPOLATED_MULTILINE_STRING_MIDDLE,
  RAW_STRING_START,
  RAW_STRING_MIDDLE,
  RAW_STRING_MULTILINE_MIDDLE,
  SINGLE_LINE_STRING_END,
  MULTILINE_STRING_END,
  ELSE,
  CATCH,
  FINALLY,
  EXTENDS,
  DERIVES,
  WITH,
  BLOCK_COMMENT,
  SUPPRESS_BLOCK_COMMENT,
  ERROR_SENTINEL,
  COLON_EOL,
  POSTFIX_OP,
  POSTFIX_STAR,
  FLOATING_POINT_WITH_SEPARATORS,
  END_KEYWORD,
  // Zero-width, emitted right before a control-tail keyword (catch, finally,
  // else, then, or yield) where the grammar allows one, so construct bodies
  // share one follow column instead of per-keyword ones.
  CONTROL_TAIL_GATE,
  XML_TAG_START,
  ERASED_MODIFIER,
  OPEN_MODIFIER,
  OPAQUE_MODIFIER,
  INFIX_MODIFIER,
  TRACKED_MODIFIER,
  TRANSPARENT_MODIFIER,
  INLINE_MODIFIER,
  INTO_MODIFIER,
  UPDATE_MODIFIER,
  CONSUME_MODIFIER,
  USES,
  OP_LEFT_OR,
  OP_LEFT_XOR,
  OP_LEFT_AND,
  OP_LEFT_EQ,
  OP_LEFT_REL,
  OP_LEFT_COLON,
  OP_LEFT_ADD,
  OP_LEFT_MUL,
  OP_LEFT_OTHER,
  OP_NAME,
  USING_DIRECTIVE_START
};

// Mirrors enum TokenType above.
const char* token_name[] = {
  "AUTOMATIC_SEMICOLON",
  "INDENT",
  "OUTDENT",
  "COMMA_OUTDENT",
  "SIMPLE_STRING_START",
  "SIMPLE_STRING_MIDDLE",
  "SIMPLE_MULTILINE_STRING_START",
  "INTERPOLATED_STRING_MIDDLE",
  "INTERPOLATED_MULTILINE_STRING_MIDDLE",
  "RAW_STRING_START",
  "RAW_STRING_MIDDLE",
  "RAW_STRING_MULTILINE_MIDDLE",
  "SINGLE_LINE_STRING_END",
  "MULTILINE_STRING_END",
  "ELSE",
  "CATCH",
  "FINALLY",
  "EXTENDS",
  "DERIVES",
  "WITH",
  "BLOCK_COMMENT",
  "SUPPRESS_BLOCK_COMMENT",
  "ERROR_SENTINEL",
  "COLON_EOL",
  "POSTFIX_OP",
  "POSTFIX_STAR",
  "FLOATING_POINT_WITH_SEPARATORS",
  "END_KEYWORD",
  "CONTROL_TAIL_GATE",
  "XML_TAG_START",
  "ERASED_MODIFIER",
  "OPEN_MODIFIER",
  "OPAQUE_MODIFIER",
  "INFIX_MODIFIER",
  "TRACKED_MODIFIER",
  "TRANSPARENT_MODIFIER",
  "INLINE_MODIFIER",
  "INTO_MODIFIER",
  "UPDATE_MODIFIER",
  "CONSUME_MODIFIER",
  "USES",
  "OP_LEFT_OR",
  "OP_LEFT_XOR",
  "OP_LEFT_AND",
  "OP_LEFT_EQ",
  "OP_LEFT_REL",
  "OP_LEFT_COLON",
  "OP_LEFT_ADD",
  "OP_LEFT_MUL",
  "OP_LEFT_OTHER",
  "OP_NAME",
  "USING_DIRECTIVE_START"
};

typedef struct {
  Array(int16_t) indents;
  int16_t last_indentation_size;
  int16_t last_newline_count;
  int16_t last_column;
  // The lookahead at the position last_column names. Two lines can share a
  // column, so the character keeps the saved newline from being recovered at
  // an unrelated position further down.
  int16_t last_char;
  int16_t after_colon_eol;
} Scanner;

void *tree_sitter_scala_external_scanner_create() {
  Scanner *scanner = ts_calloc(1, sizeof(Scanner));
  array_init(&scanner->indents);
  scanner->last_indentation_size = -1;
  scanner->last_column = -1;
  return scanner;
}

void tree_sitter_scala_external_scanner_destroy(void *payload) {
  Scanner *scanner = payload;
  array_delete(&scanner->indents);
  ts_free(scanner);
}

unsigned tree_sitter_scala_external_scanner_serialize(void *payload, char *buffer) {
  Scanner *scanner = (Scanner*)payload;

  if ((scanner->indents.size + 5) * sizeof(int16_t) > TREE_SITTER_SERIALIZATION_BUFFER_SIZE) {
    return 0;
  }

  size_t size = 0;
  memcpy(buffer + size, &scanner->last_indentation_size, sizeof(int16_t));
  size += sizeof(int16_t);
  memcpy(buffer + size, &scanner->last_newline_count, sizeof(int16_t));
  size += sizeof(int16_t);
  memcpy(buffer + size, &scanner->last_column, sizeof(int16_t));
  size += sizeof(int16_t);
  memcpy(buffer + size, &scanner->last_char, sizeof(int16_t));
  size += sizeof(int16_t);
  memcpy(buffer + size, &scanner->after_colon_eol, sizeof(int16_t));
  size += sizeof(int16_t);

  for (unsigned i = 0; i < scanner->indents.size; i++) {
    memcpy(buffer + size, &scanner->indents.contents[i], sizeof(int16_t));
    size += sizeof(int16_t);
  }

  return size;
}

void tree_sitter_scala_external_scanner_deserialize(void *payload, const char *buffer,
                                                    unsigned length) {
  Scanner *scanner = (Scanner*)payload;
  array_clear(&scanner->indents);
  scanner->last_indentation_size = -1;
  scanner->last_column = -1;
  scanner->last_char = 0;
  scanner->last_newline_count = 0;
  scanner->after_colon_eol = 0;

  if (length == 0) {
    return;
  }

  size_t size = 0;

  scanner->last_indentation_size = *(int16_t *)&buffer[size];
  size += sizeof(int16_t);
  scanner->last_newline_count = *(int16_t *)&buffer[size];
  size += sizeof(int16_t);
  scanner->last_column = *(int16_t *)&buffer[size];
  size += sizeof(int16_t);
  scanner->last_char = *(int16_t *)&buffer[size];
  size += sizeof(int16_t);
  scanner->after_colon_eol = *(int16_t *)&buffer[size];
  size += sizeof(int16_t);

  unsigned count = (length - (unsigned)size) / sizeof(int16_t);
  if (count > 0) {
    array_reserve(&scanner->indents, count);
    memcpy(scanner->indents.contents, &buffer[size], count * sizeof(int16_t));
    scanner->indents.size = count;
  }
}

// The C locale sets of iswspace, iswalpha and iswalnum, spelled out. No locale
// is ever installed here, and the library calls showed up in the parse profile.
static inline bool is_space(int32_t c) {
  return c == ' ' || (c >= '\t' && c <= '\r');
}

static inline bool is_alpha(int32_t c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
}

static inline bool is_alnum(int32_t c) {
  return is_alpha(c) || (c >= '0' && c <= '9');
}

static inline void advance(TSLexer *lexer) { lexer->advance(lexer, false); }

static inline void skip(TSLexer *lexer) { lexer->advance(lexer, true); }

static bool advance_past_blanks(TSLexer *lexer) {
  bool found = false;
  while (lexer->lookahead == ' ' || lexer->lookahead == '\t') {
    advance(lexer);
    found = true;
  }
  return found;
}

// Marks an indent region whose `case` clauses align with their `match`/`catch`
// (Scala 3 same-width case). Such a region also closes on a same-width line
// that is not another `case` clause. The flag is packed into the int16 width.
#define CASE_INDENT_FLAG ((int16_t)0x4000)

static inline int16_t indent_width(int16_t entry) {
  return entry == -1 ? -1 : (int16_t)(entry & 0x3FFF);
}

// Does a line at `width` sit exactly at the width of a flagged same-width
// case region `prev`? Shared by every close site of such regions.
static inline bool at_case_region_width(int16_t prev, int16_t width) {
  return prev != -1 && (prev & CASE_INDENT_FLAG) && width == indent_width(prev);
}

// ASCII opchars, deliberately without `/`, which could open a comment. An
// operator starting with `/` or a Unicode opchar never takes the external
// layout paths gated on this; the internal operator tokens handle it.
// See: https://www.scala-lang.org/api/3.x/docs/changed-features/operators.html
static bool is_op_char(int32_t c) {
  switch (c) {
    case '!': case '#': case '%': case '&':
    case '*': case '+': case '-': case '<':
    case '=': case '>': case '?': case '@':
    case '\\': case '^': case '|': case '~':
    case ':':
      return true;
    default:
      return false;
  }
}

// SLS 6.12.3 gives an operator its precedence by its first character. An
// operator ending in `/` is never right-associative and never an assignment,
// so the left-associative class is the whole answer. The partition matches
// OP_TOKEN in grammar.js, whose first-character sets it has to agree with.
// `/` is absent because is_op_char rejects it, so no caller can pass one.
static enum TokenType op_left_class(int32_t first) {
  switch (first) {
    case '|': return OP_LEFT_OR;
    case '^': return OP_LEFT_XOR;
    case '&': return OP_LEFT_AND;
    case '=': case '!': return OP_LEFT_EQ;
    case '<': case '>': return OP_LEFT_REL;
    case ':': return OP_LEFT_COLON;
    case '+': case '-': return OP_LEFT_ADD;
    case '*': case '%': return OP_LEFT_MUL;
    default: return OP_LEFT_OTHER;
  }
}

// Mirrors the start class of XML_NAME in grammar.js. Every non-ASCII
// character is accepted, since the letter test is ASCII-only and the internal
// lexer rejects the name if it is not a letter after all.
static bool is_xml_name_start(int32_t c) {
  return is_alpha(c) || c == '_' || c > 127;
}

// An operator directly before one of these ends its expression, so no right
// operand can follow and the operator is postfix.
static bool is_close_or_separator(int32_t c) {
  return c == ')' || c == ']' || c == '}' || c == ',' || c == ';';
}

// We enumerate 3 types of strings that we need to handle differently:
// 1. Simple strings, `"..."` or `"""..."""`
// 2. Interpolated strings, `s"..."` or `f"..."` or `foo"..."` or foo"""...""".
// 3. Raw strings, `raw"..."`
typedef enum {
  STRING_MODE_SIMPLE,
  STRING_MODE_INTERPOLATED,
  STRING_MODE_RAW
} StringMode;

static bool scan_string_content(TSLexer *lexer, bool is_multiline, StringMode string_mode) {
  LOG("scan_string_content(%d, %d, %c)\n", is_multiline, string_mode, lexer->lookahead);
  unsigned closing_quote_count = 0;
  for (;;) {
    if (lexer->lookahead == '"') {
      advance(lexer);
      closing_quote_count++;
      if (!is_multiline) {
        lexer->result_symbol = SINGLE_LINE_STRING_END;
        lexer->mark_end(lexer);
        return true;
      }
      if (closing_quote_count >= 3 && lexer->lookahead != '"') {
        lexer->result_symbol = MULTILINE_STRING_END;
        lexer->mark_end(lexer);
        return true;
      }
    } else if (lexer->lookahead == '$' && string_mode != STRING_MODE_SIMPLE) {
      switch (string_mode) {
        case STRING_MODE_INTERPOLATED:
          lexer->result_symbol = is_multiline ? INTERPOLATED_MULTILINE_STRING_MIDDLE : INTERPOLATED_STRING_MIDDLE;
          break;
        case STRING_MODE_RAW:
          lexer->result_symbol = is_multiline ? RAW_STRING_MULTILINE_MIDDLE : RAW_STRING_MIDDLE;
          break;
        default:
          assert(false);          
      }
      lexer->mark_end(lexer);
      return true;
    } else {
      closing_quote_count = 0;
      if (lexer->lookahead == '\\') {
        // Multiline strings ignore escape sequences
        if (is_multiline || string_mode == STRING_MODE_RAW) {
          // FIXME: In raw string mode, we have to jump over escaped quotes.
          advance(lexer);
          // In single-line raw strings, `\"` is not translated to `"`, but it also does
          // not close the string. Likewise, `\\` is not translated to `\`, but it does
          // stop the second `\` from stopping a double-quote from closing the string.
          if (!is_multiline && string_mode == STRING_MODE_RAW && 
            (lexer->lookahead == '"' || lexer->lookahead == '\\')) {
            advance(lexer);
          }
        } else {
          lexer->result_symbol = string_mode == STRING_MODE_SIMPLE ? SIMPLE_STRING_MIDDLE : INTERPOLATED_STRING_MIDDLE;
          lexer->mark_end(lexer);
          return true;
        }
      // During error recovery and dynamic precedence resolution, the external 
      // scanner will be invoked with all valid_symbols set to true, which means
      // we will be asked to scan a string token when we are not actually in a 
      // string context. Here we detect these cases and return false.
      } else if (lexer->lookahead == '\n' && !is_multiline) {
        return false;
      } else if (lexer->eof(lexer)) {
        return false;
      } else {
        advance(lexer);
      }
    }
  }
}

// Consumes a block comment body, nesting per SLS 1.4. The caller has consumed
// the leading "/*". With stop_at_newline it stops at the first newline.
// Returns whether the comment closed on the line it started on.
static bool consume_block_comment_body_ex(TSLexer *lexer, bool stop_at_newline) {
  unsigned depth = 1;
  while (depth > 0) {
    if (lexer->eof(lexer) || (stop_at_newline && lexer->lookahead == '\n')) {
      return false;
    }
    if (lexer->lookahead == '/') {
      advance(lexer);
      if (lexer->lookahead == '*') {
        advance(lexer);
        depth++;
      }
    } else if (lexer->lookahead == '*') {
      advance(lexer);
      if (lexer->lookahead == '/') {
        advance(lexer);
        depth--;
      }
    } else {
      advance(lexer);
    }
  }
  return true;
}

// Stops just past the matching "*/" (or at EOF).
static void consume_block_comment_body(TSLexer *lexer) {
  consume_block_comment_body_ex(lexer, false);
}

// Stops at a newline. Returns whether the comment ended on the line it
// started on. A comment crossing the line end means the line ends there.
static bool consume_block_comment_body_on_line(TSLexer *lexer) {
  return consume_block_comment_body_ex(lexer, true);
}

static bool finish_block_comment(TSLexer *lexer) {
  lexer->mark_end(lexer);
  lexer->result_symbol = BLOCK_COMMENT;
  LOG("    BLOCK_COMMENT\n");
  return true;
}

// The caller has consumed the leading "/*".
static bool lex_block_comment(TSLexer *lexer) {
  consume_block_comment_body(lexer);
  return finish_block_comment(lexer);
}

static bool scan_word(TSLexer *lexer, const char* const word) {
  for (uint8_t i = 0; word[i] != '\0'; i++) {
    if (lexer->lookahead != word[i]) {
      return false;
    }
    advance(lexer);
  }
  // `match_` must not match the keyword `match`.
  return !(is_alnum(lexer->lookahead) || lexer->lookahead == '_' ||
           lexer->lookahead == '$');
}

// Reads one identifier-like word into `buf`. Returns -1 when the word
// cannot be an ASCII keyword. The whole word is always consumed, so a
// failed keyword check never leaves the lexer mid-identifier.
static int read_word(TSLexer *lexer, char *buf, int cap) {
  int len = 0;
  bool not_keyword = false;
  while (is_alnum(lexer->lookahead) || lexer->lookahead == '_' ||
         lexer->lookahead == '$') {
    if (lexer->lookahead > 127 || len >= cap - 1) {
      not_keyword = true;
    } else {
      buf[len] = (char)lexer->lookahead;
      len++;
    }
    advance(lexer);
  }
  buf[len] = '\0';
  return not_keyword ? -1 : len;
}

static bool word_in(const char *word, const char *const words[],
                    unsigned count) {
  for (unsigned i = 0; i < count; i++) {
    if (strcmp(word, words[i]) == 0) {
      return true;
    }
  }
  return false;
}

// Whether a name follows the word just read, which is what makes an `end`
// tag a marker and an `open` a modifier. Block comments in between are
// transparent, as they are to the parser.
static void skip_blanks_and_block_comments(TSLexer *lexer) {
  for (;;) {
    advance_past_blanks(lexer);
    if (lexer->lookahead != '/') {
      return;
    }
    advance(lexer);
    if (lexer->lookahead != '*') {
      return;
    }
    advance(lexer);
    consume_block_comment_body(lexer);
  }
}

static bool name_follows_word(TSLexer *lexer) {
  skip_blanks_and_block_comments(lexer);
  return is_alpha(lexer->lookahead) || lexer->lookahead == '_' ||
         lexer->lookahead == '$' || lexer->lookahead == '`' ||
         lexer->lookahead > 127;
}

// The words that continue the expression before them instead of starting one.
// `if` is missing on purpose, since it does start one. A word longer than the
// buffer reads as -1, so grow the buffer along with the table.
static bool word_is_expression_tail(TSLexer *lexer) {
  static const char *const expression_tails[] = {
      "match", "catch", "finally", "else", "then",
      "do",    "yield", "while",   "with", "extends"};
  char word[sizeof "finally"];
  int len = read_word(lexer, word, (int)sizeof word);
  return len > 0 && word_in(word, expression_tails,
                            sizeof(expression_tails) /
                                sizeof(expression_tails[0]));
}

// No modifier precedes such a word, so `update match` stays a plain name. A
// definition keyword does follow one (`inline val`), which is why the two
// readers below keep their own names over the one table.
static bool modifier_word_allowed(TSLexer *lexer) {
  return !word_is_expression_tail(lexer);
}

// The right operand of an operator has to start an expression, so `??? match`
// on its own line is a statement rather than the tail of the line above.
static bool operand_word_allowed(TSLexer *lexer) {
  return !word_is_expression_tail(lexer);
}

static bool modifier_name_follows(TSLexer *lexer) {
  return name_follows_word(lexer) && modifier_word_allowed(lexer);
}

// `inline` also prefixes the scrutinee of `inline 1 match`, and it can end a
// modifier line whose definition is on the next one.
static bool inline_modifier_follows(TSLexer *lexer) {
  if (name_follows_word(lexer)) {
    return modifier_word_allowed(lexer);
  }
  // A scrutinee starts an expression. See canStartExprTokens in the
  // reference parser.
  if ((lexer->lookahead >= '0' && lexer->lookahead <= '9') ||
      lexer->lookahead == '"' || lexer->lookahead == '\'' ||
      lexer->lookahead == '(' || lexer->lookahead == '{' ||
      lexer->lookahead == '-') {
    return true;
  }
  if (lexer->lookahead != '\n' && lexer->lookahead != '\r') {
    return false;
  }
  while (is_space(lexer->lookahead)) {
    advance(lexer);
  }
  // Across a line break only a reserved word counts. A soft modifier there
  // would be a name too, and `val b = inline` followed by such a line is a
  // value rather than a modifier list.
  static const char *const definition_starts[] = {
      "def",     "val",       "var",    "type",     "given",    "class",
      "object",  "trait",     "enum",   "final",    "lazy",     "override",
      "private", "protected", "sealed", "abstract", "implicit"};
  char word[sizeof "transparent"];
  int len = read_word(lexer, word, (int)sizeof word);
  return len > 0 &&
         word_in(word, definition_starts,
                 sizeof(definition_starts) / sizeof(definition_starts[0]));
}

// True when `class` or `object` follows `case`, marking a definition not a
// clause. Reads the whole word so an identifier like `cobject` is not misread
// as `c` plus `object` by chained scan_word calls. Advances the lexer.
static bool is_case_definition_word(TSLexer *lexer) {
  advance_past_blanks(lexer);
  char word[sizeof "object"];
  int len = read_word(lexer, word, (int)sizeof word);
  return len > 0 &&
         (strcmp(word, "class") == 0 || strcmp(word, "object") == 0);
}

// True when the line starts a `case` clause and not a `case class`/`case
// object` definition. Advances the lexer. The caller must have called
// mark_end already, or must return false.
static bool is_case_clause_intro(TSLexer *lexer) {
  return scan_word(lexer, "case") && !is_case_definition_word(lexer);
}

// Result of looking for a comment at a layout boundary (INDENT/OUTDENT).
typedef enum {
  COMMENT_NONE,   // not a comment; the lexer may have advanced past a lone '/'
  COMMENT_LEXED,  // a block comment was lexed as BLOCK_COMMENT: return true
  COMMENT_ABORT,  // a comment starts here: give up on the layout token
  COMMENT_SAME_LINE_CODE,  // comments skipped, code follows on the same
                           // line and its column is the indentation
} CommentAtLayout;

// Comments must not affect indentation. Block comments have to be lexed
// here because the internal lexer no longer knows them.
static CommentAtLayout check_comment_at_layout(TSLexer *lexer,
                                               const bool *valid_symbols) {
  if (lexer->lookahead != '/') {
    return COMMENT_NONE;
  }
  advance(lexer);
  if (lexer->lookahead == '*' && valid_symbols[BLOCK_COMMENT]) {
    advance(lexer);
    for (;;) {
      consume_block_comment_body(lexer);
      advance_past_blanks(lexer);
      if (lexer->eof(lexer) || lexer->lookahead == '\n' ||
          lexer->lookahead == '\r') {
        finish_block_comment(lexer);
        return COMMENT_LEXED;
      }
      if (lexer->lookahead == '/') {
        advance(lexer);
        if (lexer->lookahead == '*') {
          advance(lexer);
          continue;  // another block comment on the same line
        }
        if (lexer->lookahead == '/') {
          // The extent cannot be re-marked back, so consume the trailing
          // line comment into the comment token.
          while (!lexer->eof(lexer) && lexer->lookahead != '\n') {
            advance(lexer);
          }
          finish_block_comment(lexer);
          return COMMENT_LEXED;
        }
        // A lone '/' is code. The off-by-one column is harmless.
        return COMMENT_SAME_LINE_CODE;
      }
      return COMMENT_SAME_LINE_CODE;
    }
  }
  if (lexer->lookahead == '/' || lexer->lookahead == '*') {
    return COMMENT_ABORT;
  }
  // A lone '/' is not a comment. The lexer stays advanced past it.
  return COMMENT_NONE;
}

// Skips a delimited body (a string or a back-ticked identifier) whose opening
// delimiter the caller has consumed. Stops after the closing `close` or at
// EOL/EOF. With escapes, a backslash escapes the next character.
static void skip_delimited(TSLexer *lexer, int32_t close, bool escapes) {
  while (!lexer->eof(lexer) && lexer->lookahead != close &&
         lexer->lookahead != '\n') {
    if (escapes && lexer->lookahead == '\\') {
      advance(lexer);
    }
    advance(lexer);
  }
  if (lexer->lookahead == close) {
    advance(lexer);
  }
}

// After an opening `'`. A character literal reveals no code and returns 0. A
// quote reveals its first character, which the caller still needs for bracket
// depth, so that character is returned instead.
static int32_t skip_char_or_quote_tail(TSLexer *lexer) {
  if (lexer->lookahead == '\\') {
    advance(lexer);
    if (!lexer->eof(lexer) && lexer->lookahead != '\n') {
      advance(lexer);
    }
    if (lexer->lookahead == '\'') {
      advance(lexer);
    }
    return 0;
  }
  if (lexer->eof(lexer) || lexer->lookahead == '\n') {
    return 0;
  }
  int32_t quoted = lexer->lookahead;
  advance(lexer);
  if (lexer->lookahead == '\'') {
    advance(lexer);  // a character literal: `quoted` was not code
    return 0;
  }
  return quoted;
}

// Whether the rest of the line holds only blanks and comments. A comment
// running past the line end still counts as blank because comments are
// transparent to scalac, but code after a closed block comment does not.
static bool rest_of_line_is_blank_or_comments(TSLexer *lexer) {
  for (;;) {
    advance_past_blanks(lexer);
    if (lexer->eof(lexer) || lexer->lookahead == '\n' ||
        lexer->lookahead == '\r') {
      return true;
    }
    if (lexer->lookahead != '/') {
      return false;
    }
    advance(lexer);
    if (lexer->lookahead == '/') {
      while (!lexer->eof(lexer) && lexer->lookahead != '\n') {
        advance(lexer);
      }
      return true;
    }
    if (lexer->lookahead != '*') {
      return false;  // a lone '/' is code
    }
    advance(lexer);
    if (!consume_block_comment_body_on_line(lexer)) {
      return true;  // the comment runs past the line end
    }
  }
}

// Whether a real operand follows the operator. Comments and line breaks are
// transparent, so scalac reads the next real token across them. A comment-only
// tail to EOF, a closing delimiter and a list separator are all no operand.
static bool has_operand(TSLexer *lexer) {
  for (;;) {
    if (lexer->eof(lexer)) {
      return false;
    }
    if (is_space(lexer->lookahead)) {
      advance(lexer);
      continue;
    }
    if (lexer->lookahead != '/') {
      return !is_close_or_separator(lexer->lookahead);
    }
    advance(lexer);
    if (lexer->lookahead == '/') {
      while (!lexer->eof(lexer) && lexer->lookahead != '\n') {
        advance(lexer);
      }
      continue;
    }
    if (lexer->lookahead != '*') {
      return true;  // a lone '/' is code
    }
    advance(lexer);
    consume_block_comment_body(lexer);
  }
}

// Blanks and then something that can be the right operand.
static bool operand_follows(TSLexer *lexer) {
  return advance_past_blanks(lexer) && has_operand(lexer) &&
         operand_word_allowed(lexer);
}

// Returns true if the lookahead starts a leading infix operator — a symbolic
// operator or back-ticked identifier followed by whitespace and then an
// operand. Such a line is a continuation of the previous expression, so
// neither AUTOMATIC_SEMICOLON nor OUTDENT should fire ahead of it. Advances
// the lexer; the caller must not rely on position.
static bool is_leading_infix_continuation(TSLexer *lexer) {
  if (is_op_char(lexer->lookahead)) {
    advance(lexer);
    while (is_op_char(lexer->lookahead)) {
      advance(lexer);
    }
    return operand_follows(lexer);
  }
  if (lexer->lookahead == '`') {
    advance(lexer);
    while (lexer->lookahead != '`' && !lexer->eof(lexer)) {
      advance(lexer);
    }
    if (lexer->lookahead != '`') {
      return false;
    }
    advance(lexer);
    return operand_follows(lexer);
  }
  return false;
}

// Walks the rest of the line, tracking bracket depth and skipping strings,
// characters, back-ticks and comments. Reports whether the line ends in a
// depth-0 `then`/`do` and whether it carries a depth-0 `=>` (Scala 2 `⇒`).
typedef struct {
  bool ends_conditional;
  bool has_case_arrow;
  bool closes_bracket;
} LineScan;

static LineScan scan_rest_of_line(TSLexer *lexer) {
  int depth = 0;
  LineScan r = {false, false, false};
  while (!lexer->eof(lexer) && lexer->lookahead != '\n' &&
         lexer->lookahead != '\r') {
    int32_t c = lexer->lookahead;
    if (c == ' ' || c == '\t') {
      advance(lexer);
    } else if (c == '(' || c == '[' || c == '{') {
      depth++;
      r.ends_conditional = false;
      advance(lexer);
    } else if (c == ')' || c == ']' || c == '}') {
      depth--;
      if (depth < 0) {
        r.closes_bracket = true;
      }
      r.ends_conditional = false;
      advance(lexer);
    } else if (c == '"' || c == '`') {
      // A string or a back-ticked identifier; only a string honours escapes.
      r.ends_conditional = false;
      advance(lexer);
      skip_delimited(lexer, c, c == '"');
    } else if (c == '\'') {
      r.ends_conditional = false;
      advance(lexer);
      int32_t quoted = skip_char_or_quote_tail(lexer);
      if (quoted == '(' || quoted == '[' || quoted == '{') {
        depth++;
      } else if (quoted == ')' || quoted == ']' || quoted == '}') {
        depth--;
      }
    } else if (c == '/') {
      advance(lexer);
      if (lexer->lookahead == '/') {
        break;  // rest of the line is a comment
      }
      if (lexer->lookahead == '*') {
        advance(lexer);
        if (!consume_block_comment_body_on_line(lexer)) {
          break;  // the comment runs past the line end
        }
      } else {
        r.ends_conditional = false;  // a lone '/' is code
      }
    } else if (c == 0x21D2) {  // `⇒`, the Scala 2 spelling of `=>`
      if (depth == 0) {
        r.has_case_arrow = true;
      }
      r.ends_conditional = false;
      advance(lexer);
    } else if (is_op_char(c)) {
      bool starts_eq = c == '=';
      advance(lexer);
      bool second_gt = lexer->lookahead == '>';
      int extra = 0;
      while (is_op_char(lexer->lookahead)) {
        advance(lexer);
        extra++;
      }
      // A plain `=>` at depth 0, not `==>` or `=>>`.
      if (depth == 0 && starts_eq && second_gt && extra == 1) {
        r.has_case_arrow = true;
      }
      r.ends_conditional = false;
    } else if (is_alpha(c) || c == '_' || c == '$') {
      char word[sizeof "then"];
      int len = read_word(lexer, word, (int)sizeof word);
      r.ends_conditional = depth == 0 && len > 0 &&
                           (strcmp(word, "then") == 0 || strcmp(word, "do") == 0);
    } else {
      r.ends_conditional = false;
      advance(lexer);
    }
  }
  return r;
}

// Consumes `digit (digit | '_' digit)*`. Sets *saw_sep if a separator appears.
static bool consume_digit_group(TSLexer *lexer, bool *saw_sep) {
  if (lexer->lookahead < '0' || lexer->lookahead > '9') {
    return false;
  }
  advance(lexer);
  for (;;) {
    if (lexer->lookahead >= '0' && lexer->lookahead <= '9') {
      advance(lexer);
    } else if (lexer->lookahead == '_') {
      advance(lexer);
      if (lexer->lookahead < '0' || lexer->lookahead > '9') {
        return false;
      }
      if (saw_sep) {
        *saw_sep = true;
      }
      advance(lexer);
    } else {
      return true;
    }
  }
}

// Lexes a floating point literal whose integer part uses digit separators, e.g.
// `1_000.5`. The internal regex cannot. After an underscore-containing group
// its DFA loses the transition to the following `.`.
static bool scan_float_with_separator(TSLexer *lexer) {
  bool int_sep = false;
  if (!consume_digit_group(lexer, &int_sep)) {
    return false;
  }
  // Only the integer-part separator is ours. Without one the internal lexer
  // lexes the number, so bail before walking the fraction and exponent.
  if (!int_sep) {
    return false;
  }
  bool is_float = false;
  if (lexer->lookahead == '.') {
    advance(lexer);
    if (!consume_digit_group(lexer, NULL)) {
      return false;
    }
    is_float = true;
  }
  if (lexer->lookahead == 'e' || lexer->lookahead == 'E') {
    advance(lexer);
    if (lexer->lookahead == '+' || lexer->lookahead == '-') {
      advance(lexer);
    }
    if (!consume_digit_group(lexer, NULL)) {
      return false;
    }
    is_float = true;
  }
  if (lexer->lookahead == 'd' || lexer->lookahead == 'D' ||
      lexer->lookahead == 'f' || lexer->lookahead == 'F') {
    advance(lexer);
    is_float = true;
  }
  // A bare integer with separators (`1_000`) is the internal lexer's job.
  if (!is_float) {
    return false;
  }
  lexer->mark_end(lexer);
  lexer->result_symbol = FLOATING_POINT_WITH_SEPARATORS;
  return true;
}

static inline void debug_indents(Scanner *scanner) {
  LOG("    indents(%d): ", scanner->indents.size);
  for (unsigned i = 0; i < scanner->indents.size; i++) {
    LOG("%d ", scanner->indents.contents[i]);
  }
  LOG("\n");
}

static bool scan_impl(void *payload, TSLexer *lexer,
                      const bool *valid_symbols);

bool tree_sitter_scala_external_scanner_scan(void *payload, TSLexer *lexer,
                                             const bool *valid_symbols) {
  Scanner *scanner = (Scanner *)payload;
  bool res = scan_impl(payload, lexer, valid_symbols);
  // Track whether the last returned token was a fewer-braces colon. Comments
  // in between keep the flag. A false return does not persist state anyway.
  if (res) {
    if (lexer->result_symbol == COLON_EOL) {
      scanner->after_colon_eol = 1;
    } else if (lexer->result_symbol != BLOCK_COMMENT) {
      scanner->after_colon_eol = 0;
    }
  }
  return res;
}

static bool scan_impl(void *payload, TSLexer *lexer,
                      const bool *valid_symbols) {
  #ifdef DEBUG
  {
    if (valid_symbols[ERROR_SENTINEL]) {
      LOG("entering tree_sitter_scala_external_scanner_scan. ERROR_SENTINEL is valid\n");
    } else {
      char debug_str[1024] = "entering tree_sitter_scala_external_scanner_scan valid symbols: ";
      for (unsigned i = 0; i < ERROR_SENTINEL; i++) {
        if (valid_symbols[i]) {
          strcat(debug_str, token_name[i]);
          strcat(debug_str, ", ");
        }
      }
      strcat(debug_str, "\n");
      LOG("%s", debug_str);
    }
  }
  #endif

  // The `>` of a using directive. It is immediate after the `//`, so this has
  // to run before the blanks are skipped below.
  if (valid_symbols[USING_DIRECTIVE_START] && !valid_symbols[ERROR_SENTINEL] &&
      lexer->lookahead == '>') {
    advance(lexer);
    lexer->mark_end(lexer);
    advance_past_blanks(lexer);
    if (!scan_word(lexer, "using")) {
      return false;
    }
    lexer->result_symbol = USING_DIRECTIVE_START;
    LOG("    USING_DIRECTIVE_START\n");
    return true;
  }

  Scanner *scanner = (Scanner *)payload;
  int16_t prev = scanner->indents.size > 0 ? *array_back(&scanner->indents) : -1;
  int16_t prev_width = indent_width(prev);
  int16_t newline_count = 0;
  int16_t indentation_size = 0;

  while (is_space(lexer->lookahead)) {
    if (lexer->lookahead == '\n') {
      newline_count++;
      indentation_size = 0;
    }
    else {
      indentation_size++;
    }
    skip(lexer);
  }

  // COMMA_OUTDENT is a distinct token so tree-sitter only makes it valid
  // where comma termination is expected (colon_argument,
  // _indentable_expression).
  if (valid_symbols[COMMA_OUTDENT] && lexer->lookahead == ',' && prev != -1) {
    lexer->mark_end(lexer);
    // Error recovery makes every symbol valid, so keep the eager pop there.
    if (!valid_symbols[ERROR_SENTINEL]) {
      advance(lexer);
      bool ends_line = false;
      for (;;) {
        advance_past_blanks(lexer);
        if (lexer->eof(lexer) || lexer->lookahead == '\n' ||
            lexer->lookahead == '\r') {
          ends_line = true;
          break;
        }
        if (lexer->lookahead != '/') {
          break;
        }
        advance(lexer);
        if (lexer->lookahead == '/') {
          ends_line = true;  // line comment runs to the line end
          break;
        }
        if (lexer->lookahead != '*') {
          break;  // a lone '/' is code
        }
        advance(lexer);
        consume_block_comment_body(lexer);
      }
      // A comma that ends its line closes the block. So does one whose line
      // goes on to close an enclosing bracket, since that comma separates
      // arguments. `import a.b, c.d` and `extends A, B` reach no such closer.
      if (!ends_line && !scan_rest_of_line(lexer).closes_bracket) {
        return false;
      }
    }
    if (scanner->indents.size > 0) {
      array_pop(&scanner->indents);
    }
    lexer->result_symbol = COMMA_OUTDENT;
    return true;
  }

  // Closes a same-width case region mid-cascade after a deeper region popped and
  // the line sits at this region's width. It stays open only for another `case`
  // clause, and returning false is safe because `case` is the only token that can
  // follow. The column check guards against a stale last_indentation_size when
  // intervening states emit no external token.
  if (valid_symbols[OUTDENT] && !valid_symbols[ERROR_SENTINEL] &&
      scanner->last_indentation_size != -1 &&
      at_case_region_width(prev, scanner->last_indentation_size) &&
      (lexer->eof(lexer)
           ? scanner->last_column == -1
           : (int16_t)lexer->get_column(lexer) == scanner->last_column)) {
    lexer->mark_end(lexer);
    if (is_case_clause_intro(lexer)) {
      return false;
    }
    array_pop(&scanner->indents);
    LOG("    pop\n");
    LOG("    OUTDENT (same-width case region, cascade)\n");
    lexer->result_symbol = OUTDENT;
    return true;
  }

  // Before advancing the lexer, check if we can double outdent
  if (
      valid_symbols[OUTDENT] &&
      (
        lexer->lookahead == 0 ||
        (
          prev != -1 &&
          (
            lexer->lookahead == ')' ||
            lexer->lookahead == ']' ||
            lexer->lookahead == '}'
          )
        ) ||
        (
          scanner->last_indentation_size != -1 &&
          prev != -1 &&
          scanner->last_indentation_size < prev_width
        )
      )
  ) {
    if (scanner->indents.size > 0) {
        array_pop(&scanner->indents);
    }
    LOG("    pop\n");
    LOG("    OUTDENT\n");
    lexer->result_symbol = OUTDENT;
    return true;
  }
  scanner->last_indentation_size = -1;

  // True when the line is deeper than the current region. An empty stack has
  // prev_width == -1, so any width counts as deeper. A same-width line right
  // after a fewer-braces colon also opens a block (the body may sit there).
  bool indent_geometry =
      indentation_size > prev_width ||
      (scanner->after_colon_eol && indentation_size == prev_width);
  if (
      valid_symbols[INDENT] &&
      newline_count > 0 &&
      // An indented block cannot start with a closing delimiter, e.g. the
      // `}` after an empty-bodied lambda: `foo { x =>` + newline + `}`.
      lexer->lookahead != '}' &&
      lexer->lookahead != ')' &&
      lexer->lookahead != ']' &&
      (
        indent_geometry ||
        // A comment at exactly the region width can hide a deeper line
        // behind it. Probe it and let the code's column decide below.
        (indentation_size == prev_width && lexer->lookahead == '/')
      )
  ) {
    lexer->mark_end(lexer);
    switch (check_comment_at_layout(lexer, valid_symbols)) {
      case COMMENT_LEXED: return true;
      case COMMENT_ABORT: return false;
      case COMMENT_SAME_LINE_CODE: {
        // The line's content starts after the comment; its column is the
        // effective indentation (`if x then` + `  /* c */ body`).
        int16_t effective = (int16_t)lexer->get_column(lexer);
        if (effective > prev_width) {
          indentation_size = effective;
          break;
        }
        // The code does not open a block after all, so lex the comment.
        return finish_block_comment(lexer);
      }
      case COMMENT_NONE:
        if (!indent_geometry) {
          return false;  // entered only to probe a comment; this is code
        }
        break;
    }
    // An indented block cannot start with else/catch/finally, nor with
    // yield/do, which belong to an enclosing `for (...)` whose body is also
    // indentable. Read the word whole so a partial match cannot mislead.
    int16_t entry = indentation_size;
    switch (lexer->lookahead) {
      case 'e': case 'c': case 'f': case 'y': case 'd': {
        static const char *const block_opening_stoppers[] = {
            "else", "catch", "finally", "yield", "do"};
        char word[sizeof "finally"];
        int len = read_word(lexer, word, (int)sizeof word);
        if (len > 0 &&
            word_in(word, block_opening_stoppers,
                    sizeof(block_opening_stoppers) /
                        sizeof(block_opening_stoppers[0]))) {
          // The keyword belongs to an enclosing construct. Where its gate is
          // valid and the word is a gated one, emit it (zero width: mark_end
          // ran above) so the keyword can shift; otherwise no block opens
          // here. `do` stays ungated: it can start a statement, and gate
          // validity blends in from unrelated GLR forks.
          static const char *const gated_stoppers[] = {"else", "catch",
                                                       "finally", "yield"};
          if (valid_symbols[CONTROL_TAIL_GATE] &&
              word_in(word, gated_stoppers,
                      sizeof(gated_stoppers) / sizeof(gated_stoppers[0]))) {
            lexer->result_symbol = CONTROL_TAIL_GATE;
            return true;
          }
          return false;
        }
        // At top level the stack is empty, so the same-width `case` close at
        // the bottom of scan() never sees a width-0 `match`/`case`. Flag the
        // region here instead. The arrow rules out an enum `case Foo`, which
        // has none and must not open a case region.
        if (scanner->indents.size == 0 && len == 4 &&
            strcmp(word, "case") == 0 && !is_case_definition_word(lexer) &&
            scan_rest_of_line(lexer).has_case_arrow) {
          entry |= CASE_INDENT_FLAG;
        }
        break;
      }
      case '|':
      case '&':
        // Nor with a leading `|`/`&` infix operator, which continues the
        // previous expression. Only these two run here, and not after a colon,
        // where the line can only be the body.
        if (!scanner->after_colon_eol && is_leading_infix_continuation(lexer)) {
          return false;
        }
        break;
      default:
        break;
    }
    array_push(&scanner->indents, entry);
    lexer->result_symbol = INDENT;
    LOG("    INDENT\n");
    return true;
  }

  // This saves the indentation_size and newline_count so it can be used
  // in subsequent calls for multiple outdent or auto-semicolon.
  // A same-width case region also closes on a line at its own width when
  // that line does not start another `case` clause.
  bool case_region_close =
      newline_count > 0 && at_case_region_width(prev, indentation_size);
  if (valid_symbols[OUTDENT] &&
      (lexer->lookahead == 0 ||
      (
        newline_count > 0 &&
        prev != -1 &&
        indentation_size < prev_width
      ) ||
      case_region_close
      )
  ) {
    lexer->mark_end(lexer);
    switch (check_comment_at_layout(lexer, valid_symbols)) {
      case COMMENT_LEXED: return true;
      case COMMENT_ABORT: return false;
      case COMMENT_SAME_LINE_CODE: {
        // The line's content starts after the comment; its column is the
        // effective indentation (` /** doc */ override def f...` inside a
        // braced body must not close the region at the comment's column).
        int16_t effective = (int16_t)lexer->get_column(lexer);
        if (effective < prev_width) {
          indentation_size = effective;
          break;
        }
        // Not an outdent after all. The automatic semicolon has its own
        // suppression rules, so lex the comment and let the next scan
        // decide, carrying the newline through the recovery below.
        scanner->last_newline_count = newline_count;
        scanner->last_column = effective;
        scanner->last_char = (int16_t)(lexer->lookahead & 0x7FFF);
        return finish_block_comment(lexer);
      }
      case COMMENT_NONE: break;
    }
    scanner->last_indentation_size = indentation_size;
    scanner->last_newline_count = newline_count;
    if (lexer->eof(lexer)) {
      scanner->last_column = -1;
      scanner->last_char = 0;
    } else {
      scanner->last_column = (int16_t)lexer->get_column(lexer);
      scanner->last_char = (int16_t)(lexer->lookahead & 0x7FFF);
    }
    // Keep the indented block open when the next line starts with a leading
    // infix operator, which continues the previous expression. But a line
    // ending in depth-0 `then`/`do` closes the regions up to its conditional.
    if (lexer->lookahead != 0 && is_leading_infix_continuation(lexer) &&
        !scan_rest_of_line(lexer).ends_conditional) {
      return false;
    }
    // A same-width `case` line continues the case region instead.
    if (case_region_close && is_case_clause_intro(lexer)) {
      return false;
    }
    if (scanner->indents.size > 0) {
      array_pop(&scanner->indents);
    }
    LOG("    pop\n");
    LOG("    OUTDENT\n");
    lexer->result_symbol = OUTDENT;
    return true;
  }

  // Recover newline_count from the outdent reset. Skipped when this scan
  // crossed a newline itself, because the saved count belongs to an
  // earlier line at the same column.
  // Nothing to recover when the count is zero, and get_column costs a rescan
  // of the line, so gate the whole test on it.
  if (scanner->last_newline_count > 0) {
    bool is_eof = lexer->eof(lexer);
    if (
        (is_eof && scanner->last_column == -1) ||
        (!is_eof && newline_count == 0 &&
         (int16_t)(lexer->lookahead & 0x7FFF) == scanner->last_char &&
         lexer->get_column(lexer) == (uint32_t)scanner->last_column)
    ) {
      newline_count += scanner->last_newline_count;
    }
  }
  scanner->last_newline_count = 0;

  // END_KEYWORD is only valid right after the semicolon the grammar puts
  // in front of a marker. Emit it when the tag word confirms the marker
  // shape.
  if (valid_symbols[END_KEYWORD] && !valid_symbols[ERROR_SENTINEL] &&
      lexer->lookahead == 'e') {
    if (scan_word(lexer, "end") && name_follows_word(lexer)) {
      lexer->mark_end(lexer);
      lexer->result_symbol = END_KEYWORD;
      return true;
    }
    return false;
  }

  if (valid_symbols[AUTOMATIC_SEMICOLON] && newline_count > 0) {
    // AUTOMATIC_SEMICOLON should not be issued in the middle of expressions
    // Thus, we exit this branch when encountering comments, else/catch clauses, etc.

    lexer->mark_end(lexer);
    lexer->result_symbol = AUTOMATIC_SEMICOLON;

    // Probably, a multi-line field expression, e.g.
    // a
    //  .b
    //  .c
    if (lexer->lookahead == '.') {
      return false;
    }

    // A statement never ends right before a closing bracket, and marker
    // slots would otherwise ask for a semicolon here.
    if (lexer->lookahead == ')' || lexer->lookahead == ']' ||
        lexer->lookahead == ',') {
      return false;
    }

    // Same, and it keeps a braced else-if chain from forking one marker
    // head per nested if. A `}` line that continues with more code
    // (`} | Mate`) keeps the semicolon and the old reading of its tail. A
    // trailing comment counts as the line end.
    if (lexer->lookahead == '}') {
      advance(lexer);
      for (;;) {
        advance_past_blanks(lexer);
        if (lexer->lookahead == '}' || lexer->lookahead == ')' ||
            lexer->lookahead == ']') {
          advance(lexer);
          continue;
        }
        if (lexer->lookahead == '/') {
          advance(lexer);
          if (lexer->lookahead == '/') {
            return false;
          }
          if (lexer->lookahead == '*') {
            advance(lexer);
            consume_block_comment_body(lexer);
            continue;
          }
        }
        break;
      }
      if (lexer->lookahead == '\n' || lexer->lookahead == '\r' ||
          lexer->eof(lexer)) {
        return false;
      }
      return true;
    }

    // Single-line and multi-line comments
    if (lexer->lookahead == '/') {
      advance(lexer);
      if (lexer->lookahead == '/') {
        return false;
      }
      if (lexer->lookahead == '*' && valid_symbols[BLOCK_COMMENT]) {
        advance(lexer);
        // The suppression rules must also see code after the comment
        // (`/* c */ else 2` must not be split). Lex the comment and carry
        // the pending newline to the next scan through the recovery above.
        consume_block_comment_body(lexer);
        advance_past_blanks(lexer);
        if (!(lexer->lookahead == '\n' || lexer->lookahead == '\r' ||
              lexer->eof(lexer))) {
          scanner->last_newline_count = newline_count;
          scanner->last_column = (int16_t)lexer->get_column(lexer);
          scanner->last_char = (int16_t)(lexer->lookahead & 0x7FFF);
        }
        return finish_block_comment(lexer);
      }
      // A lone '/' falls through with the lexer advanced past it, matching
      // the old flow.
    }

    // Checked before the keyword scans so neither reads a position the
    // other advanced past (`m|| x` after a failed `match` scan). A blank
    // line still separates the statements.
    if (is_op_char(lexer->lookahead) || lexer->lookahead == '`') {
      if (newline_count == 1 && is_leading_infix_continuation(lexer)) {
        return false;
      }
      return true;
    }

    // A keyword that continues the enclosing expression suppresses the
    // semicolon, even when several are valid at once. The first-character
    // dispatch keeps scan_word from consuming a shared prefix.
    switch (lexer->lookahead) {
      case 'e':
        if (!valid_symbols[ELSE] && !valid_symbols[EXTENDS] &&
            !valid_symbols[CONTROL_TAIL_GATE]) {
          break;
        }
        advance(lexer);
        if ((valid_symbols[ELSE] || valid_symbols[CONTROL_TAIL_GATE]) &&
            scan_word(lexer, "lse")) {
          // The gate is zero width: mark_end ran before the word.
          if (valid_symbols[CONTROL_TAIL_GATE]) {
            lexer->result_symbol = CONTROL_TAIL_GATE;
            return true;
          }
          return false;
        }
        if (valid_symbols[EXTENDS] && scan_word(lexer, "xtends")) {
          return false;
        }
        break;
      case 'c': {
        // Read the word whole: `catch` and `case` share a prefix that
        // chained scan_word calls cannot rewind.
        char word[sizeof "catch"];
        int len = read_word(lexer, word, (int)sizeof word);
        if (len <= 0) {
          break;
        }
        if ((valid_symbols[CATCH] || valid_symbols[CONTROL_TAIL_GATE]) &&
            strcmp(word, "catch") == 0) {
          if (valid_symbols[CONTROL_TAIL_GATE]) {
            lexer->result_symbol = CONTROL_TAIL_GATE;
            return true;
          }
          return false;
        }
        // A case clause line needs no separator, and suppressing it keeps
        // a long else-if chain from forking one marker head per nested if
        // right before it. A case definition keeps its separator, and so
        // does a clause line that closes an enclosing bracket, whose
        // separator belongs to the surrounding expression.
        if (strcmp(word, "case") == 0 && !is_case_definition_word(lexer)) {
          LineScan line = scan_rest_of_line(lexer);
          if (line.has_case_arrow && !line.closes_bracket) {
            return false;
          }
        }
        break;
      }
      case 'f':
        if ((valid_symbols[FINALLY] || valid_symbols[CONTROL_TAIL_GATE]) &&
            scan_word(lexer, "finally")) {
          if (valid_symbols[CONTROL_TAIL_GATE]) {
            lexer->result_symbol = CONTROL_TAIL_GATE;
            return true;
          }
          return false;
        }
        break;
      case 'w':
        if (valid_symbols[WITH] && scan_word(lexer, "with")) {
          return false;
        }
        break;
      case 'd':
        if (valid_symbols[DERIVES] && scan_word(lexer, "derives")) {
          return false;
        }
        break;
      case 'u':
        if (valid_symbols[USES] && scan_word(lexer, "uses")) {
          return false;
        }
        break;
      case 'm':
        // `match` is a reserved word that never starts a statement, so it
        // always continues the previous expression.
        if (scan_word(lexer, "match")) {
          return false;
        }
        break;
      default:
        break;
    }

    return true;
  }

  // An else/catch/finally that is not directly shiftable must first close the
  // open indented region (a dedented `else` after a braceless match closes it),
  // and `erased` is the modifier when a name follows. Both read the word, so it
  // is read once here. Skipped during error recovery, where every symbol looks
  // valid.
  static const char *const block_closing_words[] = {"else", "catch", "finally"};
  bool outdent_arm =
      valid_symbols[OUTDENT] &&
      !valid_symbols[CONTROL_TAIL_GATE] &&
      newline_count == 0 &&
      prev != -1 &&
      (
        (lexer->lookahead == 'e' && !valid_symbols[ELSE]) ||
        (lexer->lookahead == 'c' && !valid_symbols[CATCH]) ||
        (lexer->lookahead == 'f' && !valid_symbols[FINALLY])
      );
  // These are names too, and an alternative for each in every name position
  // cost the parse tables about 150KB per word. Lexing them here means the
  // parser only sees one where a modifier can stand.
  static const struct {
    char first;
    const char *word;
    TSSymbol symbol;
  } soft_modifiers[] = {
    {'e', "erased", ERASED_MODIFIER},
    {'o', "open", OPEN_MODIFIER},
    {'o', "opaque", OPAQUE_MODIFIER},
    {'i', "infix", INFIX_MODIFIER},
    {'t', "tracked", TRACKED_MODIFIER},
    {'t', "transparent", TRANSPARENT_MODIFIER},
    {'i', "inline", INLINE_MODIFIER},
    {'i', "into", INTO_MODIFIER},
    {'u', "update", UPDATE_MODIFIER},
    {'c', "consume", CONSUME_MODIFIER},
  };
  const unsigned soft_modifier_count =
      sizeof(soft_modifiers) / sizeof(soft_modifiers[0]);
  // Character first: it rules out most positions without the array load.
  bool modifier_arm = false;
  for (unsigned i = 0; i < soft_modifier_count; i++) {
    if (lexer->lookahead == soft_modifiers[i].first &&
        valid_symbols[soft_modifiers[i].symbol]) {
      modifier_arm = true;
      break;
    }
  }
  if (!valid_symbols[ERROR_SENTINEL] && (outdent_arm || modifier_arm)) {
    if (outdent_arm) {
      // OUTDENT is zero-width at the word, and the lexer cannot rewind once
      // read_word has consumed it.
      lexer->mark_end(lexer);
    }
    // Sized for the longest word above.
    char word[sizeof "transparent"];
    int len = read_word(lexer, word, (int)sizeof word);
    // read_word returns -1 when the word overflows the buffer, which would
    // otherwise leave a truncated prefix to compare against.
    if (len > 0) {
      TSSymbol modifier = 0;
      for (unsigned i = 0; i < soft_modifier_count; i++) {
        if (valid_symbols[soft_modifiers[i].symbol] &&
            strcmp(word, soft_modifiers[i].word) == 0) {
          modifier = soft_modifiers[i].symbol;
          break;
        }
      }
      if (modifier != 0) {
        // The modifier spans the word, unlike the zero-width OUTDENT.
        lexer->mark_end(lexer);
        // A name follows a modifier, so `def open(p)` and `a.infix` keep
        // reading as plain identifiers.
        bool follows = modifier == INLINE_MODIFIER
                           ? inline_modifier_follows(lexer)
                           : modifier_name_follows(lexer);
        if (follows) {
          lexer->result_symbol = modifier;
          return true;
        }
        return false;
      }
      if (outdent_arm &&
          word_in(word, block_closing_words,
                  sizeof(block_closing_words) / sizeof(block_closing_words[0]))) {
        if (scanner->indents.size > 0) {
          array_pop(&scanner->indents);
        }
        LOG("    pop\n");
        LOG("    OUTDENT (mid-line closing keyword)\n");
        lexer->result_symbol = OUTDENT;
        return true;
      }
    }
    // The lexer has advanced past the word; nothing else can match it.
    return false;
  }

  while (is_space(lexer->lookahead)) {
    if (lexer->lookahead == '\n') {
      newline_count++;
    }
    skip(lexer);
  }

  // XML mode (SLS §10) starts only where the grammar makes XML_TAG_START
  // valid and the `<` is immediately followed by a name-start character, so
  // `< b` and `<-`, `<:`, `<=` fall through to the regular operator tokens.
  if (valid_symbols[XML_TAG_START] && !valid_symbols[ERROR_SENTINEL] &&
      lexer->lookahead == '<') {
    advance(lexer);
    if (is_xml_name_start(lexer->lookahead)) {
      lexer->mark_end(lexer);
      lexer->result_symbol = XML_TAG_START;
      return true;
    }
    return false;
  }

  // A floating point literal whose integer part uses digit separators.
  if (valid_symbols[FLOATING_POINT_WITH_SEPARATORS] &&
      !valid_symbols[ERROR_SENTINEL] && lexer->lookahead >= '0' &&
      lexer->lookahead <= '9') {
    return scan_float_with_separator(lexer);
  }

  // A symbolic operator in postfix position is lexed here, as is the
  // fewer-braces colon. An operator that continues its expression, on the
  // same line or over a line break, stays with the internal per-class
  // tokens: since the postfix reading only exists through this branch, the
  // internal tokens admit no statement split after `left op`.
  // COLON_EOL only ever lexes a lone `:`, so that leg needs a colon first.
  // The branch also carries every operator ending in `/`, which the internal
  // tokens cannot express, so an operator class alone opens it too.
  if (!valid_symbols[ERROR_SENTINEL] && is_op_char(lexer->lookahead) &&
      ((valid_symbols[COLON_EOL] && lexer->lookahead == ':') ||
       valid_symbols[POSTFIX_OP] || valid_symbols[POSTFIX_STAR] ||
       valid_symbols[op_left_class(lexer->lookahead)] ||
       valid_symbols[OP_NAME])) {
    // Collect the operator. Only the first 3 chars are kept, since anything
    // longer cannot be one of the reserved sequences checked below. The
    // entry condition already checked the first character.
    char op[4] = {0};
    int op_len = 0;
    do {
      if (op_len < 3) {
        op[op_len] = (char)lexer->lookahead;
      }
      op_len++;
      advance(lexer);
    } while (is_op_char(lexer->lookahead));
    lexer->mark_end(lexer);
    // A `/` next carries the operator on, so the colon is not a lone one.
    if (op_len == 1 && op[0] == ':' && lexer->lookahead != '/') {
      // A lone `:` ending its line is the fewer-braces colon (scalac's
      // COLONeol). Deciding it at the token level kills the cross-newline
      // ascription fork that GLR would otherwise keep alive across the region.
      if (valid_symbols[COLON_EOL] &&
          rest_of_line_is_blank_or_comments(lexer)) {
        lexer->result_symbol = COLON_EOL;
        return true;
      }
      return false;
    }
    // An operator may end in `/` when that `/` does not open a comment. A
    // regex cannot see the character after it, so this is the only reading,
    // and the first character alone fixes the SLS 6.12.3 precedence class.
    // `#!` opens a script header, whose path is not part of an operator.
    bool shebang = op_len >= 2 && op[0] == '#' && op[1] == '!';
    enum TokenType op_class = op_left_class(op[0]);
    if (lexer->lookahead == '/' && !shebang &&
        (valid_symbols[op_class] || valid_symbols[OP_NAME])) {
      // One step per OP_STEP in grammar.js. A `/` is taken only when what
      // follows it cannot open a comment, so the token never needs to give
      // characters back and the end is marked once, on the way out.
      bool ends_in_slash = false;
      bool at_comment = false;
      while (!at_comment) {
        int32_t c = lexer->lookahead;
        if (c == '/') {
          advance(lexer);
          at_comment = lexer->lookahead == '/' || lexer->lookahead == '*';
        } else if (is_op_char(c)) {
          advance(lexer);
        } else {
          break;
        }
        ends_in_slash = !at_comment && c == '/';
      }
      // A Unicode opchar would carry the operator past what this reads, so
      // hand the whole token back to the internal lexer.
      if (ends_in_slash && lexer->lookahead < 0x80) {
        lexer->mark_end(lexer);
        lexer->result_symbol = valid_symbols[op_class] ? op_class : OP_NAME;
        return true;
      }
      return false;
    }
    // The branch is also entered for COLON_EOL-only states. Everything from
    // here on emits a postfix token, so bail out early where none is valid.
    enum TokenType postfix_sym =
        (op_len == 1 && op[0] == '*') ? POSTFIX_STAR : POSTFIX_OP;
    if (!valid_symbols[postfix_sym]) {
      return false;
    }
    // These sequences are not infix operators, so the line does not
    // continue. They mirror the grammar's reserved string tokens. Entries
    // must stay at most 3 characters, or op[] above must grow. The
    // first-character gate skips the scan for the common operators.
    if (op[0] == '=' || op[0] == '<' || op[0] == '>' || op[0] == '#' ||
        op[0] == '@' || op[0] == '?') {
      static const char *const reserved[] = {
          "=", "#", "@", "=>", "<-", "<:", ">:", "<%", "?=>", "=>>"};
      if (op_len <= 3 &&
          word_in(op, reserved, sizeof(reserved) / sizeof(reserved[0]))) {
        return false;
      }
    }
    // A trailing comment counts as the line end because scalac treats it as
    // transparent, so `p || // c` still continues on the next line.
    if (!rest_of_line_is_blank_or_comments(lexer)) {
      // Mid-line, the call left the lookahead at the next real character (or
      // just past a lone `/`). An operator directly before a closing
      // delimiter or a list separator is postfix: the vararg splice `f(xs*)`
      // or `(p | q.r +) ^^ t`. The external token makes the whole
      // lower-precedence chain reduce first, which the per-class infix
      // tokens would not allow.
      if (is_close_or_separator(lexer->lookahead)) {
        lexer->result_symbol = postfix_sym;
        return true;
      }
      return false;
    }
    // The right operand must be able to start an expression. Comments and line
    // breaks before it are transparent. A comment-only tail to EOF is postfix.
    if (!has_operand(lexer)) {
      lexer->result_symbol = postfix_sym;
      return true;
    }
    // A `.` or a `=` next also ends the infix reading, but those lines read
    // best with the internal tokens, as before.
    if (lexer->lookahead == '.' || lexer->lookahead == '=') {
      return false;
    }
    // No expression starts with `@` either. The next line is an annotated
    // definition, so the operator was postfix (`x --?` + `@deprecated val
    // y = 1`).
    if (lexer->lookahead == '@') {
      lexer->result_symbol = postfix_sym;
      return true;
    }
    // A next line starting with a definition or modifier keyword begins a new
    // statement, so the operator was postfix (`x --?` + `val y = ...`, Scala 2
    // postfixOps).
    if (lexer->lookahead >= 'a' && lexer->lookahead <= 'z') {
      // Hard keywords that can only begin a definition. Soft modifiers
      // (`inline`, `open`, `opaque`, `transparent`, `infix`) stay out: they
      // are ordinary identifiers, so such a line can be the right operand.
      static const char *const definition_words[] = {
          "abstract", "class", "def",    "enum",      "export", "final",
          "given",    "import", "implicit", "lazy",   "object", "override",
          "package",  "private", "protected", "sealed", "trait", "type",
          "val",      "var",
      };
      // Sized for the longest word above. read_word reports a longer or
      // non-ASCII identifier as -1, which correctly skips the check.
      char word[sizeof "protected"];
      int len = read_word(lexer, word, (int)sizeof word);
      if (len > 0 &&
          word_in(word, definition_words,
                  sizeof(definition_words) / sizeof(definition_words[0]))) {
        lexer->result_symbol = postfix_sym;
        return true;
      }
    }
    // Any other operand continues the expression, on this line or over the
    // break; the internal per-class token carries the operator's precedence.
    return false;
  }

  // Mid-line block comments with no layout decision pending. `/*` is plain
  // text where SUPPRESS_BLOCK_COMMENT or a string-content state is valid.
  // In error recovery all symbols look valid and lexing the comment is safe.
  if (valid_symbols[BLOCK_COMMENT] && lexer->lookahead == '/' &&
      (valid_symbols[ERROR_SENTINEL] ||
       !(valid_symbols[SUPPRESS_BLOCK_COMMENT] ||
         valid_symbols[SIMPLE_STRING_MIDDLE] ||
         valid_symbols[INTERPOLATED_STRING_MIDDLE] ||
         valid_symbols[RAW_STRING_MIDDLE] ||
         valid_symbols[RAW_STRING_MULTILINE_MIDDLE] ||
         valid_symbols[INTERPOLATED_MULTILINE_STRING_MIDDLE] ||
         valid_symbols[MULTILINE_STRING_END]))) {
    advance(lexer);
    if (lexer->lookahead == '*') {
      advance(lexer);
      return lex_block_comment(lexer);
    }
    // A lone '/' or a line comment. Nothing else external can match here.
    return false;
  }

  if (valid_symbols[SIMPLE_STRING_START] && lexer->lookahead == '"') {
    advance(lexer);
    lexer->mark_end(lexer);

    if (lexer->lookahead == '"') {
      advance(lexer);
      if (lexer->lookahead == '"') {
        advance(lexer);
        lexer->result_symbol = SIMPLE_MULTILINE_STRING_START;
        lexer->mark_end(lexer);
        return true;
      }
    }

    lexer->result_symbol = SIMPLE_STRING_START;
    return true;
  }

  // We need two tokens of lookahead to determine if we are parsing a raw string,
  // the `raw` and the `"`, which is why we need to do it in the external scanner.
  if (valid_symbols[RAW_STRING_START] && lexer->lookahead == 'r') {
    advance(lexer);
    if (lexer->lookahead == 'a') {
      advance(lexer);
      if (lexer->lookahead == 'w') {
        advance(lexer);
        if (lexer->lookahead == '"') {
          lexer->mark_end(lexer);
          lexer->result_symbol = RAW_STRING_START;
          return true;
        }
      }
    }
  }

  if (valid_symbols[SIMPLE_STRING_MIDDLE]) {
    return scan_string_content(lexer, false, STRING_MODE_SIMPLE);
  }

  if (valid_symbols[INTERPOLATED_STRING_MIDDLE]) {
    return scan_string_content(lexer, false, STRING_MODE_INTERPOLATED);
  }

  if (valid_symbols[RAW_STRING_MIDDLE]) {
    return scan_string_content(lexer, false, STRING_MODE_RAW);
  }

  if (valid_symbols[RAW_STRING_MULTILINE_MIDDLE]) {
    return scan_string_content(lexer, true, STRING_MODE_RAW);
  }  

  if (valid_symbols[INTERPOLATED_MULTILINE_STRING_MIDDLE]) {
    return scan_string_content(lexer, true, STRING_MODE_INTERPOLATED);
  }

  // We still need to handle the simple multiline string case, but there is
  // no `MULTILINE_STRING_MIDDLE` token, and `MULTILINE_STRING_END` is used
  // by all three of simple raw, and interpolated multiline strings. So this 
  // check needs to come after the `INTERPOLATED_MULTILINE_STRING_MIDDLE` and
  // `RAW_STRING_MULTILINE_MIDDLE` check, so that we can be sure we are in a 
  // simple multiline string context.
  if (valid_symbols[MULTILINE_STRING_END]) {
    return scan_string_content(lexer, true, STRING_MODE_SIMPLE);
  }

  // Scala 3 lets a `match`/`catch`'s `case` clauses align with the enclosing
  // region instead of indenting deeper. Open a flagged region so the OUTDENT
  // logic above closes it on a same-width non-case line. Only states after
  // `match`/`catch` or a case `=>` reach here, so no new grammar production is
  // needed. Returning false is safe because lookahead 'c' lets no other external
  // token fire.
  if (valid_symbols[INDENT] && !valid_symbols[ERROR_SENTINEL] &&
      newline_count > 0 && lexer->lookahead == 'c' &&
      prev != -1 && indentation_size == prev_width) {
    lexer->mark_end(lexer);
    if (is_case_clause_intro(lexer)) {
      array_push(&scanner->indents,
                 (int16_t)(indentation_size | CASE_INDENT_FLAG));
      lexer->result_symbol = INDENT;
      LOG("    INDENT (same-width case region)\n");
      return true;
    }
    // The word was not `case`. A `catch` at this width belongs to an
    // enclosing try. The `case` probe above stopped at its `t`, so the
    // remainder is `tch` (zero width: mark_end ran above).
    if (valid_symbols[CONTROL_TAIL_GATE] && scan_word(lexer, "tch")) {
      lexer->result_symbol = CONTROL_TAIL_GATE;
      return true;
    }
    return false;
  }

  // Zero-width gate before a control-tail keyword (see _control_tail_gate in
  // the grammar). Tails on the same line, and tails the semicolon machinery
  // never sees (inside parentheses, or after an emitted semicolon slot),
  // arrive here.
  if (valid_symbols[CONTROL_TAIL_GATE] && !valid_symbols[ERROR_SENTINEL]) {
    switch (lexer->lookahead) {
      case 'c': case 'e': case 'f': case 't': case 'y': {
        lexer->mark_end(lexer);
        // `do` and `while` stay ungated: they can start a statement, and
        // gate validity blends in from unrelated GLR forks.
        static const char *const tail_words[] = {
            "catch", "else", "finally", "then", "yield"};
        char word[sizeof "finally"];
        int len = read_word(lexer, word, (int)sizeof word);
        if (len > 0 &&
            word_in(word, tail_words,
                    sizeof(tail_words) / sizeof(tail_words[0]))) {
          lexer->result_symbol = CONTROL_TAIL_GATE;
          return true;
        }
        return false;
      }
      default:
        break;
    }
  }

  return false;
}

//
