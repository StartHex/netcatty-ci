import assert from 'node:assert/strict';
import test from 'node:test';

import { ON_HOST_MAX_LOGIN_STEPS, sanitizeDatabaseConnection } from '../models/database.ts';
import {
  EMPTY_ON_HOST_FORM,
  addOnHostLoginStep,
  onHostFormFromSettings,
  onHostFormProblem,
  onHostSettingsFromForm,
  removeOnHostLoginStep,
  updateOnHostLoginStep,
  type OnHostFormValue,
} from './onHostForm.ts';

const form = (patch: Partial<OnHostFormValue> = {}): OnHostFormValue => ({
  ...EMPTY_ON_HOST_FORM,
  loginSteps: [],
  ...patch,
});

test('a new form asks for nothing but the host: db.cfg, default entry, no steps', () => {
  assert.deepEqual(onHostFormFromSettings(undefined), form());
  assert.deepEqual(onHostSettingsFromForm(form()), {
    mode: 'config',
    dbType: 'dmdb',
    server: '',
    envCommand: '',
    python: '',
  });
});

test('saved settings come back into the form as they were typed', () => {
  const settings = {
    mode: 'direct' as const,
    dbType: 'imdb' as const,
    server: '192.0.2.20:9500',
    envCommand: '. ~/.bash_profile',
    python: '/usr/bin/python3',
    loginSteps: [
      { expect: 'Enter IP', send: '192.0.2.14' },
      { expect: '/select.*account/i', send: '2', timeoutMs: 60000 },
    ],
  };
  const restored = onHostFormFromSettings(settings);
  assert.equal(restored.mode, 'direct');
  assert.equal(restored.dbNo, '');
  assert.deepEqual(restored.loginSteps, settings.loginSteps);
  assert.notEqual(restored.loginSteps[0], settings.loginSteps[0], 'rows are copies, not the saved objects');
  // A step's own timeout is not in the form, and must survive an edit.
  assert.deepEqual(onHostSettingsFromForm(restored), settings);
});

test('the entry number is kept only when it is one', () => {
  assert.equal(onHostSettingsFromForm(form({ dbNo: '3' })).dbNo, 3);
  assert.equal('dbNo' in onHostSettingsFromForm(form({ dbNo: '' })), false);
  assert.equal('dbNo' in onHostSettingsFromForm(form({ dbNo: '0' })), false);
  assert.equal('dbNo' in onHostSettingsFromForm(form({ dbNo: 'abc' })), false);
  assert.equal(onHostFormFromSettings({ mode: 'config', dbNo: 2 }).dbNo, '2');
});

test('rows nothing was typed into are not saved; what to wait for is trimmed', () => {
  const settings = onHostSettingsFromForm(form({
    loginSteps: [
      { expect: '  Enter IP  ', send: '192.0.2.14' },
      { expect: '', send: '' },
      { expect: 'Press Enter', send: '' },
    ],
  }));
  assert.deepEqual(settings.loginSteps, [
    { expect: 'Enter IP', send: '192.0.2.14' },
    { expect: 'Press Enter', send: '' },
  ]);
});

test('what is typed is sent as typed: no trimming of the answer', () => {
  const settings = onHostSettingsFromForm(form({ loginSteps: [{ expect: 'Opt>', send: ' 1 ' }] }));
  assert.equal(settings.loginSteps?.[0].send, ' 1 ');
});

test('the form says what is missing, most basic first', () => {
  const ready = { sshHostId: 'host-1', username: '', form: form() };
  assert.equal(onHostFormProblem(ready), null, 'db.cfg mode needs only the host');
  assert.equal(onHostFormProblem({ ...ready, sshHostId: '' }), 'host');

  const direct = form({ mode: 'direct', server: '192.0.2.20:9500' });
  assert.equal(onHostFormProblem({ sshHostId: 'host-1', username: '', form: direct }), 'direct');
  assert.equal(onHostFormProblem({ sshHostId: 'host-1', username: 'app', form: direct }), null);
  assert.equal(
    onHostFormProblem({ sshHostId: 'host-1', username: 'app', form: { ...direct, server: '  ' } }),
    'direct',
  );
  assert.equal(
    onHostFormProblem({ sshHostId: '', username: '', form: direct }),
    'host',
    'the host comes before everything else',
  );
});

test('a row that types something must say what it waits for', () => {
  const base = { sshHostId: 'host-1', username: '' };
  assert.equal(
    onHostFormProblem({ ...base, form: form({ loginSteps: [{ expect: '', send: '192.0.2.14' }] }) }),
    'step',
  );
  assert.equal(
    onHostFormProblem({ ...base, form: form({ loginSteps: [{ expect: '   ', send: '1' }] }) }),
    'step',
  );
  assert.equal(
    onHostFormProblem({ ...base, form: form({ loginSteps: [{ expect: '', send: '' }] }) }),
    null,
    'an untouched row is just an empty row',
  );
  assert.equal(
    onHostFormProblem({ ...base, form: form({ loginSteps: [{ expect: 'Press Enter', send: '' }] }) }),
    null,
    'waiting and then pressing Enter is a step',
  );
});

test('the interpreter path must be one plain word for the shell', () => {
  const base = { sshHostId: 'host-1', username: '' };
  for (const python of ['python3', '/usr/bin/python2.7', '/opt/py-3.6/bin/python3', '  python3  ']) {
    assert.equal(onHostFormProblem({ ...base, form: form({ python }) }), null, python);
  }
  for (const python of ['python3 -E', '$(id)', 'py;id', '~/bin/python', '"python3"', "py'thon"]) {
    assert.equal(onHostFormProblem({ ...base, form: form({ python }) }), 'python', python);
  }
});

test('rows are added, edited and removed without touching the others', () => {
  const one = addOnHostLoginStep([]);
  assert.deepEqual(one, [{ expect: '', send: '' }]);
  const two = addOnHostLoginStep(updateOnHostLoginStep(one, 0, { expect: 'Enter IP' }));
  const edited = updateOnHostLoginStep(two, 1, { send: '2' });
  assert.deepEqual(edited, [
    { expect: 'Enter IP', send: '' },
    { expect: '', send: '2' },
  ]);
  assert.equal(edited[0], two[0], 'the untouched row is the same object');
  assert.deepEqual(removeOnHostLoginStep(edited, 0), [{ expect: '', send: '2' }]);
  assert.deepEqual(updateOnHostLoginStep(edited, 7, { send: 'x' }), edited, 'no such row: nothing changes');
});

test('no more rows than a login can have', () => {
  let steps = addOnHostLoginStep([]);
  for (let count = 0; count < ON_HOST_MAX_LOGIN_STEPS + 5; count += 1) steps = addOnHostLoginStep(steps);
  assert.equal(steps.length, ON_HOST_MAX_LOGIN_STEPS);
});

test('the form survives the connection sanitizer: what is saved is what was meant', () => {
  const saved = sanitizeDatabaseConnection({
    id: 'db-1',
    label: 'Billing on host',
    kind: 'onhost',
    sshHostId: 'host-1',
    onHost: onHostSettingsFromForm(form({
      mode: 'config',
      dbNo: '2',
      // Left over from trying direct mode: db.cfg mode has no use for them.
      server: '192.0.2.20:9500',
      envCommand: '  . ~/.bash_profile ',
      loginSteps: [
        { expect: 'Enter IP', send: '192.0.2.14' },
        { expect: '', send: '' },
      ],
    })),
  });
  assert.deepEqual(saved.onHost, {
    mode: 'config',
    dbNo: 2,
    envCommand: '. ~/.bash_profile',
    loginSteps: [{ expect: 'Enter IP', send: '192.0.2.14' }],
  });
  assert.deepEqual(onHostFormFromSettings(saved.onHost), form({
    dbNo: '2',
    envCommand: '. ~/.bash_profile',
    loginSteps: [{ expect: 'Enter IP', send: '192.0.2.14' }],
  }));
});
