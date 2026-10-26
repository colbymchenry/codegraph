/**
 * A `resources` line's `only:` / `except:` is read however Rails lets it be
 * written. maybe's `resources :family_exports, only: %i[new create index]` was
 * not read, so it drew all seven RESTful routes — four of them to actions the
 * controller does not have, which the viewer listed as routes bound to nothing.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rails-only-'));
  const files: Record<string, string> = {
    'Gemfile': 'source "https://rubygems.org"\ngem "rails", "~> 7.1"\n',
    'config/routes.rb': `Rails.application.routes.draw do
  resources :family_exports, only: %i[new create index] do
    member do
      get :download
    end
  end
  resources :tags, except: %w(destroy edit update)
  resources :imports, :only => [:index, :show]
  resource :session, only: "show"
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

const routes = (controller: string) =>
  cg.getNodesByKind('route').map((r) => r.qualifiedName).filter((q) => q.includes(`${controller}#`)).map((q) => q.slice(q.lastIndexOf('#') + 1)).sort();

describe('Rails resources only: / except:', () => {
  it('reads %i[] and %w() lists', () => {
    expect(routes('family_exports')).toEqual(['create', 'download', 'index', 'new']);
    expect(routes('tags')).toEqual(['create', 'index', 'new', 'show']);
  });

  it('reads the hash-rocket and string forms', () => {
    expect(routes('imports')).toEqual(['index', 'show']);
    expect(routes('sessions')).toEqual(['show']);
  });
});
