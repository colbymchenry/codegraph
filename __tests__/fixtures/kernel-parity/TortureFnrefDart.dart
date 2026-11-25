void assigned() {}
void listed() {}
void mapped() {}
void selfStore() {}
class H {
  var cb;
  void wire(dynamic selfStore) {
    this.cb = assigned;
    cb = selfStore;
  }
}
final tableTop = [listed];
final mapTop = {'k': mapped};
void aliased() {}
final aliasTop = aliased;
class K {
  static final aliasStatic = aliased;
}
void onlyNamed() {}
void otherFn() {}
void positional() {}
void taker() {
  reg(cb: onlyNamed);
  reg2(handler: otherFn, plain: 1);
  reg3(positional);
}
