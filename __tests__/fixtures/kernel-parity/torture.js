/**
 * JS-grammar torture fixture (javascript variant: no type machinery, JS class
 * fields use `field_definition` with a `property` field).
 */
import { EventEmitter } from 'node:events';
const { promisify } = require('node:util');

/** Legacy prototype-style helper. */
function legacyHelper(a, b) {
  return a + b;
}

const arrow = (x) => legacyHelper(x, 1);

class Widget extends EventEmitter {
  static registry = new Map();
  #privateField = 1;
  label = 'w';
  onTick = () => {
    this.render();
  };
  wrapped = debounce(function () {
    expensive();
  }, 50);

  constructor(opts) {
    super();
    this.opts = opts;
    register(this.onTick);
  }

  render() {
    paint(this.label);
  }

  static create(opts) {
    return new Widget(opts);
  }
}

// AMD-style wrapper — anonymous, but inner functions must still surface.
(function () {
  function hiddenInner() {
    return 7;
  }
  hiddenInner();
})();

module.exports.makeWidget = function makeWidget(opts) {
  return Widget.create(opts);
};

// Vuex module shape (store-file signals: mutations + actions + getters).
const mutations = {
  SET_USER(state, user) {
    state.user = user;
  },
};
const actions = {
  async loadUser({ commit }, id) {
    const user = await fetchUser(id);
    commit('SET_USER', user);
  },
};
export default {
  namespaced: true,
  state: () => ({ user: null }),
  mutations,
  actions,
  getters: {
    userName(state) {
      return state.user?.name;
    },
  },
};
