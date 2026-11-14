import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import React from 'react';
import { JSDOM } from 'jsdom';

import {
  EMPTY_ON_HOST_FORM,
  onHostFormProblem,
  type OnHostFormValue,
} from '../../domain/database/onHostForm.ts';

// ---------------------------------------------------------------------------
// A browser to render into. Installed before React DOM and the component are
// imported: both look for `window` when they load.
// ---------------------------------------------------------------------------

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost',
  pretendToBeVisual: true,
});
const install = (key: string, value: unknown) => {
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
};
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
install('window', dom.window);
for (const key of [
  'document',
  'navigator',
  'localStorage',
  'HTMLElement',
  'HTMLInputElement',
  'HTMLButtonElement',
  'Element',
  'Node',
  'DocumentFragment',
  'MutationObserver',
  'Event',
  'CustomEvent',
  'MouseEvent',
  'KeyboardEvent',
  'FocusEvent',
  'PointerEvent',
]) {
  install(key, dom.window[key as keyof typeof dom.window]);
}
install('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
install('requestAnimationFrame', dom.window.requestAnimationFrame.bind(dom.window));
install('cancelAnimationFrame', dom.window.cancelAnimationFrame.bind(dom.window));
install('ResizeObserver', ResizeObserverStub);
install('IS_REACT_ACT_ENVIRONMENT', true);

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('../../application/i18n/I18nProvider.tsx');
const { OnHostConnectionFields } = await import('./OnHostConnectionFields.tsx');

after(() => dom.window.close());

const HOSTS = [{ id: 'host-1', label: 'Billing app host' }];

interface MountOptions {
  form?: Partial<OnHostFormValue>;
  hostId?: string;
  hosts?: { id: string; label: string }[];
  username?: string;
  /** The user pressed Save or Test once: problems are shown from then on. */
  triedToSave?: boolean;
}

/** Renders the fields with the state the connection dialog keeps for them. */
async function mount(options: MountOptions = {}) {
  const container = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  const state = {
    form: { ...EMPTY_ON_HOST_FORM, loginSteps: [], ...options.form } as OnHostFormValue,
    hostId: options.hostId ?? '',
  };
  const Harness = () => {
    const [form, setForm] = React.useState(state.form);
    const [hostId, setHostId] = React.useState(state.hostId);
    state.form = form;
    state.hostId = hostId;
    return (
      <I18nProvider locale="en">
        <OnHostConnectionFields
          value={form}
          sshHostId={hostId}
          sshHosts={options.hosts ?? HOSTS}
          problem={onHostFormProblem({ sshHostId: hostId, username: options.username ?? '', form })}
          showError={options.triedToSave === true}
          onChange={(patch) => setForm((prev) => ({ ...prev, ...patch }))}
          onHostChange={setHostId}
        />
      </I18nProvider>
    );
  };
  await act(async () => {
    root.render(<Harness />);
  });

  const input = (selector: string) => container.querySelector<HTMLInputElement>(selector);
  return {
    state,
    text: () => container.textContent ?? '',
    // Lookups answer yes or no: an element itself is never handed to an
    // assertion, whose failure message would print the whole page behind it.
    has: (selector: string) => container.querySelector(selector) !== null,
    input,
    labelled: (label: string) => input(`input[aria-label="${label}"]`),
    button: (label: string) =>
      [...container.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.includes(label)),
    removeButtons: () => [...container.querySelectorAll<HTMLButtonElement>('button[aria-label="Remove step"]')],
    async type(element: HTMLInputElement | null, value: string) {
      assert.equal(element !== null, true, 'the field to type into is on the page');
      await act(async () => {
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(element, value);
        element!.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      });
    },
    async click(element: HTMLElement | undefined) {
      assert.equal(element !== undefined, true, 'the button to click is on the page');
      await act(async () => {
        element!.click();
      });
    },
    async unmount() {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

test('a new on-host connection asks where it runs and which db.cfg entry to use', async () => {
  const page = await mount();
  try {
    assert.match(page.text(), /The connection is made from the SSH host itself/);
    assert.equal(page.has('#db-onhost-host'), true, 'the SSH host is asked for');
    assert.match(page.text(), /Choose a host/);
    assert.equal(page.has('#db-onhost-dbno'), true, 'db.cfg mode asks for the entry number');
    assert.equal(page.has('#db-onhost-server'), false, 'and not for a server');
    assert.equal(page.has('#db-onhost-env'), true);
    assert.equal(page.has('#db-onhost-python'), true);
    // Nothing is reported before the user has tried to save.
    assert.doesNotMatch(page.text(), /Choose the SSH host this connection runs on/);
    assert.doesNotMatch(page.text(), /saved as plain text/, 'no warning about steps while there are none');
  } finally {
    await page.unmount();
  }
});

test('a missing host is reported once the user tried to save', async () => {
  const page = await mount({ triedToSave: true });
  try {
    assert.match(page.text(), /Choose the SSH host this connection runs on/);
  } finally {
    await page.unmount();
  }
});

test('without any SSH host the form says where to add one', async () => {
  const page = await mount({ hosts: [], triedToSave: true });
  try {
    assert.match(page.text(), /There is no SSH host yet/);
  } finally {
    await page.unmount();
  }
});

test('direct mode asks for the type and the server instead of an entry number', async () => {
  const page = await mount({ form: { mode: 'direct' }, hostId: 'host-1', triedToSave: true });
  try {
    assert.equal(page.has('#db-onhost-server'), true);
    assert.equal(page.has('#db-onhost-type'), true);
    assert.equal(page.has('#db-onhost-dbno'), false);
    assert.match(page.text(), /Direct mode needs a server and a user name/);

    await page.type(page.input('#db-onhost-server'), '192.0.2.20:9500');
    assert.equal(page.state.form.server, '192.0.2.20:9500');
    // The user name lives in the dialog's own account fields: still missing.
    assert.match(page.text(), /Direct mode needs a server and a user name/);
  } finally {
    await page.unmount();
  }
});

test('direct mode with a server and a user name has nothing to report', async () => {
  const page = await mount({
    form: { mode: 'direct', server: '192.0.2.20:9500' },
    hostId: 'host-1',
    username: 'app',
    triedToSave: true,
  });
  try {
    assert.doesNotMatch(page.text(), /Direct mode needs a server and a user name/);
  } finally {
    await page.unmount();
  }
});

test('the entry number takes two digits and nothing else', async () => {
  const page = await mount({ hostId: 'host-1' });
  try {
    await page.type(page.input('#db-onhost-dbno'), 'a1b23');
    assert.equal(page.state.form.dbNo, '12');
    assert.equal(page.input('#db-onhost-dbno')?.value, '12');
  } finally {
    await page.unmount();
  }
});

test('steps before the shell are added, filled in and removed', async () => {
  const page = await mount({ hostId: 'host-1' });
  try {
    assert.equal(page.labelled('Wait for 1') === null, true, 'no rows to begin with');

    await page.click(page.button('Add step'));
    assert.deepEqual(page.state.form.loginSteps, [{ expect: '', send: '' }]);
    assert.match(page.text(), /saved as plain text/, 'the warning comes with the first row');

    await page.type(page.labelled('Wait for 1'), 'Enter IP');
    await page.type(page.labelled('Then type 1'), '192.0.2.14');
    await page.click(page.button('Add step'));
    await page.type(page.labelled('Wait for 2'), 'Select account');
    await page.type(page.labelled('Then type 2'), '1');
    assert.deepEqual(page.state.form.loginSteps, [
      { expect: 'Enter IP', send: '192.0.2.14' },
      { expect: 'Select account', send: '1' },
    ]);
    assert.equal(page.labelled('Wait for 2')?.value, 'Select account');

    // Removing the first row leaves the second one, now first, as it was.
    await page.click(page.removeButtons()[0]);
    assert.deepEqual(page.state.form.loginSteps, [{ expect: 'Select account', send: '1' }]);
    assert.equal(page.labelled('Wait for 1')?.value, 'Select account');
    assert.equal(page.labelled('Wait for 2') === null, true);

    await page.click(page.removeButtons()[0]);
    assert.deepEqual(page.state.form.loginSteps, []);
    assert.doesNotMatch(page.text(), /saved as plain text/);
  } finally {
    await page.unmount();
  }
});

test('a step that types without saying what it waits for is reported', async () => {
  const page = await mount({
    form: { loginSteps: [{ expect: '', send: '192.0.2.14' }] },
    hostId: 'host-1',
    triedToSave: true,
  });
  try {
    assert.match(page.text(), /A step that types something needs the text to wait for/);
    await page.type(page.labelled('Wait for 1'), 'Enter IP');
    assert.doesNotMatch(page.text(), /A step that types something needs the text to wait for/);
  } finally {
    await page.unmount();
  }
});

test('no more steps can be added than a login may have', async () => {
  const full = Array.from({ length: 12 }, (_unused, index) => ({ expect: `prompt ${index + 1}`, send: 'x' }));
  const page = await mount({ form: { loginSteps: full }, hostId: 'host-1' });
  try {
    assert.equal(page.button('Add step')?.disabled, true);
    await page.click(page.removeButtons()[11]);
    assert.equal(page.button('Add step')?.disabled, false);
  } finally {
    await page.unmount();
  }
});

test('an interpreter path the shell would not take as one word is reported', async () => {
  const page = await mount({ form: { python: 'python3 -E' }, hostId: 'host-1', triedToSave: true });
  try {
    assert.match(page.text(), /The Python path may only contain letters, digits and/);
    await page.type(page.input('#db-onhost-python'), '/usr/bin/python3');
    assert.doesNotMatch(page.text(), /The Python path may only contain letters, digits and/);
    assert.equal(page.state.form.python, '/usr/bin/python3');
  } finally {
    await page.unmount();
  }
});
