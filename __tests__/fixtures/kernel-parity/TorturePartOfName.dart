/// A part of a library it names by library name, not by URI: the `part of`
/// directive records nothing.
@Tag(helper)
part of torture.directives;

class PartOfName {
  void run() => helper();
}

void helper() {}
