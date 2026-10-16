import { describe, expect, it } from 'vitest';
import { LiquidExtractor } from '../src/extraction/liquid-extractor';

const extract = (source: string, file = 'plain/template.liquid') => new LiquidExtractor(file, source).extract();
describe('standard Liquid capture declarations', () => {
  it.each([
    ['{% capture title %}Hello{% endcapture %}', 'title'],
    ['{%- capture title -%}Hello{%- endcapture -%}', 'title'],
    ['{% capture title_text %}Hello{% endcapture %}', 'title_text'],
    ['{% capture title-text %}Hello{% endcapture %}', 'title-text'],
    ["{% capture 'title' %}Hello{% endcapture %}", 'title'],
    ['{% capture "title" %}Hello{% endcapture %}', 'title'],
    ['{% capture title-%}Hello{% endcapture %}', 'title'],
    ['{% capture title extra %}Hello{% endcapture %}', 'title'],
    ['{% liquid\n capture "title"\n endcapture\n%}', 'title'],
    ['{% liquid\n capture title extra\n endcapture\n%}', 'title'],
    ['{% liquid\n  capture title\n    echo "Hello"\n  endcapture\n%}', 'title'],
    ['{% liquid\r\n  capture title\r\n    echo "Hello"\r\n  endcapture\r\n%}', 'title'],
    ['{% liquid\n  capture title # a declaration\n    echo "Hello"\n  endcapture\n%}', 'title'],
  ])('indexes a variable and file containment: %s', (source, name) => {
    const result = extract(source);
    const variable = result.nodes.find(n => n.kind === 'variable');
    expect(variable?.name).toBe(name);
    expect(result.edges).toContainEqual(expect.objectContaining({ target: variable!.id, kind: 'contains' }));
    expect(result.errors).toEqual([]);
  });

  it.each(['plain/template.liquid', '_includes/card.liquid', 'sections/card.liquid'])('does not require Shopify directories: %s', file => {
    expect(extract('{% capture title %}Hello{% endcapture %}', file).nodes.some(n => n.name === 'title')).toBe(true);
  });

  it.each([
    '{% comment %}{% capture fake %}x{% endcapture %}{% endcomment %}',
    '{% raw %}{% capture fake %}x{% endcapture %}{% endraw %}',
    '{% # capture fake %}',
    '{% liquid\n # capture fake\n%}',
    '{% liquid\n comment\n capture fake\n endcapture\n endcomment\n%}',
    '{% liquid\n raw\n capture fake\n endcapture\n endraw\n%}',
    '{% capture %}x{% endcapture %}',
    '{% liquid\n capture\n%}',
    "{% capture 'fake\" %}x{% endcapture %}",
    '{% capture fake.extra %}x{% endcapture %}',
    '{% assign text = "capture fake" %}',
  ])('ignores non-executing or invalid declarations: %s', source => {
    expect(extract(source).nodes.some(n => n.name === 'fake')).toBe(false);
  });

  it('retains declaration order, positions and identity on one Unicode line', () => {
    const source = 'é😀 {% assign title = 1 %}{% capture title %}one{% endcapture %}{% capture title %}two{% endcapture %}';
    const variables = extract(source).nodes.filter(n => n.kind === 'variable');
    expect(variables).toHaveLength(3);
    expect(variables.map(n => n.startColumn)).toEqual([source.indexOf('{% assign'), source.indexOf('{% capture'), source.lastIndexOf('{% capture')]);
    expect(new Set(variables.map(n => n.id)).size).toBe(3);
  });

  it('retains nested executable assigns and render references', () => {
    const result = extract('{% capture title %}{% assign inner = 1 %}{% render "card" %}{% endcapture %}');
    expect(result.nodes.filter(n => n.kind === 'variable').map(n => n.name)).toEqual(['title', 'inner']);
    expect(result.unresolvedReferences).toContainEqual(expect.objectContaining({ referenceName: 'snippets/card.liquid' }));
  });

  it('does not pretend to extract embedded JavaScript or dynamic targets', () => {
    const result = extract('{% capture title %}<script>function hello() {}</script>{% render target %}{% endcapture %}');
    expect(result.nodes.some(n => n.kind === 'function' || n.name === 'hello')).toBe(false);
    expect(result.unresolvedReferences).toEqual([]);
  });
});
