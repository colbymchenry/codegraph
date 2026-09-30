/**
 * A Rails routes file is read with its blocks: `namespace :admin` prefixes
 * paths and controllers, `scope` its path and module, a `resources … do`
 * block nests children under `/:parent_id`, and `member` / `collection`
 * blocks add actions. A Rails engine's routes (`Spree::Core::Engine.routes.draw`
 * in `backend/config/routes.rb`) count too — solidus had no routes at all —
 * and a namespaced route reaches its own module's controller.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rails-scoped-'));
  const files: Record<string, string> = {
    'Gemfile': 'source "https://rubygems.org"\ngem "rails", "~> 7.1"\n',
    'backend/config/routes.rb': `Spree::Core::Engine.routes.draw do
  namespace :admin do
    get "/search/users", to: "search#users", as: :search_users
    resources :zones, only: [
      :index,
      :show
    ]
    resources :products do
      resources :images
      member do
        get :preview
      end
      collection do
        post :update_positions
      end
    end
  end
  scope "/v2", module: "api" do
    resource :account, only: [:show]
  end
  root to: "home#index"
end
`,
    'backend/app/controllers/spree/admin/zones_controller.rb': `module Spree
  module Admin
    class ZonesController < ResourceController
      def show; end
    end
  end
end
`,
    'api/app/controllers/spree/api/zones_controller.rb': `module Spree
  module Api
    class ZonesController < BaseController
      def index; end
      def show; end
    end
  end
end
`,
    'backend/app/controllers/spree/admin/products_controller.rb': `module Spree
  module Admin
    class ProductsController < ResourceController
      def preview; end
      def update_positions; end
    end
  end
end
`,
  };
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  cg = await CodeGraph.init(root, { index: true });
});

afterAll(() => {
  cg?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

const handlerOf = (name: string): string | undefined => {
  const route = cg.getNodesByKind('route').find((r) => r.name === name);
  if (!route) return undefined;
  const target = cg.getOutgoingEdges(route.id).find((e) => e.kind === 'references');
  return target ? cg.getNode(target.target)!.filePath : '';
};

describe('Rails routes with their nesting', () => {
  it('prefixes namespaces and scopes, nests resources, adds member and collection actions', () => {
    const names = cg.getNodesByKind('route').map((r) => r.name).sort();
    expect(names).toEqual(expect.arrayContaining([
      'GET /admin/search/users',
      'GET /admin/zones', 'GET /admin/zones/:id',
      'GET /admin/products/:product_id/images',
      'GET /admin/products/:id/preview',
      'POST /admin/products/update_positions',
      'GET /v2/account',
      'GET /',
    ]));
    // `only:` written across lines still limits the actions.
    expect(names).not.toContain('DELETE /admin/zones/:id');
  });

  it('reaches the controller of the route’s own module, not another module’s namesake', () => {
    expect(handlerOf('GET /admin/zones/:id')).toBe('backend/app/controllers/spree/admin/zones_controller.rb');
    // The admin controller inherits `index`; the API's `index` is not it.
    expect(handlerOf('GET /admin/zones')).toBe('');
    expect(handlerOf('GET /admin/products/:id/preview')).toBe('backend/app/controllers/spree/admin/products_controller.rb');
  });
});
