/**
 * Methods of Swift's standard collections, strings and optionals, and of
 * Foundation, UIKit views and Combine — names a project type rarely carries
 * itself. A call by one of these names needs receiver evidence before it
 * resolves to a project member: name-matcher's Swift chained-call test
 * (`isSwiftCallTarget`) and its single-candidate fallback for an untyped
 * receiver (`stdMethodNames`) both read it. Names a project type often
 * carries (`cancel`, `resume`, `store`, `validate`, `load`) are left out:
 * Alamofire's `request.resume()`, Kingfisher's `cache.store(…)`.
 */
export const SWIFT_STD_METHODS: ReadonlySet<string> = new Set([
  'append', 'insert', 'remove', 'removeAll', 'removeFirst', 'removeLast', 'removeValue', 'contains', 'map',
  'compactMap', 'flatMap', 'filter', 'reduce', 'forEach', 'sorted', 'sort', 'first', 'last', 'min', 'max',
  'firstIndex', 'lastIndex', 'index', 'enumerated', 'reversed', 'joined', 'split', 'prefix', 'suffix',
  'dropFirst', 'dropLast', 'allSatisfy', 'randomElement', 'shuffled', 'popLast', 'replaceSubrange',
  'replacingOccurrences', 'components', 'trimmingCharacters', 'hasPrefix', 'hasSuffix', 'lowercased',
  'uppercased', 'appending', 'updateValue', 'merge', 'merging', 'union', 'intersection', 'subtracting',
  'formUnion', 'isEqual', 'addSubview', 'removeFromSuperview', 'setNeedsDisplay', 'setNeedsLayout',
  'layoutIfNeeded', 'addGestureRecognizer', 'addTarget', 'addObserver', 'removeObserver', 'eraseToAnyPublisher',
]);

/** Whether `name` is in `SWIFT_STD_METHODS`. */
export function isSwiftStdMethodName(name: string): boolean {
  return SWIFT_STD_METHODS.has(name);
}
