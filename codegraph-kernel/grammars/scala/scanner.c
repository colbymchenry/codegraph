#include "tree_sitter/alloc.h"
#include "tree_sitter/array.h"
#include "tree_sitter/parser.h"

#include <wctype.h>

// #define DEBUG

#ifdef DEBUG
#define LOG(...) fprintf(stderr, __VA_ARGS__)
#else
#define LOG(...)
#endif

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
  ERROR_SENTINEL
};

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
  "ERROR_SENTINEL"
};

typedef struct {
  Array(int16_t) indents;
  int16_t last_indentation_size;
  int16_t last_newline_count;
  int16_t last_column;
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

  if ((scanner->indents.size + 3) * sizeof(int16_t) > TREE_SITTER_SERIALIZATION_BUFFER_SIZE) {
    return 0;
  }

  size_t size = 0;
  memcpy(buffer + size, &scanner->last_indentation_size, sizeof(int16_t));
  size += sizeof(int16_t);
  memcpy(buffer + size, &scanner->last_newline_count, sizeof(int16_t));
  size += sizeof(int16_t);
  memcpy(buffer + size, &scanner->last_column, sizeof(int16_t));
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
  scanner->last_newline_count = 0;

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

  while (size < length) {
    array_push(&scanner->indents, *(int16_t *)&buffer[size]);
    size += sizeof(int16_t);
  }

  assert(size == length);
}

static inline void advance(TSLexer *lexer) { lexer->advance(lexer, false); }

static inline void skip(TSLexer *lexer) { lexer->advance(lexer, true); }

// Used to detect leading infix operators on continuation lines.
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

static bool detect_comment_start(TSLexer *lexer) {
  lexer->mark_end(lexer);
  // Comments should not affect indentation
  if (lexer->lookahead == '/') {
    advance(lexer);
    if (lexer->lookahead == '/' || lexer -> lookahead == '*') {
      return true;
    }
  }
  return false;
}

static bool scan_word(TSLexer *lexer, const char* const word) {
  for (uint8_t i = 0; word[i] != '\0'; i++) {
    if (lexer->lookahead != word[i]) {
      return false;
    }
    advance(lexer);
  }
  return !iswalnum(lexer->lookahead);
}

// Returns true if the lookahead starts a leading infix operator — a symbolic
// operator or back-ticked identifier followed by whitespace and then a
// non-whitespace operand on the same line. Such a line is a continuation of
// the previous expression, so neither AUTOMATIC_SEMICOLON nor OUTDENT should
// fire ahead of it. Advances the lexer; the caller must not rely on position.
static bool is_leading_infix_continuation(TSLexer *lexer) {
  if (is_op_char(lexer->lookahead)) {
    advance(lexer);
    while (is_op_char(lexer->lookahead)) {
      advance(lexer);
    }
    bool found_space = false;
    while (lexer->lookahead == ' ' || lexer->lookahead == '\t') {
      advance(lexer);
      found_space = true;
    }
    return found_space && !iswspace(lexer->lookahead) && !lexer->eof(lexer);
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
    bool found_space = false;
    while (lexer->lookahead == ' ' || lexer->lookahead == '\t') {
      advance(lexer);
      found_space = true;
    }
    return found_space && !iswspace(lexer->lookahead) && !lexer->eof(lexer);
  }
  return false;
}

static inline void debug_indents(Scanner *scanner) {
  LOG("    indents(%d): ", scanner->indents.size);
  for (unsigned i = 0; i < scanner->indents.size; i++) {
    LOG("%d ", scanner->indents.contents[i]);
  }
  LOG("\n");
}

bool tree_sitter_scala_external_scanner_scan(void *payload, TSLexer *lexer,
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

  Scanner *scanner = (Scanner *)payload;
  int16_t prev = scanner->indents.size > 0 ? *array_back(&scanner->indents) : -1;
  int16_t newline_count = 0;
  int16_t indentation_size = 0;

  while (iswspace(lexer->lookahead)) {
    if (lexer->lookahead == '\n') {
      newline_count++;
      indentation_size = 0;
    }
    else {
      indentation_size++;
    }
    skip(lexer);
  }

  // Separate from OUTDENT because the scanner cannot distinguish a comma that
  // terminates an indented block (e.g. `map: x => f(x),`) from one that is
  // internal to it (e.g. `case EnumCase1, EnumCase2`). By using a distinct
  // token, tree-sitter only makes it valid in grammar contexts where comma
  // termination is expected (colon_argument, _indentable_expression).
  if (valid_symbols[COMMA_OUTDENT] && lexer->lookahead == ',' && prev != -1) {
    if (scanner->indents.size > 0) {
      array_pop(&scanner->indents);
    }
    lexer->mark_end(lexer);
    lexer->result_symbol = COMMA_OUTDENT;
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
          scanner->last_indentation_size < prev
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

  if (
      valid_symbols[INDENT] &&
      newline_count > 0 &&
      (
        scanner->indents.size == 0 ||
        indentation_size > *array_back(&scanner->indents)
      )
  ) {
    if (detect_comment_start(lexer)) {
      return false;
    }
    array_push(&scanner->indents, indentation_size);
    lexer->result_symbol = INDENT;
    LOG("    INDENT\n");
    return true;
  }

  // This saves the indentation_size and newline_count so it can be used
  // in subsequent calls for multiple outdent or auto-semicolon.
  if (valid_symbols[OUTDENT] &&
      (lexer->lookahead == 0 ||
      (
        newline_count > 0 &&
        prev != -1 &&
        indentation_size < prev
      )
      )
  ) {
    lexer->mark_end(lexer);
    if (detect_comment_start(lexer)) {
      return false;
    }
    scanner->last_indentation_size = indentation_size;
    scanner->last_newline_count = newline_count;
    if (lexer->eof(lexer)) {
      scanner->last_column = -1;
    } else {
      scanner->last_column = (int16_t)lexer->get_column(lexer);
    }
    // Don't close the indented block when the next line starts with a leading
    // infix operator: that operator continues the previous expression.
    if (lexer->lookahead != 0 && is_leading_infix_continuation(lexer)) {
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

  // Recover newline_count from the outdent reset
  bool is_eof = lexer->eof(lexer);
  if (
      (
        scanner->last_newline_count > 0 &&
        (is_eof && scanner->last_column == -1)
      ) ||
      (!is_eof && lexer->get_column(lexer) == (uint32_t)scanner->last_column)
  ) {
    newline_count += scanner->last_newline_count;
  }
  scanner->last_newline_count = 0;

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

    // Single-line and multi-line comments
    if (lexer->lookahead == '/') {
      advance(lexer);
      if (lexer->lookahead == '/') {
        return false;
      }
      if (lexer->lookahead == '*') {
        advance(lexer);
        while (!lexer->eof(lexer)) {
          if (lexer->lookahead == '*') {
            advance(lexer);
            if (lexer->lookahead == '/') {
              advance(lexer);
              break;
            }
          } else {
            advance(lexer);
          }
        }
        while (iswspace(lexer->lookahead)) {
          if (lexer->lookahead == '\n' || lexer->lookahead == '\r') {
            return false;
          }
          skip(lexer);
        }
        // If some code is present at the same line after comment end,
        // we should still produce AUTOMATIC_SEMICOLON, e.g. in
        // val a = 1
        // /* comment */ val b = 2
        return true;
      }
    }

    if (valid_symbols[ELSE]) {
      return !scan_word(lexer, "else");
    }

    if (valid_symbols[CATCH]) {
      if (scan_word(lexer, "catch")) {
        return false;
      }
    }

    if (valid_symbols[FINALLY]) {
      if  (scan_word(lexer, "finally")) {
        return false;
      }
    }

    if (valid_symbols[EXTENDS]) {
      if (scan_word(lexer, "extends")) {
        return false;
      }
    }

    if (valid_symbols[WITH]) {
      if (scan_word(lexer, "with")) {
        return false;
      }
    }

    if (valid_symbols[DERIVES]) {
      if (scan_word(lexer, "derives")) {
        return false;
      }
    }

    if (newline_count > 1) {
      return true;
    }

    // Don't insert automatic semicolon before leading infix operators:
    // - symbolic, e.g. || or &&
    // - back-ticked, e.g. `in`
    // Only suppress if the operator is followed by horizontal whitespace
    // and then non-newline content on the same line, meaning it has an operand.
    if (is_leading_infix_continuation(lexer)) {
      return false;
    }

    return true;
  }

  while (iswspace(lexer->lookahead)) {
    if (lexer->lookahead == '\n') {
      newline_count++;
    }
    skip(lexer);
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

  return false;
}

//
