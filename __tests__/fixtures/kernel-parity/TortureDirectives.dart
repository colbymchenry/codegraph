/// A library's directives: imports and exports in every form, and its parts.
library torture.directives;

import 'dart:async';
import 'package:torture/other.dart' as other show OtherClass, otherFn;
import 'package:torture/hidden.dart' hide Hidden;
import 'src/conditional_stub.dart'
    if (dart.library.io) 'src/conditional_io.dart'
    if (dart.library.js_interop) 'src/conditional_web.dart';
import 'src/deferred.dart' deferred as lazy;

@Tag(viaImport)
import 'src/annotated.dart';

export 'src/exported.dart' show Exported;
@Tag(viaExport)
export 'src/annotated_export.dart';

// Parts: in a subdirectory, above this one, by package: URI, in each quote
// style, with comments inside and around, and annotated.
part 'directives.g.dart';
part "src/directives_part.dart";
part '../shared_part.dart';
part 'package:torture/src/package_part.dart';
part '''triple_part.dart''';
part /* generated */ 'commented_part.dart'; // trailing
part
    'wrapped_part.dart';
@Tag(viaPart)
part 'annotated_part.dart';
@Tag([viaPartList, viaPart])
part 'annotated_list_part.dart';

class Tag {
  const Tag(Object value);
}

void viaImport() {}
void viaExport() {}
void viaPart() {}
void viaPartList() {}

String describe() => 'directives';
