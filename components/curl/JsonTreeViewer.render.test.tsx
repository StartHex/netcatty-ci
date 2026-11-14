import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const { JsonTreeViewer } = await import('./JsonTreeViewer.tsx');

test('expands nested nodes by default', () => {
  const markup = renderToStaticMarkup(
    React.createElement(JsonTreeViewer, {
      text: JSON.stringify({ id: 7, name: 'demo', nested: { deep: { value: 1 } } }),
    }),
  );
  assert.match(markup, /curl-json-tree/);
  assert.match(markup, /id/);
  assert.match(markup, /demo/);
  // Everything is expanded, so the deepest value is rendered.
  assert.match(markup, /value/);
  assert.doesNotMatch(markup, /1 key/);
});

test('falls back to raw text when the body is not valid JSON', () => {
  const markup = renderToStaticMarkup(React.createElement(JsonTreeViewer, { text: '<html>nope</html>' }));
  assert.match(markup, /curl-json-raw/);
  assert.match(markup, /&lt;html&gt;nope&lt;\/html&gt;/);
});

test('renders array items when expanded', () => {
  const markup = renderToStaticMarkup(
    React.createElement(JsonTreeViewer, { text: JSON.stringify({ outer: { items: [1, 2, 3] } }) }),
  );
  assert.match(markup, /items/);
  assert.doesNotMatch(markup, /3 items/);
});

test('very large payloads still start shallow', () => {
  const big = Object.fromEntries(
    Array.from({ length: 800 }, (_, index) => [`k${index}`, { deep: { value: index } }]),
  );
  const markup = renderToStaticMarkup(React.createElement(JsonTreeViewer, { text: JSON.stringify(big) }));
  // Root and its direct children stay visible, but depth 2 starts collapsed.
  assert.match(markup, /k0/);
  assert.match(markup, /1 key/);
  assert.doesNotMatch(markup, /value/);
});

test('large arrays render one page of children plus a show-more row', () => {
  const markup = renderToStaticMarkup(
    React.createElement(JsonTreeViewer, {
      text: JSON.stringify(Array.from({ length: 450 }, (_, index) => index)),
      labels: { showMore: (remaining: number) => `show ${remaining} more` },
    }),
  );
  assert.match(markup, /curl-json-show-more/);
  assert.match(markup, /show 250 more/);
  assert.match(markup, />199</);
  assert.doesNotMatch(markup, />200</);
});
