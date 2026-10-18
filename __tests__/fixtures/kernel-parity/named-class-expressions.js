class ElementBase { connectedCallback() { return 1; } }
function helper() { return 2; }
function register(Type) { return Type; }
register(class Widget extends ElementBase {
  connectedCallback() { return helper(); }
  clone() { return new Widget(); }
});
export const Registered = class Named extends ElementBase { run() { return helper(); } };
function make() { return class Local extends ElementBase { run() { return helper(); } }; }
register(class { run() { helper(); } });
