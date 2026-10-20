#include "tree_sitter/parser.h"
#include <string.h>
#include <wctype.h>

#define TOKEN_COUNT 33

enum TokenType {
    BLOCK_COMMENT,
    RAW_STR_PART,
    RAW_STR_CONTINUING_INDICATOR,
    RAW_STR_END_PART,
    IMPLICIT_SEMI,
    EXPLICIT_SEMI,
    ARROW_OPERATOR,
    DOT_OPERATOR,
    CONJUNCTION_OPERATOR,
    DISJUNCTION_OPERATOR,
    NIL_COALESCING_OPERATOR,
    EQUAL_SIGN,
    EQ_EQ,
    PLUS_THEN_WS,
    MINUS_THEN_WS,
    BANG,
    THROWS_KEYWORD,
    RETHROWS_KEYWORD,
    DEFAULT_KEYWORD,
    WHERE_KEYWORD,
    ELSE_KEYWORD,
    CATCH_KEYWORD,
    AS_KEYWORD,
    AS_QUEST,
    AS_BANG,
    ASYNC_KEYWORD,
    CUSTOM_OPERATOR,
    HASH_SYMBOL,
    DIRECTIVE_IF,
    DIRECTIVE_ELSEIF,
    DIRECTIVE_ELSE,
    DIRECTIVE_ENDIF,
    FAKE_TRY_BANG
};

#define OPERATOR_COUNT 20

const char* OPERATORS[OPERATOR_COUNT] = {
    "->",
    ".",
    "&&",
    "||",
    "??",
    "=",
    "==",
    "+",
    "-",
    "!",
    "throws",
    "rethrows",
    "default",
    "where",
    "else",
    "catch",
    "as",
    "as?",
    "as!",
    "async"
};

enum IllegalTerminatorGroup {
    ALPHANUMERIC,
    OPERATOR_SYMBOLS,
    OPERATOR_OR_DOT,
    NON_WHITESPACE
};

const enum IllegalTerminatorGroup OP_ILLEGAL_TERMINATORS[OPERATOR_COUNT] = {
    OPERATOR_SYMBOLS, // ->
    OPERATOR_OR_DOT,  // .
    OPERATOR_SYMBOLS, // &&
    OPERATOR_SYMBOLS, // ||
    OPERATOR_SYMBOLS, // ??
    OPERATOR_SYMBOLS, // =
    OPERATOR_SYMBOLS, // ==
    NON_WHITESPACE,   // +
    NON_WHITESPACE,   // -
    OPERATOR_SYMBOLS, // !
    ALPHANUMERIC,     // throws
    ALPHANUMERIC,     // rethrows
    ALPHANUMERIC,     // default
    ALPHANUMERIC,     // where
    ALPHANUMERIC,     // else
    ALPHANUMERIC,     // catch
    ALPHANUMERIC,     // as
    OPERATOR_SYMBOLS, // as?
    OPERATOR_SYMBOLS, // as!
    ALPHANUMERIC      // async
};

const enum TokenType OP_SYMBOLS[OPERATOR_COUNT] = {
    ARROW_OPERATOR,
    DOT_OPERATOR,
    CONJUNCTION_OPERATOR,
    DISJUNCTION_OPERATOR,
    NIL_COALESCING_OPERATOR,
    EQUAL_SIGN,
    EQ_EQ,
    PLUS_THEN_WS,
    MINUS_THEN_WS,
    BANG,
    THROWS_KEYWORD,
    RETHROWS_KEYWORD,
    DEFAULT_KEYWORD,
    WHERE_KEYWORD,
    ELSE_KEYWORD,
    CATCH_KEYWORD,
    AS_KEYWORD,
    AS_QUEST,
    AS_BANG,
    ASYNC_KEYWORD
};

const uint64_t OP_SYMBOL_SUPPRESSOR[OPERATOR_COUNT] = {
    0, // ARROW_OPERATOR,
    0, // DOT_OPERATOR,
    0, // CONJUNCTION_OPERATOR,
    0, // DISJUNCTION_OPERATOR,
    0, // NIL_COALESCING_OPERATOR,
    0, // EQUAL_SIGN,
    0, // EQ_EQ,
    0, // PLUS_THEN_WS,
    0, // MINUS_THEN_WS,
    // 1ULL, as upstream has it from 0.7.4: 1UL << 32 overflows where unsigned
    // long is 32 bits (MSVC), and `try!` lost its `!`. (codegraph patch)
    1ULL << FAKE_TRY_BANG, // BANG,
        0, // THROWS_KEYWORD,
        0, // RETHROWS_KEYWORD,
        0, // DEFAULT_KEYWORD,
        0, // WHERE_KEYWORD,
        0, // ELSE_KEYWORD,
        0, // CATCH_KEYWORD,
        0, // AS_KEYWORD,
        0, // AS_QUEST,
        0, // AS_BANG,
        0, // ASYNC_KEYWORD
};

#define RESERVED_OP_COUNT 31

const char* RESERVED_OPS[RESERVED_OP_COUNT] = {
    "/",
    "=",
    "-",
    "+",
    "!",
    "*",
    "%",
    "<",
    ">",
    "&",
    "|",
    "^",
    "?",
    "~",
    ".",
    "..",
    "->",
    "/*",
    "*/",
    "+=",
    "-=",
    "*=",
    "/=",
    "%=",
    ">>",
    "<<",
    "++",
    "--",
    "===",
    "...",
    "..<"
};

static bool is_cross_semi_token(enum TokenType op) {
    switch(op) {
    case ARROW_OPERATOR:
    case DOT_OPERATOR:
    case CONJUNCTION_OPERATOR:
    case DISJUNCTION_OPERATOR:
    case NIL_COALESCING_OPERATOR:
    case EQUAL_SIGN:
    case EQ_EQ:
    case PLUS_THEN_WS:
    case MINUS_THEN_WS:
    case THROWS_KEYWORD:
    case RETHROWS_KEYWORD:
    case DEFAULT_KEYWORD:
    case WHERE_KEYWORD:
    case ELSE_KEYWORD:
    case CATCH_KEYWORD:
    case AS_KEYWORD:
    case AS_QUEST:
    case AS_BANG:
    case ASYNC_KEYWORD:
    case CUSTOM_OPERATOR:
        return true;
    case BANG:
    default:
        return false;
    }
}

#define NON_CONSUMING_CROSS_SEMI_CHAR_COUNT 3
const uint32_t NON_CONSUMING_CROSS_SEMI_CHARS[NON_CONSUMING_CROSS_SEMI_CHAR_COUNT] = { '?', ':', '{' };

/**
 * All possible results of having performed some sort of parsing.
 *
 * A parser can return a result along two dimensions:
 * 1. Should the scanner continue trying to find another result?
 * 2. Was some result produced by this parsing attempt?
 *
 * These are flattened into a single enum together. When the function returns one of the `TOKEN_FOUND` cases, it
 * will always populate its `symbol_result` field. When it returns one of the `STOP_PARSING` cases, callers should
 * immediately return (with the value, if there is one).
 */
enum ParseDirective {
    CONTINUE_PARSING_NOTHING_FOUND,
    CONTINUE_PARSING_TOKEN_FOUND,
    CONTINUE_PARSING_SLASH_CONSUMED,
    STOP_PARSING_NOTHING_FOUND,
    STOP_PARSING_TOKEN_FOUND,
    STOP_PARSING_END_OF_FILE
};

struct ScannerState {
    uint32_t ongoing_raw_str_hash_count;
};

void *tree_sitter_swift_external_scanner_create() {
    return calloc(1, sizeof(struct ScannerState));
}

void tree_sitter_swift_external_scanner_destroy(void *payload) {
    free(payload);
}

void tree_sitter_swift_external_scanner_reset(void *payload) {
    struct ScannerState *state = (struct ScannerState *)payload;
    state->ongoing_raw_str_hash_count = 0;
}

unsigned tree_sitter_swift_external_scanner_serialize(void *payload, char *buffer) {
    struct ScannerState *state = (struct ScannerState *)payload;
    uint32_t hash_count = state->ongoing_raw_str_hash_count;
    buffer[0] = (hash_count >> 24) & 0xff;
    buffer[1] = (hash_count >> 16) & 0xff;
    buffer[2] = (hash_count >> 8) & 0xff;
    buffer[3] = (hash_count) & 0xff;
    return 4;
}

void tree_sitter_swift_external_scanner_deserialize(
    void *payload,
    const char *buffer,
    unsigned length
) {
    if (length < 4) {
        return;
    }

    uint32_t hash_count = (
                              (((uint32_t) buffer[0]) << 24) |
                              (((uint32_t) buffer[1]) << 16) |
                              (((uint32_t) buffer[2]) << 8) |
                              (((uint32_t) buffer[3]))
                          );
    struct ScannerState *state = (struct ScannerState *)payload;
    state->ongoing_raw_str_hash_count = hash_count;
}

static void advance(TSLexer *lexer) {
    lexer->advance(lexer, false);
}

static bool should_treat_as_wspace(int32_t character) {
    return iswspace(character) || (((int32_t) ';') == character);
}

static int32_t encountered_op_count(bool *encountered_operator) {
    int32_t encountered = 0;
    for (int op_idx = 0; op_idx < OPERATOR_COUNT; op_idx++) {
        if (encountered_operator[op_idx]) {
            encountered++;
        }
    }

    return encountered;
}

static bool any_reserved_ops(uint8_t *encountered_reserved_ops) {
    for (int op_idx = 0; op_idx < RESERVED_OP_COUNT; op_idx++) {
        if (encountered_reserved_ops[op_idx] == 2) {
            return true;
        }
    }

    return false;
}

static bool is_legal_custom_operator(
    int32_t char_idx,
    int32_t first_char,
    int32_t cur_char
) {
    bool is_first_char = !char_idx;
    switch (cur_char) {
    case '=':
    case '-':
    case '+':
    case '!':
    case '%':
    case '<':
    case '>':
    case '&':
    case '|':
    case '^':
    case '?':
    case '~':
        return true;
    case '.':
        // Grammar allows `.` for any operator that starts with `.`
        return is_first_char || first_char == '.';
    case '*':
    case '/':
        // Not listed in the grammar, but `/*` and `//` can't be the start of an operator since they start comments
        return char_idx != 1 || first_char != '/';
    default:
        if (
            (cur_char >= 0x00A1 && cur_char <= 0x00A7) ||
            (cur_char == 0x00A9) ||
            (cur_char == 0x00AB) ||
            (cur_char == 0x00AC) ||
            (cur_char == 0x00AE) ||
            (cur_char >= 0x00B0 && cur_char <= 0x00B1) ||
            (cur_char == 0x00B6) ||
            (cur_char == 0x00BB) ||
            (cur_char == 0x00BF) ||
            (cur_char == 0x00D7) ||
            (cur_char == 0x00F7) ||
            (cur_char >= 0x2016 && cur_char <= 0x2017) ||
            (cur_char >= 0x2020 && cur_char <= 0x2027) ||
            (cur_char >= 0x2030 && cur_char <= 0x203E) ||
            (cur_char >= 0x2041 && cur_char <= 0x2053) ||
            (cur_char >= 0x2055 && cur_char <= 0x205E) ||
            (cur_char >= 0x2190 && cur_char <= 0x23FF) ||
            (cur_char >= 0x2500 && cur_char <= 0x2775) ||
            (cur_char >= 0x2794 && cur_char <= 0x2BFF) ||
            (cur_char >= 0x2E00 && cur_char <= 0x2E7F) ||
            (cur_char >= 0x3001 && cur_char <= 0x3003) ||
            (cur_char >= 0x3008 && cur_char <= 0x3020) ||
            (cur_char == 0x3030)
        ) {
            return true;
        } else if (
            (cur_char >= 0x0300 && cur_char <= 0x036f) ||
            (cur_char >= 0x1DC0 && cur_char <= 0x1DFF) ||
            (cur_char >= 0x20D0 && cur_char <= 0x20FF) ||
            (cur_char >= 0xFE00 && cur_char <= 0xFE0F) ||
            (cur_char >= 0xFE20 && cur_char <= 0xFE2F) ||
            (cur_char >= 0xE0100 && cur_char <= 0xE01EF)
        ) {
            return !is_first_char;
        } else {
            return false;
        }
    }
}

static bool eat_operators(
    TSLexer *lexer,
    const bool *valid_symbols,
    bool mark_end,
    const int32_t prior_char,
    enum TokenType *symbol_result
) {
    bool possible_operators[OPERATOR_COUNT];
    uint8_t reserved_operators[RESERVED_OP_COUNT];
    for (int op_idx = 0; op_idx < OPERATOR_COUNT; op_idx++) {
        possible_operators[op_idx] = valid_symbols[OP_SYMBOLS[op_idx]] && (!prior_char || OPERATORS[op_idx][0] == prior_char);
    }
    for (int op_idx = 0; op_idx < RESERVED_OP_COUNT; op_idx++) {
        reserved_operators[op_idx] = !prior_char || RESERVED_OPS[op_idx][0] == prior_char;
    }

    bool possible_custom_operator = valid_symbols[CUSTOM_OPERATOR];
    int32_t first_char = prior_char ? prior_char : lexer->lookahead;
    int32_t last_examined_char = first_char;

    int32_t str_idx = prior_char ? 1 : 0;
    int32_t full_match = -1;
    while(true) {
        for (int op_idx = 0; op_idx < OPERATOR_COUNT; op_idx++) {
            if (!possible_operators[op_idx]) {
                continue;
            }

            if (OPERATORS[op_idx][str_idx] == '\0') {
                // Make sure that the operator is allowed to have the next character as its lookahead.
                enum IllegalTerminatorGroup illegal_terminators = OP_ILLEGAL_TERMINATORS[op_idx];
                switch (lexer->lookahead) {
                // See "Operators":
                // https://docs.swift.org/swift-book/ReferenceManual/LexicalStructure.html#ID418
                case '/':
                case '=':
                case '-':
                case '+':
                case '!':
                case '*':
                case '%':
                case '<':
                case '>':
                case '&':
                case '|':
                case '^':
                case '?':
                case '~':
                    if (illegal_terminators == OPERATOR_SYMBOLS) {
                        break;
                    } // Otherwise, intentionally fall through to the OPERATOR_OR_DOT case
                // fall through
                case '.':
                    if (illegal_terminators == OPERATOR_OR_DOT) {
                        break;
                    } // Otherwise, fall through to DEFAULT which checks its groups directly
                // fall through
                default:
                    if (iswalnum(lexer->lookahead) && illegal_terminators == ALPHANUMERIC) {
                        break;
                    }

                    if (!iswspace(lexer->lookahead) && illegal_terminators == NON_WHITESPACE) {
                        break;
                    }

                    full_match = op_idx;
                    if (mark_end) {
                        lexer->mark_end(lexer);
                    }
                }

                possible_operators[op_idx] = false;
                continue;
            }

            if (OPERATORS[op_idx][str_idx] != lexer->lookahead) {
                possible_operators[op_idx] = false;
                continue;
            }
        }

        for (int op_idx = 0; op_idx < RESERVED_OP_COUNT; op_idx++) {
            if (!reserved_operators[op_idx]) {
                continue;
            }

            if (RESERVED_OPS[op_idx][str_idx] == '\0') {
                reserved_operators[op_idx] = 0;
                continue;
            }

            if (RESERVED_OPS[op_idx][str_idx] != lexer->lookahead) {
                reserved_operators[op_idx] = 0;
                continue;
            }

            if (RESERVED_OPS[op_idx][str_idx + 1] == '\0') {
                reserved_operators[op_idx] = 2;
                continue;
            }
        }

        possible_custom_operator = possible_custom_operator && is_legal_custom_operator(
                                       str_idx,
                                       first_char,
                                       lexer->lookahead
                                   );

        uint32_t encountered_ops = encountered_op_count(possible_operators);
        if (encountered_ops == 0) {
            if (!possible_custom_operator) {
                break;
            } else if (mark_end && full_match == -1) {
                lexer->mark_end(lexer);
            }
        }

        last_examined_char = lexer->lookahead;
        lexer->advance(lexer, false);
        str_idx += 1;

        if (encountered_ops == 0 && !is_legal_custom_operator(
                    str_idx,
                    first_char,
                    lexer->lookahead
                )) {
            break;
        }
    }

    if (full_match != -1) {
        // We have a match -- first see if that match has a symbol that suppresses it. For example, in `try!`, we do not
        // want to emit the `!` as a symbol in our scanner, because we want the parser to have the chance to parse it as
        // an immediate token.
        uint64_t suppressing_symbols = OP_SYMBOL_SUPPRESSOR[full_match];
        if (suppressing_symbols) {
            for (uint64_t suppressor = 0; suppressor < TOKEN_COUNT; suppressor++) {
                if (!(suppressing_symbols & 1ULL << suppressor)) {
                    continue;
                }

                // The suppressing symbol is valid in this position, so skip it.
                if (valid_symbols[suppressor]) {
                    return false;
                }
            }
        }
        *symbol_result = OP_SYMBOLS[full_match];
        return true;
    }

    if (possible_custom_operator && !any_reserved_ops(reserved_operators)) {
        if ((last_examined_char != '<' || iswspace(lexer->lookahead)) && mark_end) {
            lexer->mark_end(lexer);
        }
        *symbol_result = CUSTOM_OPERATOR;
        return true;
    }

    return false;
}

static enum ParseDirective eat_comment(
    TSLexer *lexer,
    const bool *valid_symbols,
    bool mark_end,
    enum TokenType *symbol_result
) {
    if (lexer->lookahead != '/') {
        return CONTINUE_PARSING_NOTHING_FOUND;
    }

    advance(lexer);

    if (lexer->lookahead != '*') {
        return CONTINUE_PARSING_SLASH_CONSUMED;
    }

    advance(lexer);

    bool after_star = false;
    unsigned nesting_depth = 1;
    for (;;) {
        switch (lexer->lookahead) {
        case '\0':
            return STOP_PARSING_END_OF_FILE;
        case '*':
            advance(lexer);
            after_star = true;
            break;
        case '/':
            if (after_star) {
                advance(lexer);
                after_star = false;
                nesting_depth--;
                if (nesting_depth == 0) {
                    if (mark_end) {
                        lexer->mark_end(lexer);
                    }
                    *symbol_result = BLOCK_COMMENT;
                    return STOP_PARSING_TOKEN_FOUND;
                }
            } else {
                advance(lexer);
                after_star = false;
                if (lexer->lookahead == '*') {
                    nesting_depth++;
                    advance(lexer);
                }
            }
            break;
        default:
            advance(lexer);
            after_star = false;
            break;
        }
    }
}

static enum ParseDirective eat_whitespace(
    TSLexer *lexer,
    const bool *valid_symbols,
    enum TokenType *symbol_result
) {
    enum ParseDirective ws_directive = CONTINUE_PARSING_NOTHING_FOUND;
    bool semi_is_valid = valid_symbols[IMPLICIT_SEMI] && valid_symbols[EXPLICIT_SEMI];
    uint32_t lookahead;
    while (should_treat_as_wspace(lookahead = lexer->lookahead)) {
        if (lookahead == ';') {
            if (semi_is_valid) {
                ws_directive = STOP_PARSING_TOKEN_FOUND;
                lexer->advance(lexer, false);
            }

            break;
        }

        lexer->advance(lexer, true);

        lexer->mark_end(lexer);

        if (ws_directive == CONTINUE_PARSING_NOTHING_FOUND && (lookahead == '\n' || lookahead == '\r')) {
            ws_directive = CONTINUE_PARSING_TOKEN_FOUND;
        }
    }

    enum ParseDirective any_comment = CONTINUE_PARSING_NOTHING_FOUND;
    if (ws_directive == CONTINUE_PARSING_TOKEN_FOUND && lookahead == '/') {
        bool has_seen_single_comment = false;
        while (lexer->lookahead == '/') {
            // It's possible that this is a comment - start an exploratory mission to find out, and if it is, look for what
            // comes after it. We care about what comes after it for the purpose of suppressing the newline.

            enum TokenType multiline_comment_result;
            any_comment = eat_comment(lexer, valid_symbols, /* mark_end */ false, &multiline_comment_result);
            if (any_comment == STOP_PARSING_TOKEN_FOUND) {
                // This is a multiline comment. This scanner should be parsing those, so we might want to bail out and
                // emit it instead. However, we only want to do that if we haven't advanced through a _single_ line
                // comment on the way - otherwise that will get lumped into this.
                if (!has_seen_single_comment) {
                    lexer->mark_end(lexer);
                    *symbol_result = multiline_comment_result;
                    return STOP_PARSING_TOKEN_FOUND;
                }
            } else if (any_comment == STOP_PARSING_END_OF_FILE) {
                return STOP_PARSING_END_OF_FILE;
            } else if (any_comment == CONTINUE_PARSING_SLASH_CONSUMED) {
                // We accidentally ate a slash -- we should actually bail out, say we saw nothing, and let the next pass
                // take it from after the newline.
                return CONTINUE_PARSING_SLASH_CONSUMED;
            } else if (lexer->lookahead == '/') {
                // There wasn't a multiline comment, which we know means that the comment parser ate its `/` and then
                // bailed out. If it had seen anything comment-like after that first `/` it would have continued going
                // and eventually had a well-formed comment or an EOF. Thus, if we're currently looking at a `/`, it's
                // the second one of those and it means we have a single-line comment.
                has_seen_single_comment = true;
                while (lexer->lookahead != '\n' && lexer->lookahead != '\0') {
                    lexer->advance(lexer, true);
                }
            } else if (iswspace(lexer->lookahead)) {
                // We didn't see any type of comment - in fact, we saw an operator that we don't normally treat as an
                // operator. Still, this is a reason to stop parsing.
                return STOP_PARSING_NOTHING_FOUND;
            }

            // If we skipped through some comment, we're at whitespace now, so advance.
            while(iswspace(lexer->lookahead)) {
                any_comment = CONTINUE_PARSING_NOTHING_FOUND; // We're advancing, so clear out the comment
                lexer->advance(lexer, true);
            }
        }

        enum TokenType operator_result;
        bool saw_operator = eat_operators(
                                lexer,
                                valid_symbols,
                                /* mark_end */ false,
                                '\0',
                                &operator_result
                            );
        if (saw_operator) {
            // The operator we saw should suppress the newline, so bail out.
            return STOP_PARSING_NOTHING_FOUND;
        } else {
            // Promote the implicit newline to an explicit one so we don't check for operators again.
            *symbol_result = IMPLICIT_SEMI;
            ws_directive = STOP_PARSING_TOKEN_FOUND;
        }
    }

    // Let's consume operators that can live after a "semicolon" style newline. Before we do that, though, we want to
    // check for a set of characters that we do not consume, but that still suppress the semi.
    if (ws_directive == CONTINUE_PARSING_TOKEN_FOUND) {
        for (int i = 0; i < NON_CONSUMING_CROSS_SEMI_CHAR_COUNT; i++) {
            if (NON_CONSUMING_CROSS_SEMI_CHARS[i] == lookahead) {
                return CONTINUE_PARSING_NOTHING_FOUND;
            }
        }
    }

    if (semi_is_valid && ws_directive != CONTINUE_PARSING_NOTHING_FOUND) {
        *symbol_result = lookahead == ';' ? EXPLICIT_SEMI : IMPLICIT_SEMI;
        return ws_directive;
    }

    return CONTINUE_PARSING_NOTHING_FOUND;
}

#define DIRECTIVE_COUNT 4
const char* DIRECTIVES[OPERATOR_COUNT] = {
    "if",
    "elseif",
    "else",
    "endif"
};

const enum TokenType DIRECTIVE_SYMBOLS[DIRECTIVE_COUNT] = {
    DIRECTIVE_IF,
    DIRECTIVE_ELSEIF,
    DIRECTIVE_ELSE,
    DIRECTIVE_ENDIF
};

static enum TokenType find_possible_compiler_directive(TSLexer *lexer) {
    bool possible_directives[DIRECTIVE_COUNT];
    for (int dir_idx = 0; dir_idx < DIRECTIVE_COUNT; dir_idx++) {
        possible_directives[dir_idx] = true;
    }

    int32_t str_idx = 0;
    int32_t full_match = -1;
    while(true) {
        for (int dir_idx = 0; dir_idx < DIRECTIVE_COUNT; dir_idx++) {
            if (!possible_directives[dir_idx]) {
                continue;
            }

            uint8_t expected_char = DIRECTIVES[dir_idx][str_idx];
            if (expected_char == '\0') {
                full_match = dir_idx;
                lexer->mark_end(lexer);
            }

            if (expected_char != lexer->lookahead) {
                possible_directives[dir_idx] = false;
                continue;
            }
        }

        uint8_t match_count = 0;
        for (int dir_idx = 0; dir_idx < DIRECTIVE_COUNT; dir_idx += 1) {
            if (possible_directives[dir_idx]) {
                match_count += 1;
            }
        }

        if (match_count == 0) {
            break;
        }

        lexer->advance(lexer, false);
        str_idx += 1;
    }

    if (full_match == -1) {
        // No compiler directive found, so just match the starting symbol
        return HASH_SYMBOL;
    }

    return DIRECTIVE_SYMBOLS[full_match];
}

static bool eat_raw_str_part(
    struct ScannerState *state,
    TSLexer *lexer,
    const bool *valid_symbols,
    enum TokenType *symbol_result
) {
    uint32_t hash_count = state->ongoing_raw_str_hash_count;
    if (!valid_symbols[RAW_STR_PART]) {
        return false;
    } else if (hash_count == 0) {
        // If this is a raw_str_part, it's the first one - look for hashes
        while (lexer->lookahead == '#') {
            hash_count += 1;
            advance(lexer);
        }

        if (hash_count == 0) {
            return false;
        }

        if (lexer->lookahead == '"') {
            advance(lexer);
        } else if (hash_count == 1) {
            lexer->mark_end(lexer);
            *symbol_result = find_possible_compiler_directive(lexer);
            return true;
        } else {
            return false;
        }

    } else if (valid_symbols[RAW_STR_CONTINUING_INDICATOR]) {
        // This is the end of an interpolation - now it's another raw_str_part. This is a synthetic
        // marker to tell us that the grammar just consumed a `(` symbol to close a raw
        // interpolation (since we don't want to fire on every `(` in existence). We don't have
        // anything to do except continue.
    } else {
        return false;
    }

    // We're in a state where anything other than `hash_count` hash symbols in a row should be eaten
    // and is part of a string.
    // The last character _before_ the hashes will tell us what happens next.
    // Matters are also complicated by the fact that we don't want to consume every character we
    // visit; if we see a `\#(`, for instance, with the appropriate number of hash symbols, we want
    // to end our parsing _before_ that sequence. This allows highlighting tools to treat that as a
    // separate token.
    while (lexer->lookahead != '\0') {
        uint8_t last_char = '\0';
        lexer->mark_end(lexer); // We always want to parse thru the start of the string so far
        // Advance through anything that isn't a hash symbol, because we want to count those.
        while (lexer->lookahead != '#' && lexer->lookahead != '\0') {
            last_char = lexer->lookahead;
            advance(lexer);
            if (last_char != '\\' || lexer->lookahead == '\\') {
                // Mark a new end, but only if we didn't just advance past a `\` symbol, since we
                // don't want to consume that. Exception: if this is a `\` that happens _right
                // after_ another `\`, we for some reason _do_ want to consume that, because
                // apparently that is parsed as a literal `\` followed by something escaped.
                lexer->mark_end(lexer);
            }
        }

        // We hit at least one hash - count them and see if they match.
        uint32_t current_hash_count = 0;
        while (lexer->lookahead == '#' && current_hash_count < hash_count) {
            current_hash_count += 1;
            advance(lexer);
        }

        // If we saw exactly the right number of hashes, one of three things is true:
        // 1. We're trying to interpolate into this string.
        // 2. The string just ended.
        // 3. This was just some hash characters doing nothing important.
        if (current_hash_count == hash_count) {
            if (last_char == '\\' && lexer->lookahead == '(') {
                // Interpolation case! Don't consume those chars; they get saved for grammar.js.
                *symbol_result = RAW_STR_PART;
                state->ongoing_raw_str_hash_count = hash_count;
                return true;
            } else if (last_char == '"') {
                // The string is finished! Mark the end here, on the very last hash symbol.
                lexer->mark_end(lexer);
                *symbol_result = RAW_STR_END_PART;
                state->ongoing_raw_str_hash_count = 0;
                return true;
            }
            // Nothing special happened - let the string continue.
        }
    }

    return false;
}

bool tree_sitter_swift_external_scanner_scan(
    void *payload,
    TSLexer *lexer,
    const bool *valid_symbols
) {
    // Figure out our scanner state
    struct ScannerState *state = (struct ScannerState *)payload;

    // Consume any whitespace at the start.
    enum TokenType ws_result;
    enum ParseDirective ws_directive = eat_whitespace(lexer, valid_symbols, &ws_result);
    if (ws_directive == STOP_PARSING_TOKEN_FOUND) {
        lexer->result_symbol = ws_result;
        return true;
    }

    if (ws_directive == STOP_PARSING_NOTHING_FOUND || ws_directive == STOP_PARSING_END_OF_FILE) {
        return false;
    }

    bool has_ws_result = (ws_directive == CONTINUE_PARSING_TOKEN_FOUND);

    // Now consume comments (before custom operators so that those aren't treated as comments)
    enum TokenType comment_result;
    enum ParseDirective comment = ws_directive == CONTINUE_PARSING_SLASH_CONSUMED ? ws_directive : eat_comment(lexer, valid_symbols, /* mark_end */ true, &comment_result);
    if (comment == STOP_PARSING_TOKEN_FOUND) {
        lexer->mark_end(lexer);
        lexer->result_symbol = comment_result;
        return true;
    }

    if (comment == STOP_PARSING_END_OF_FILE) {
        return false;
    }
    // Now consume any operators that might cause our whitespace to be suppressed.
    enum TokenType operator_result;
    bool saw_operator = eat_operators(
                            lexer,
                            valid_symbols,
                            /* mark_end */ !has_ws_result,
                            comment == CONTINUE_PARSING_SLASH_CONSUMED ? '/' : '\0',
                            &operator_result
                        );

    if (saw_operator && (!has_ws_result || is_cross_semi_token(operator_result))) {
        lexer->result_symbol = operator_result;
        if (has_ws_result) lexer->mark_end(lexer);
        return true;
    }

    if (has_ws_result) {
        // Don't `mark_end`, since we may have advanced through some operators.
        lexer->result_symbol = ws_result;
        return true;
    }

    // NOTE: this will consume any `#` characters it sees, even if it does not find a result. Keep
    // it at the end so that it doesn't interfere with special literals or selectors!
    enum TokenType raw_str_result;
    bool saw_raw_str_part = eat_raw_str_part(state, lexer, valid_symbols, &raw_str_result);
    if (saw_raw_str_part) {
        lexer->result_symbol = raw_str_result;
        return true;
    }

    return false;
}

