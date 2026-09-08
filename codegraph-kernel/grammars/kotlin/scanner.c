#include "tree_sitter/array.h"
#include "tree_sitter/parser.h"

#include <string.h>
#include <wctype.h>

// Mostly a copy paste of tree-sitter-javascript/src/scanner.c

enum TokenType {
  AUTOMATIC_SEMICOLON,
  IMPORT_LIST_DELIMITER,
  SAFE_NAV,
  MULTILINE_COMMENT,
  STRING_START,
  STRING_END,
  STRING_CONTENT,
};

/* Pretty much all of this code is taken from the Julia tree-sitter
   parser.

   Julia has similar problems with multiline comments that can be nested,
   line comments, as well as line and multiline strings.

   The most heavily edited section is `scan_string_content`,
   particularly with respect to interpolation.
 */

// Block comments are easy to parse, but strings require extra-attention.

// The main problems that arise when parsing strings are:
// 1. Triple quoted strings allow single quotes inside. e.g. """ "foo" """.
// 2. Non-standard string literals don't allow interpolations or escape
//    sequences, but you can always write \" and \`.

// To efficiently store a delimiter, we take advantage of the fact that:
// (int)'"' == 34 && (34 & 1) == 0
// i.e. " has an even numeric representation, so we can store a triple
// quoted delimiter as (delimiter + 1).

#define DELIMITER_LENGTH 3

typedef char Delimiter;

// We use a stack to keep track of the string delimiters.
typedef Array(Delimiter) Stack;

static inline void stack_push(Stack *stack, char chr, bool triple) {
  if (stack->size >= TREE_SITTER_SERIALIZATION_BUFFER_SIZE) abort();
  array_push(stack, (Delimiter)(triple ? (chr + 1) : chr));
}

static inline Delimiter stack_pop(Stack *stack) {
  if (stack->size == 0) abort();
  return array_pop(stack);
}

static inline void skip(TSLexer *lexer) { lexer->advance(lexer, true); }

static inline void advance(TSLexer *lexer) { lexer->advance(lexer, false); }

// Scanner functions

static bool scan_string_start(TSLexer *lexer, Stack *stack) {
  if (lexer->lookahead != '"') return false;
  advance(lexer);
  lexer->mark_end(lexer);
  for (unsigned count = 1; count < DELIMITER_LENGTH; ++count) {
    if (lexer->lookahead != '"') {
      // It's not a triple quoted delimiter.
      stack_push(stack, '"', false);
      return true;
    }
    advance(lexer);
  }
  lexer->mark_end(lexer);
  stack_push(stack, '"', true);
  return true;
}

static bool scan_string_content(TSLexer *lexer, Stack *stack) {
  if (stack->size == 0) return false;  // Stack is empty. We're not in a string.
  Delimiter end_char = stack->contents[stack->size - 1];  // peek
  bool is_triple = false;
  bool has_content = false;
  if (end_char & 1) {
    is_triple = true;
    end_char -= 1;
  }
  while (lexer->lookahead) {
    if (lexer->lookahead == '$') {
      // if we did not just start reading stuff, then we should stop
      // lexing right here, so we can offer the opportunity to lex a
      // interpolated identifier
      if (has_content) {
        lexer->result_symbol = STRING_CONTENT;
        return has_content;
      }
      // otherwise, if this is the start, determine if it is an
      // interpolated identifier.
      // otherwise, it's just string content, so continue
      advance(lexer);
      if (iswalpha(lexer->lookahead) || lexer->lookahead == '{') {
        // this must be a string interpolation, let's
        // fail so we parse it as such
        return false;
      }
      lexer->result_symbol = STRING_CONTENT;
      lexer->mark_end(lexer);
      return true;
    }
    if (lexer->lookahead == '\\') {
      // if we see a \, then this might possibly escape a dollar sign
      // in which case, we should not defer to the interpolation
      advance(lexer);
      // this dollar sign is escaped, so it must be content.
      // we consume it here so we don't enter the dollar sign case above,
      // which leaves the possibility that it is an interpolation 
      if (lexer->lookahead == '$') {
        advance(lexer);
        // however this leaves an edgecase where an escaped dollar sign could
        // appear at the end of a string (e.g "aa\$") which isn't handled
        // correctly; if we were at the end of the string, terminate properly
        if (lexer->lookahead == end_char) {
          stack_pop(stack);
          advance(lexer);
          lexer->mark_end(lexer);
          lexer->result_symbol = STRING_END;
          return true;
        }
      }
    } else if (lexer->lookahead == end_char) {
      if (is_triple) {
        lexer->mark_end(lexer);
        for (unsigned count = 1; count < DELIMITER_LENGTH; ++count) {
          advance(lexer);
          if (lexer->lookahead != end_char) {
            lexer->mark_end(lexer);
            lexer->result_symbol = STRING_CONTENT;
            return true;
          }
        }

        /* This is so if we lex something like
           """foo"""
              ^
           where we are at the `f`, we should quit after
           reading `foo`, and ascribe it to STRING_CONTENT.

           Then, we restart and try to read the end.
           This is to prevent `foo` from being absorbed into
           the STRING_END token.
         */
        if (has_content && lexer->lookahead == end_char) {
          lexer->result_symbol = STRING_CONTENT;
          return true;
        }

        /* Since the string internals are all hidden in the syntax
           tree anyways, there's no point in going to the effort of
           specifically separating the string end from string contents.
           If we see a bunch of quotes in a row, then we just go until
           they stop appearing, then stop lexing and call it the
           string's end.
         */
        lexer->result_symbol = STRING_END;
        lexer->mark_end(lexer);
        while (lexer->lookahead == end_char) {
          advance(lexer);
          lexer->mark_end(lexer);
        }
        stack_pop(stack);
        return true;
      }
      if (has_content) {
        lexer->mark_end(lexer);
        lexer->result_symbol = STRING_CONTENT;
        return true;
      }
      stack_pop(stack);
      advance(lexer);
      lexer->mark_end(lexer);
      lexer->result_symbol = STRING_END;
      return true;
    }
    advance(lexer);
    has_content = true;
  }
  return false;
}

static bool scan_multiline_comment(TSLexer *lexer) {
  if (lexer->lookahead != '/') return false;
  advance(lexer);
  if (lexer->lookahead != '*') return false;
  advance(lexer);

  bool after_star = false;
  unsigned nesting_depth = 1;
  for (;;) {
    switch (lexer->lookahead) {
      case '*':
        advance(lexer);
        after_star = true;
        break;
      case '/':
        advance(lexer);
        if (after_star) {
          after_star = false;
          nesting_depth -= 1;
          if (nesting_depth == 0) {
            lexer->result_symbol = MULTILINE_COMMENT;
            lexer->mark_end(lexer);
            return true;
          }
        } else {
          after_star = false;
          if (lexer->lookahead == '*') {
            nesting_depth += 1;
            advance(lexer);
          }
        }
        break;
      case '\0':
        return false;
      default:
        advance(lexer);
        after_star = false;
        break;
    }
  }
}

static bool scan_whitespace_and_comments(TSLexer *lexer) {
  while (iswspace(lexer->lookahead)) skip(lexer);
  return lexer->lookahead != '/';
}

static bool scan_for_word(TSLexer *lexer, const char* word, unsigned len) {
    skip(lexer);
    for (unsigned i = 0; i < len; ++i) {
      if (lexer->lookahead != word[i]) return false;
      skip(lexer);
    }
    return true;
}

static bool scan_automatic_semicolon(TSLexer *lexer) {
  lexer->result_symbol = AUTOMATIC_SEMICOLON;
  lexer->mark_end(lexer);

  bool sameline = true;
  for (;;) {
    if (lexer->eof(lexer)) return true;

    if (lexer->lookahead == ';') {
      advance(lexer);
      lexer->mark_end(lexer);
      return true;
    }

    if (!iswspace(lexer->lookahead)) break;

    if (lexer->lookahead == '\n') {
      skip(lexer);
      sameline = false;
      break;
    }

    if (lexer->lookahead == '\r') {
      skip(lexer);

      if (lexer->lookahead == '\n') skip(lexer);

      sameline = false;
      break;
    }

    skip(lexer);
  }

  // Skip whitespace and comments
  if (!scan_whitespace_and_comments(lexer))
    return false;

  if (sameline) {
    switch (lexer->lookahead) {
      // Don't insert a semicolon before an else
      case 'e':
        return !scan_for_word(lexer, "lse", 3);

      case 'i':
        return scan_for_word(lexer, "mport", 5);

      case ';':
        advance(lexer);
        lexer->mark_end(lexer);
        return true;

      default:
        return false;
    }
  }

  switch (lexer->lookahead) {
    case ',':
    case '.':
    case ':':
    case '*':
    case '%':
    case '>':
    case '<':
    case '=':
    case '{':
    case '[':
    case '(':
    case '?':
    case '|':
    case '&':
    case '/':
      return false;

    // Insert a semicolon before `--` and `++`, but not before binary `+` or `-`.
    // Insert before +/-Float
    case '+':
      skip(lexer);
      if (lexer->lookahead == '+') return true;
      return iswdigit(lexer->lookahead);

    case '-':
      skip(lexer);
      if (lexer->lookahead == '-') return true;
      return iswdigit(lexer->lookahead);

    // Don't insert a semicolon before `!=`, but do insert one before a unary `!`.
    case '!':
      skip(lexer);
      return lexer->lookahead != '=';

    // Don't insert a semicolon before an else
    case 'e':
      return !scan_for_word(lexer, "lse", 3);

    // Don't insert a semicolon before `in` or `instanceof`, but do insert one
    // before an identifier or an import.
    case 'i':
      skip(lexer);
      if (lexer->lookahead != 'n') return true;
      skip(lexer);
      if (!iswalpha(lexer->lookahead)) return false;
      return !scan_for_word(lexer, "stanceof", 8);

    case ';':
      advance(lexer);
      lexer->mark_end(lexer);
      return true;

    default:
      return true;
  }
}

static bool scan_safe_nav(TSLexer *lexer) {
  lexer->result_symbol = SAFE_NAV;
  lexer->mark_end(lexer);

  // skip white space
  if (!scan_whitespace_and_comments(lexer))
    return false;

  if (lexer->lookahead != '?')
    return false;

  advance(lexer);

  if (!scan_whitespace_and_comments(lexer))
    return false;

  if (lexer->lookahead != '.')
    return false;

  advance(lexer);
  lexer->mark_end(lexer);
  return true;
}

static bool scan_line_sep(TSLexer *lexer) {
  // Line Seps: [ CR, LF, CRLF ]
  int state = 0;
  while (true) {
    switch(lexer->lookahead) {
      case  ' ':
      case '\t':
      case '\v':
        // Skip whitespace
        advance(lexer);
        break;

      case '\n':
        advance(lexer);
        return true;

      case '\r':
        if (state == 1)
          return true;

        state = 1;
        advance(lexer);
        break;

      default:
        // We read a CR
        if (state == 1)
          return true;

        return false;
    }
  }
}

static bool scan_import_list_delimiter(TSLexer *lexer) {
  // Import lists are terminated either by an empty line or a non import statement
  lexer->result_symbol = IMPORT_LIST_DELIMITER;
  lexer->mark_end(lexer);

  // if eof; return true
  if (lexer->eof(lexer))
    return true;

  // Scan for the first line seperator
  if (!scan_line_sep(lexer))
    return false;

  // if line.sep line.sep; return true
  if (scan_line_sep(lexer)) {
    lexer->mark_end(lexer);
    return true;
  }

  // if line.sep [^import]; return true
  while (true) {
    switch (lexer->lookahead) {
      case  ' ':
      case '\t':
      case '\v':
        // Skip whitespace
        advance(lexer);
        break;

      case 'i':
        return !scan_for_word(lexer, "mport", 5);

      default:
        return true;
    }

    return false;
  }
}

bool tree_sitter_kotlin_external_scanner_scan(void *payload, TSLexer *lexer, const bool *valid_symbols) {
  if (valid_symbols[AUTOMATIC_SEMICOLON]) {
    bool ret = scan_automatic_semicolon(lexer);
    if (!ret && valid_symbols[SAFE_NAV] && lexer->lookahead == '?') {
      return scan_safe_nav(lexer);
    }

    // if we fail to find an automatic semicolon, it's still possible that we may
    // want to lex a string or comment later
    if (ret) return ret;
  }

  if (valid_symbols[IMPORT_LIST_DELIMITER]) {
    return scan_import_list_delimiter(lexer);
  }

  // content or end
  if (valid_symbols[STRING_CONTENT] && scan_string_content(lexer, payload)) {
    return true;
  }

  // a string might follow after some whitespace, so we can't lookahead
  // until we get rid of it
  while (iswspace(lexer->lookahead)) skip(lexer);

  if (valid_symbols[STRING_START] && scan_string_start(lexer, payload)) {
    lexer->result_symbol = STRING_START;
    return true;
  }

  if (valid_symbols[MULTILINE_COMMENT] && scan_multiline_comment(lexer)) {
    return true;
  }

  if (valid_symbols[SAFE_NAV]) {
    return scan_safe_nav(lexer);
  }

  return false;
}

void *tree_sitter_kotlin_external_scanner_create() {
  Stack *stack = ts_calloc(1, sizeof(Stack));
  if (stack == NULL) abort();
  array_init(stack);
  return stack;
}

void tree_sitter_kotlin_external_scanner_destroy(void *payload) {
  Stack *stack = (Stack *)payload;
  array_delete(stack);
  ts_free(stack);
}

unsigned tree_sitter_kotlin_external_scanner_serialize(void *payload, char *buffer) {
  Stack *stack = (Stack *)payload;
  memcpy(buffer, stack->contents, stack->size);
  return stack->size;
}

void tree_sitter_kotlin_external_scanner_deserialize(void *payload, const char *buffer, unsigned length) {
  Stack *stack = (Stack *)payload;
  if (length > 0) {
    array_reserve(stack, length);
    memcpy(stack->contents, buffer, length);
    stack->size = length;
  } else {
    array_clear(stack);
  }
}
