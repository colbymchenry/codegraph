import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';

describe('Kotlin calls through explicit imports', () => {
  it('uses the imported type, while retaining values, extensions and nested constructors', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-kotlin-import-'));
    let cg: CodeGraph | undefined;
    try {
      for (const [file, source] of Object.entries({
        'p/Outer.java': `package p;
public class Outer { public static class Inner { public Inner() {} } }`,
        'p/Factories.kt': `package p
object Factory { fun create(): Int = 2 }
class ExtFactory { companion object }
open class Base { fun hello() {} }
object Obj : Base()
object Modes
object Dimensions { val Height = 2 }
fun Int.toPx(): Int = this
class UnrelatedFactory { fun create(): Int = 1 }`,
        'p/Ext.kt': `package p
import androidx.compose.ui.Modifier
fun ExtFactory.Companion.extMake() {}
fun Modes.extOther() {}
fun Modes.hidden() {}
fun Modifier.pad() {}`,
        'q/Calls.kt': `package q
import android.app.TaskStackBuilder // external type
import androidx.savedstate.SavedStateRegistryController
import p.Factory as LocalFactory
import p.Factory
import p.ExtFactory // trailing comment
import p.Obj
import p.Modes
import p.extMake
import p.extOther
import p.pad
import androidx.compose.ui.Modifier
import p.Dimensions.Height
import p.toPx
import p.Outer
fun Modes.ext() {}
class Calls {
    fun android() { TaskStackBuilder.create(null) }
    fun androidx() { SavedStateRegistryController.create(this) }
    fun aliased() { LocalFactory.create() }
    fun direct() { Factory.create() }
    fun extension() { Modes.ext() }
    fun value() { Height.toPx() }
    fun nested() { Outer.Inner() }
    fun companionExtension() { ExtFactory.extMake() }
    fun inherited() { Obj.hello() }
    fun externalExtension() { Modifier.pad() }
    fun crossFileExtension() { Modes.extOther() }
    fun unimportedExtension() { Modes.hidden() }
}`,
      })) {
        const target = path.join(dir, file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, source);
      }
      cg = CodeGraph.initSync(dir, { config: { include: ['**/*.kt', '**/*.java'], exclude: [] } });
      await cg.indexAll();
      const callees = (name: string) => {
        const caller = cg!.searchNodes(name).map(r => r.node)
          .find(n => n.qualifiedName === `q::Calls::${name}`)!;
        return cg!.getCallees(caller.id).filter(c => c.edge.kind === 'calls')
          .map(c => c.node.qualifiedName);
      };
      expect(callees('android')).toEqual([]);
      expect(callees('androidx')).toEqual([]);
      expect(callees('aliased')).toEqual(['p::Factory::create']);
      expect(callees('direct')).toEqual(['p::Factory::create']);
      expect(callees('extension')).toEqual(['Modes::ext']);
      expect(callees('value')).toEqual(['Int::toPx']);
      expect(callees('nested')).toEqual(['p::Outer::Inner::Inner']);
      expect(callees('companionExtension')).toEqual(['ExtFactory::extMake']);
      expect(callees('inherited')).toEqual(['p::Base::hello']);
      expect(callees('externalExtension')).toEqual(['Modifier::pad']);
      expect(callees('crossFileExtension')).toEqual(['Modes::extOther']);
      expect(callees('unimportedExtension')).toEqual([]);
    } finally {
      cg?.destroy();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
