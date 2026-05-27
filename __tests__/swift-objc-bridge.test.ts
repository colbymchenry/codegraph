import { describe, it, expect } from 'vitest';
import {
  objcSelectorForSwiftMethod,
  objcSelectorForSwiftInit,
  objcAccessorsForSwiftProperty,
  swiftBaseNamesForObjcSelector,
  detectExplicitObjcName,
  isObjcExposed,
} from '../src/resolution/swift-objc-bridge';

describe('Swift → ObjC selector bridging (auto-name rules)', () => {
  describe('objcSelectorForSwiftMethod', () => {
    it('no parameters → bare base name', () => {
      expect(objcSelectorForSwiftMethod('play', [])).toBe('play');
    });

    it('single _ param → base + ":"', () => {
      expect(objcSelectorForSwiftMethod('play', ['_'])).toBe('play:');
      expect(objcSelectorForSwiftMethod('play', [null])).toBe('play:');
    });

    it('single labeled param → "baseWithLabel:"', () => {
      expect(objcSelectorForSwiftMethod('play', ['song'])).toBe('playWithSong:');
    });

    it('multi-param with leading _ → "base:label2:..."', () => {
      expect(objcSelectorForSwiftMethod('play', ['_', 'by'])).toBe('play:by:');
      expect(
        objcSelectorForSwiftMethod('tableView', ['_', 'didSelectRowAtIndexPath'])
      ).toBe('tableView:didSelectRowAtIndexPath:');
    });

    it('multi-param with leading explicit label → "baseWithFirst:rest:"', () => {
      expect(objcSelectorForSwiftMethod('play', ['song', 'by'])).toBe(
        'playWithSong:by:'
      );
    });

    it('@objc(custom:) overrides the rule literally', () => {
      expect(
        objcSelectorForSwiftMethod('whateverName', ['ignored'], 'custom:')
      ).toBe('custom:');
    });

    it('returns null on empty base name', () => {
      expect(objcSelectorForSwiftMethod('', [])).toBeNull();
    });
  });

  describe('objcSelectorForSwiftInit', () => {
    it('init() → "init"', () => {
      expect(objcSelectorForSwiftInit([], [])).toBe('init');
    });

    it('init(name:) → "initWithName:"', () => {
      expect(objcSelectorForSwiftInit(['name'], ['name'])).toBe('initWithName:');
    });

    it('init(name:, age:) → "initWithName:age:"', () => {
      expect(objcSelectorForSwiftInit(['name', 'age'], ['name', 'age'])).toBe(
        'initWithName:age:'
      );
    });

    it('init(_ name:) uses internal name → "initWithName:"', () => {
      expect(objcSelectorForSwiftInit(['_'], ['name'])).toBe('initWithName:');
    });

    it('@objc(custom) override on init', () => {
      expect(objcSelectorForSwiftInit(['name'], ['name'], 'custom:')).toBe(
        'custom:'
      );
    });
  });

  describe('objcAccessorsForSwiftProperty', () => {
    it('getter = name, setter = setName:', () => {
      expect(objcAccessorsForSwiftProperty('name')).toEqual({
        getter: 'name',
        setter: 'setName:',
      });
    });

    it('camelCase → set capitalizes first', () => {
      expect(objcAccessorsForSwiftProperty('isReady')).toEqual({
        getter: 'isReady',
        setter: 'setIsReady:',
      });
    });

    it('explicit @objc(custom) overrides getter name', () => {
      expect(objcAccessorsForSwiftProperty('name', 'displayName')).toEqual({
        getter: 'displayName',
        setter: 'setDisplayName:',
      });
    });
  });
});

describe('ObjC selector → Swift base name candidates (reverse map)', () => {
  it('bare no-colon selector → itself', () => {
    expect(swiftBaseNamesForObjcSelector('play')).toEqual(['play']);
  });

  it('"play:" → ["play"]', () => {
    expect(swiftBaseNamesForObjcSelector('play:')).toEqual(['play']);
  });

  it('"playWithSong:" → ["playWithSong", "play"]', () => {
    expect(swiftBaseNamesForObjcSelector('playWithSong:').sort()).toEqual(
      ['play', 'playWithSong'].sort()
    );
  });

  it('Cocoa-style "objectForKey:" → includes "object"', () => {
    expect(swiftBaseNamesForObjcSelector('objectForKey:')).toContain('object');
  });

  it('Cocoa-style "stringWithFormat:" → includes "string"', () => {
    expect(swiftBaseNamesForObjcSelector('stringWithFormat:')).toContain('string');
  });

  it('Cocoa-style "imageNamed:inBundle:" → first keyword has no preposition, falls through', () => {
    // First keyword is `imageNamed` — no With/For/By in it, so candidates is
    // just the raw keyword. (`Named` is not in our preposition list — keep
    // it that way, otherwise we over-match on perfectly normal verbs.)
    expect(swiftBaseNamesForObjcSelector('imageNamed:inBundle:')).toEqual(['imageNamed']);
  });

  it('"play:by:" → ["play"]', () => {
    expect(swiftBaseNamesForObjcSelector('play:by:')).toEqual(['play']);
  });

  it('"playWithSong:by:" → ["playWithSong", "play"]', () => {
    expect(swiftBaseNamesForObjcSelector('playWithSong:by:').sort()).toEqual(
      ['play', 'playWithSong'].sort()
    );
  });

  it('"initWithName:" → includes "init"', () => {
    expect(swiftBaseNamesForObjcSelector('initWithName:')).toContain('init');
  });

  it('"initWithName:age:" → includes "init"', () => {
    expect(swiftBaseNamesForObjcSelector('initWithName:age:')).toContain('init');
  });

  it('"setName:" → includes the property name "name"', () => {
    expect(swiftBaseNamesForObjcSelector('setName:')).toContain('name');
  });

  it('"tableView:didSelectRowAtIndexPath:" → ["tableView"]', () => {
    expect(
      swiftBaseNamesForObjcSelector('tableView:didSelectRowAtIndexPath:')
    ).toEqual(['tableView']);
  });
});

describe('Source-window attribute detection', () => {
  it('detects literal @objc(custom)', () => {
    expect(detectExplicitObjcName('  @objc(custom:)\n  func foo() {}')).toBe(
      'custom:'
    );
  });

  it('returns null for plain @objc', () => {
    expect(detectExplicitObjcName('@objc func foo() {}')).toBeNull();
  });

  it('returns null when no @objc at all', () => {
    expect(detectExplicitObjcName('public func foo() {}')).toBeNull();
  });

  it('isObjcExposed true for @objc', () => {
    expect(isObjcExposed('@objc func foo() {}')).toBe(true);
  });

  it('isObjcExposed true for @objc(custom)', () => {
    expect(isObjcExposed('@objc(custom:) func foo() {}')).toBe(true);
  });

  it('isObjcExposed false for no annotation', () => {
    expect(isObjcExposed('public func foo() {}')).toBe(false);
  });

  it('@nonobjc opts out even if @objc also present (e.g. inside @objcMembers class)', () => {
    expect(isObjcExposed('@nonobjc @objc func foo() {}')).toBe(false);
  });
});
