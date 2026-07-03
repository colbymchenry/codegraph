/**
 * Framework Resolver Registry
 *
 * Manages framework-specific resolvers.
 */

import { FrameworkResolver, ResolutionContext } from '../types';
import type { Language } from '../../types';
import { drupalResolver } from './drupal';
import { laravelResolver } from './laravel';
import { expressResolver } from './express';
import { nestjsResolver } from './nestjs';
import { reactResolver } from './react';
import { svelteResolver } from './svelte';
import { vueResolver } from './vue';
import { astroResolver } from './astro';
import { djangoResolver, flaskResolver, fastapiResolver } from './python';
import { railsResolver } from './ruby';
import { springResolver } from './java';
import { playResolver } from './play';
import { goResolver } from './go';
import { goframeResolver } from './goframe';
import { rustResolver } from './rust';
import { aspnetResolver } from './csharp';
import { swiftUIResolver, uikitResolver, vaporResolver } from './swift';
import { swiftObjcBridgeResolver } from './swift-objc';
import { reactNativeBridgeResolver } from './react-native';
import { expoModulesResolver } from './expo-modules';
import { fabricViewResolver } from './fabric';
import { cicsResolver } from './cics';

/**
 * All registered framework resolvers
 */
const FRAMEWORK_RESOLVERS: FrameworkResolver[] = [
  // PHP
  laravelResolver,
  drupalResolver,
  // JavaScript/TypeScript
  expressResolver,
  nestjsResolver,
  reactResolver,
  svelteResolver,
  vueResolver,
  astroResolver,
  // Python
  djangoResolver,
  flaskResolver,
  fastapiResolver,
  // Ruby
  railsResolver,
  // Java
  springResolver,
  playResolver,
  // Go
  goResolver,
  goframeResolver,
  // Rust
  rustResolver,
  // C#
  aspnetResolver,
  // Swift
  swiftUIResolver,
  uikitResolver,
  vaporResolver,
  // Swift ↔ Objective-C cross-language bridging (mixed iOS apps)
  swiftObjcBridgeResolver,
  // React Native JS ↔ native bridge (legacy + TurboModules)
  reactNativeBridgeResolver,
  // Expo Modules — Function/AsyncFunction/Property DSL on Swift/Kotlin
  expoModulesResolver,
  // React Native Fabric / Codegen view components — TS spec → component nodes
  fabricViewResolver,
  // CICS pseudo-conversational TRANSID hops (COBOL)
  cicsResolver,
];

/**
 * Get all framework resolvers
 */
export function getAllFrameworkResolvers(): FrameworkResolver[] {
  return FRAMEWORK_RESOLVERS;
}

/**
 * Get a resolver by name
 */
export function getFrameworkResolver(name: string): FrameworkResolver | undefined {
  return FRAMEWORK_RESOLVERS.find((r) => r.name === name);
}

/**
 * Detect which frameworks are used in a project
 */
export function detectFrameworks(context: ResolutionContext): FrameworkResolver[] {
  return FRAMEWORK_RESOLVERS.filter((resolver) => {
    try {
      return resolver.detect(context);
    } catch {
      return false;
    }
  });
}

/**
 * Filter a list of detected frameworks down to ones that apply to a given language.
 * Frameworks without an explicit `languages` list are treated as universal.
 */
export function getApplicableFrameworks(
  detected: FrameworkResolver[],
  language: Language
): FrameworkResolver[] {
  return detected.filter(
    (fw) => !fw.languages || fw.languages.includes(language)
  );
}

/**
 * Register a custom framework resolver
 */
export function registerFrameworkResolver(resolver: FrameworkResolver): void {
  // Remove existing resolver with same name
  const index = FRAMEWORK_RESOLVERS.findIndex((r) => r.name === resolver.name);
  if (index !== -1) {
    FRAMEWORK_RESOLVERS.splice(index, 1);
  }
  FRAMEWORK_RESOLVERS.push(resolver);
}

// Re-export framework resolvers
export { drupalResolver } from './drupal';
export { laravelResolver, FACADE_MAPPINGS } from './laravel';
export { expressResolver } from './express';
export { nestjsResolver } from './nestjs';
export { reactResolver } from './react';
export { svelteResolver } from './svelte';
export { vueResolver } from './vue';
export { astroResolver } from './astro';
export { djangoResolver, flaskResolver, fastapiResolver } from './python';
export { railsResolver } from './ruby';
export { springResolver } from './java';
export { playResolver } from './play';
export { goResolver } from './go';
export { goframeResolver } from './goframe';
export { rustResolver } from './rust';
export { aspnetResolver } from './csharp';
export { swiftUIResolver, uikitResolver, vaporResolver } from './swift';
export { swiftObjcBridgeResolver } from './swift-objc';
export { reactNativeBridgeResolver } from './react-native';
export { expoModulesResolver } from './expo-modules';
export { fabricViewResolver } from './fabric';
